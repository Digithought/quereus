/**
 * Unified IndexedDB Virtual Table Module for Quereus.
 *
 * Uses a single IndexedDB database with multiple object stores (one per table).
 * This enables cross-table atomic transactions using native IDB transaction support.
 *
 * Key differences from IndexedDBModule:
 * - Single database for all tables (configurable name, default: 'quereus_unified')
 * - One object store per table (named by schema.table)
 * - Catalog/DDL stored in same database as tables
 * - Native cross-table transactions for atomicity
 * - Sync metadata can be stored alongside data for atomic sync operations
 */

import type { Database, TableSchema, TableIndexSchema, VirtualTableModule, BaseModuleConfig, BestAccessPlanRequest, BestAccessPlanResult, SqlValue } from '@quereus/quereus';
import { AccessPlanBuilder, QuereusError, StatusCode } from '@quereus/quereus';
import { UnifiedIndexedDBManager, UnifiedIndexedDBStore, MultiStoreWriteBatch } from './unified-database.js';
import { IndexedDBTable } from './table.js';
import type { StoreEventEmitter } from '../common/events.js';
import { TransactionCoordinator } from '../common/transaction.js';
import { CrossTabSync } from './broadcast.js';
import { buildMetaKey, buildMetaScanBounds, buildTableScanBounds, buildIndexKey } from '../common/key-builder.js';
import { serializeRow, deserializeRow } from '../common/serialization.js';
import { generateTableDDL } from '../common/ddl-generator.js';
import type { KVStore } from '../common/kv-store.js';

/** Default unified database name. */
const DEFAULT_DATABASE_NAME = 'quereus_unified';

/** Reserved object store for catalog/DDL metadata. */
const CATALOG_STORE_NAME = '__catalog__';

/**
 * Configuration options for unified IndexedDB tables.
 */
export interface UnifiedIndexedDBModuleConfig extends BaseModuleConfig {
  /** Collation for text keys. Default: 'NOCASE'. */
  collation?: 'BINARY' | 'NOCASE';
  /** Enable cross-tab synchronization. Default: true. */
  crossTabSync?: boolean;
}

/**
 * Unified IndexedDB virtual table module.
 *
 * All tables share a single IDB database with separate object stores.
 *
 * Usage:
 *   CREATE TABLE t1 (id INTEGER PRIMARY KEY, name TEXT) USING indexeddb;
 *
 * Note: The 'database' option is ignored - all tables use the unified database.
 */
export class UnifiedIndexedDBModule implements VirtualTableModule<IndexedDBTable, UnifiedIndexedDBModuleConfig> {
  private manager: UnifiedIndexedDBManager;
  private stores: Map<string, UnifiedIndexedDBStore> = new Map();
  private tables: Map<string, IndexedDBTable> = new Map();
  private coordinators: Map<string, TransactionCoordinator> = new Map();
  private crossTabSync: CrossTabSync | null = null;
  private eventEmitter?: StoreEventEmitter;
  private databaseName: string;
  private catalogStore: UnifiedIndexedDBStore | null = null;

  constructor(eventEmitter?: StoreEventEmitter, databaseName: string = DEFAULT_DATABASE_NAME) {
    this.eventEmitter = eventEmitter;
    this.databaseName = databaseName;
    this.manager = UnifiedIndexedDBManager.getInstance(databaseName);
  }

  /**
   * Get the unified database manager.
   * Useful for sync operations that need cross-table transactions.
   */
  getManager(): UnifiedIndexedDBManager {
    return this.manager;
  }

  /**
   * Get or create the catalog store for DDL persistence.
   */
  private async getCatalogStore(): Promise<UnifiedIndexedDBStore> {
    if (!this.catalogStore) {
      await this.manager.ensureObjectStore(CATALOG_STORE_NAME);
      this.catalogStore = await UnifiedIndexedDBStore.openForTable(this.databaseName, CATALOG_STORE_NAME);
    }
    return this.catalogStore;
  }

  /**
   * Get or create a transaction coordinator for a table's store.
   */
  async getCoordinator(tableKey: string, config: UnifiedIndexedDBModuleConfig): Promise<TransactionCoordinator> {
    let coordinator = this.coordinators.get(tableKey);
    if (!coordinator) {
      const store = await this.getStore(tableKey, config);
      coordinator = new TransactionCoordinator(store, this.eventEmitter);
      this.coordinators.set(tableKey, coordinator);
    }
    return coordinator;
  }

  /**
   * Creates a new table in the unified database.
   * Called by CREATE TABLE.
   */
  create(db: Database, tableSchema: TableSchema): IndexedDBTable {
    const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();

    if (this.tables.has(tableKey)) {
      throw new QuereusError(
        `IndexedDB table '${tableSchema.name}' already exists in schema '${tableSchema.schemaName}'`,
        StatusCode.ERROR
      );
    }

    const config = this.parseConfig(tableSchema.vtabArgs as Record<string, SqlValue> | undefined);

    // Create the table instance (store will be opened lazily)
    const table = new IndexedDBTable(
      db,
      this as unknown as import('./module.js').IndexedDBModule, // Type compatibility
      tableSchema,
      { ...config, database: this.databaseName },
      this.eventEmitter
    );

    this.tables.set(tableKey, table);

    // Save DDL immediately so it persists even if the table isn't accessed
    // This is important for sync scenarios where a remote CREATE TABLE
    // may not be followed by immediate data access
    this.saveTableDDL(tableSchema).catch(err => {
      console.error(`Failed to save DDL for ${tableKey}:`, err);
    });

    // Emit schema change event for table creation
    this.eventEmitter?.emitSchemaChange({
      type: 'create',
      objectType: 'table',
      schemaName: tableSchema.schemaName,
      objectName: tableSchema.name,
      ddl: generateTableDDL(tableSchema),
    });

    return table;
  }

  /**
   * Connects to an existing table.
   * Called when loading schema from persistent storage.
   */
  connect(
    db: Database,
    _pAux: unknown,
    _moduleName: string,
    schemaName: string,
    tableName: string,
    options: UnifiedIndexedDBModuleConfig,
    importedTableSchema?: TableSchema
  ): IndexedDBTable {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();

    // Check if we already have this table connected
    const existing = this.tables.get(tableKey);
    if (existing) {
      return existing;
    }

    // Convert options to Record<string, SqlValue> for vtabArgs
    const vtabArgs: Record<string, SqlValue> = {};
    if (options?.collation !== undefined) vtabArgs.collation = options.collation;

    // Use the imported schema if provided, otherwise create a minimal one
    const tableSchema: TableSchema = importedTableSchema ?? {
      name: tableName,
      schemaName: schemaName,
      columns: Object.freeze([]),
      columnIndexMap: new Map(),
      primaryKeyDefinition: [],
      checkConstraints: Object.freeze([]),
      isTemporary: false,
      isView: false,
      vtabModuleName: 'indexeddb',
      vtabArgs,
      vtabModule: this,
      estimatedRows: 0,
    };

    const config = this.parseConfig(vtabArgs);

    const table = new IndexedDBTable(
      db,
      this as unknown as import('./module.js').IndexedDBModule,
      tableSchema,
      { ...config, database: this.databaseName },
      this.eventEmitter,
      true // isConnected - DDL already exists in storage
    );

    this.tables.set(tableKey, table);
    return table;
  }

  /**
   * Destroys a table and removes its object store.
   */
  async destroy(
    _db: Database,
    _pAux: unknown,
    _moduleName: string,
    schemaName: string,
    tableName: string
  ): Promise<void> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();

    const table = this.tables.get(tableKey);
    if (table) {
      await table.disconnect();
      this.tables.delete(tableKey);
    }

    const store = this.stores.get(tableKey);
    if (store) {
      await store.close();
      this.stores.delete(tableKey);
    }

    // Remove the object store from the database
    await this.manager.deleteObjectStore(tableKey);

    // Remove DDL from the catalog store
    await this.removeTableDDL(schemaName, tableName);

    // Emit schema change event for table drop
    this.eventEmitter?.emitSchemaChange({
      type: 'drop',
      objectType: 'table',
      schemaName,
      objectName: tableName,
    });
  }

  /**
   * Creates an index on a table.
   * Called by CREATE INDEX.
   */
  async createIndex(
    _db: Database,
    schemaName: string,
    tableName: string,
    indexSchema: TableIndexSchema
  ): Promise<void> {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    const table = this.tables.get(tableKey);

    if (!table) {
      throw new QuereusError(
        `IndexedDB table '${tableName}' not found in schema '${schemaName}'`,
        StatusCode.NOTFOUND
      );
    }

    // Get the store and build the index
    const store = await this.getStore(tableKey, table.getConfig() as UnifiedIndexedDBModuleConfig);
    const tableSchema = table.getSchema();

    // Store index metadata
    const indexMetaKey = buildMetaKey('index', schemaName, tableName, indexSchema.name);
    const indexMetaValue = serializeRow([
      indexSchema.name,
      JSON.stringify(indexSchema.columns),
    ]);
    await store.put(indexMetaKey, indexMetaValue);

    // Build index entries for existing rows
    await this.buildIndexEntries(store, tableSchema, indexSchema);

    // Emit schema change event
    this.eventEmitter?.emitSchemaChange({
      type: 'create',
      objectType: 'index',
      schemaName,
      objectName: indexSchema.name,
    });
  }

  /**
   * Build index entries for all existing rows in a table.
   */
  private async buildIndexEntries(
    store: KVStore,
    tableSchema: TableSchema,
    indexSchema: TableIndexSchema
  ): Promise<void> {
    const encodeOptions = { collation: 'NOCASE' as const };

    // Scan all data rows
    const bounds = buildTableScanBounds(tableSchema.schemaName, tableSchema.name);
    const batch = store.batch();

    for await (const entry of store.iterate(bounds)) {
      const row = deserializeRow(entry.value);

      // Extract PK values
      const pkValues = tableSchema.primaryKeyDefinition.map(pk => row[pk.index]);

      // Extract index column values
      const indexValues = indexSchema.columns.map(col => row[col.index]);

      // Build and store index key
      const indexKey = buildIndexKey(
        tableSchema.schemaName,
        tableSchema.name,
        indexSchema.name,
        indexValues,
        pkValues,
        encodeOptions
      );
      batch.put(indexKey, new Uint8Array(0)); // Index value is empty
    }

    await batch.write();
  }

  /**
   * Modern access planning interface.
   */
  getBestAccessPlan(
    _db: Database,
    tableInfo: TableSchema,
    request: BestAccessPlanRequest
  ): BestAccessPlanResult {
    const estimatedRows = request.estimatedRows ?? 1000;

    // Check for primary key equality constraints
    const pkColumns = tableInfo.primaryKeyDefinition.map(pk => pk.index);
    const pkFilters = request.filters.filter(f =>
      f.columnIndex !== undefined &&
      pkColumns.includes(f.columnIndex) &&
      f.op === '='
    );

    if (pkFilters.length === pkColumns.length && pkColumns.length > 0) {
      // Full PK match - point lookup
      const handledFilters = request.filters.map(f =>
        pkFilters.some(pf => pf.columnIndex === f.columnIndex && pf.op === f.op)
      );
      return AccessPlanBuilder
        .eqMatch(1, 0.1)
        .setHandledFilters(handledFilters)
        .setIsSet(true)
        .setExplanation('UnifiedIndexedDB primary key lookup')
        .build();
    }

    // Check for range constraints on PK
    const rangeOps = ['<', '<=', '>', '>='];
    const rangeFilters = request.filters.filter(f =>
      f.columnIndex !== undefined &&
      pkColumns.includes(f.columnIndex) &&
      rangeOps.includes(f.op)
    );

    if (rangeFilters.length > 0) {
      // Range scan on PK
      const handledFilters = request.filters.map(f =>
        rangeFilters.some(rf => rf.columnIndex === f.columnIndex && rf.op === f.op)
      );
      const rangeRows = Math.max(1, Math.floor(estimatedRows * 0.3));
      return AccessPlanBuilder
        .rangeScan(rangeRows, 0.2)
        .setHandledFilters(handledFilters)
        .setExplanation('UnifiedIndexedDB primary key range scan')
        .build();
    }

    // Check for secondary index usage
    const indexes = tableInfo.indexes || [];
    for (const index of indexes) {
      const indexColumns = index.columns.map(c => c.index);
      const indexFilters = request.filters.filter(f =>
        f.columnIndex !== undefined &&
        indexColumns.includes(f.columnIndex) &&
        f.op === '='
      );

      if (indexFilters.length > 0) {
        const handledFilters = request.filters.map(f =>
          indexFilters.some(idf => idf.columnIndex === f.columnIndex && idf.op === f.op)
        );
        const matchedRows = Math.max(1, Math.floor(estimatedRows * 0.1));
        return AccessPlanBuilder
          .eqMatch(matchedRows, 0.3)
          .setHandledFilters(handledFilters)
          .setExplanation(`UnifiedIndexedDB index scan on ${index.name}`)
          .build();
      }
    }

    // Fallback to full scan
    return AccessPlanBuilder
      .fullScan(estimatedRows)
      .setHandledFilters(new Array(request.filters.length).fill(false))
      .setExplanation('UnifiedIndexedDB full table scan')
      .build();
  }

  /**
   * Parse module configuration from vtab args.
   */
  private parseConfig(args: Record<string, SqlValue> | undefined): UnifiedIndexedDBModuleConfig {
    return {
      collation: (args?.collation as 'BINARY' | 'NOCASE') || 'NOCASE',
      crossTabSync: args?.crossTabSync !== false,
    };
  }

  /**
   * Get or create a store for a table.
   */
  async getStore(tableKey: string, config: UnifiedIndexedDBModuleConfig): Promise<KVStore> {
    let store = this.stores.get(tableKey);
    if (!store) {
      store = await UnifiedIndexedDBStore.openForTable(this.databaseName, tableKey);
      this.stores.set(tableKey, store);

      // Start cross-tab sync if enabled and we have an event emitter (once for all tables)
      if (config.crossTabSync !== false && this.eventEmitter && !this.crossTabSync) {
        this.crossTabSync = new CrossTabSync(this.databaseName, this.eventEmitter);
        this.crossTabSync.start();
      }
    }
    return store;
  }

  /**
   * Create a multi-store write batch for atomic cross-table operations.
   * This is the key enabler for sync atomicity.
   */
  createMultiStoreBatch(): MultiStoreWriteBatch {
    return new MultiStoreWriteBatch(this.manager);
  }

  /**
   * Close all stores and clean up.
   */
  async closeAll(): Promise<void> {
    // Stop cross-tab sync
    if (this.crossTabSync) {
      this.crossTabSync.stop();
      this.crossTabSync = null;
    }

    // Clear coordinators (they don't own resources)
    this.coordinators.clear();

    for (const table of this.tables.values()) {
      await table.disconnect();
    }
    this.tables.clear();

    for (const store of this.stores.values()) {
      await store.close();
    }
    this.stores.clear();

    // Don't close the manager - it's shared
  }

  /**
   * Save table DDL to the catalog store.
   */
  async saveTableDDL(tableSchema: TableSchema): Promise<void> {
    const catalogStore = await this.getCatalogStore();
    const ddl = generateTableDDL(tableSchema);
    const metaKey = buildMetaKey('ddl', tableSchema.schemaName, tableSchema.name);
    const encoder = new TextEncoder();
    await catalogStore.put(metaKey, encoder.encode(ddl));
  }

  /**
   * Remove table DDL from the catalog store.
   */
  async removeTableDDL(schemaName: string, tableName: string): Promise<void> {
    const catalogStore = await this.getCatalogStore();
    const metaKey = buildMetaKey('ddl', schemaName, tableName);
    await catalogStore.delete(metaKey);
  }

  /**
   * Load all DDL statements from the catalog store.
   */
  async loadAllDDL(): Promise<string[]> {
    const catalogStore = await this.getCatalogStore();
    const ddlStatements: string[] = [];
    const decoder = new TextDecoder();

    // Scan all DDL metadata keys
    const ddlBounds = buildMetaScanBounds('ddl');
    for await (const entry of catalogStore.iterate(ddlBounds)) {
      ddlStatements.push(decoder.decode(entry.value));
    }

    return ddlStatements;
  }
}

