/**
 * Generic Store Module for Quereus.
 *
 * A platform-agnostic VirtualTableModule that uses a KVStoreProvider
 * to create StoreTable instances. This enables any storage backend
 * (LevelDB, IndexedDB, React Native, etc.) to be used with the same
 * table implementation.
 */

import type {
  Database,
  TableSchema,
  TableIndexSchema,
  VirtualTableModule,
  BaseModuleConfig,
  BestAccessPlanRequest,
  BestAccessPlanResult,
  SqlValue,
} from '@quereus/quereus';
import { AccessPlanBuilder, QuereusError, StatusCode } from '@quereus/quereus';

import type { KVStore, KVStoreProvider } from './kv-store.js';
import type { StoreEventEmitter } from './events.js';
import { TransactionCoordinator } from './transaction.js';
import { StoreTable, type StoreTableConfig, type StoreTableModule } from './store-table.js';
import { buildMetaKey, buildMetaScanBounds, buildIndexKey, buildTableScanBounds } from './key-builder.js';
import { serializeRow, deserializeRow } from './serialization.js';
import { generateTableDDL } from './ddl-generator.js';

/**
 * Configuration options for StoreModule tables.
 */
export interface StoreModuleConfig extends BaseModuleConfig {
  /** Collation for text keys. Default: 'NOCASE'. */
  collation?: 'BINARY' | 'NOCASE';
  /** Additional platform-specific options. */
  [key: string]: unknown;
}

/**
 * Generic store module that works with any KVStoreProvider.
 *
 * Usage:
 * ```typescript
 * import { StoreModule } from '@quereus/store';
 * import { createLevelDBProvider } from '@quereus/store-leveldb';
 *
 * const provider = createLevelDBProvider({ basePath: './data' });
 * const module = new StoreModule(provider);
 * db.registerModule('store', module);
 * ```
 */
export class StoreModule implements VirtualTableModule<StoreTable, StoreModuleConfig>, StoreTableModule {
  private provider: KVStoreProvider;
  private stores: Map<string, KVStore> = new Map();
  private coordinators: Map<string, TransactionCoordinator> = new Map();
  private tables: Map<string, StoreTable> = new Map();
  private eventEmitter?: StoreEventEmitter;

  constructor(provider: KVStoreProvider, eventEmitter?: StoreEventEmitter) {
    this.provider = provider;
    this.eventEmitter = eventEmitter;
  }

  /**
   * Get the event emitter for this module.
   */
  getEventEmitter(): StoreEventEmitter | undefined {
    return this.eventEmitter;
  }

  /**
   * Get the KVStoreProvider used by this module.
   */
  getProvider(): KVStoreProvider {
    return this.provider;
  }

  /**
   * Creates a new store-backed table.
   * Called by CREATE TABLE.
   *
   * This method eagerly initializes the underlying storage (e.g., IndexedDB object store)
   * before emitting schema change events. This ensures the storage is ready before any
   * event handlers (like sync module) try to access it.
   */
  async create(db: Database, tableSchema: TableSchema): Promise<StoreTable> {
    const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();

    if (this.tables.has(tableKey)) {
      throw new QuereusError(
        `Store table '${tableSchema.name}' already exists in schema '${tableSchema.schemaName}'`,
        StatusCode.ERROR
      );
    }

    const config = this.parseConfig(tableSchema.vtabArgs as Record<string, SqlValue> | undefined);

    // Eagerly initialize the store BEFORE creating the table or emitting events.
    // This ensures the underlying storage (e.g., IndexedDB object store) exists
    // before any schema change handlers try to access it.
    const store = await this.provider.getStore(tableSchema.schemaName, tableSchema.name);
    this.stores.set(tableKey, store);

    const table = new StoreTable(
      db,
      this,
      tableSchema,
      config,
      this.eventEmitter
      // isConnected defaults to false for newly created tables
    );

    this.tables.set(tableKey, table);

    // Emit schema change event AFTER storage is initialized
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
   * Connects to an existing store-backed table.
   * Called when loading schema from persistent storage.
   */
  async connect(
    db: Database,
    _pAux: unknown,
    _moduleName: string,
    schemaName: string,
    tableName: string,
    options: StoreModuleConfig,
    importedTableSchema?: TableSchema
  ): Promise<StoreTable> {
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
      vtabModuleName: 'store',
      vtabArgs,
      vtabModule: this,
      estimatedRows: 0,
    };

    const config = this.parseConfig(vtabArgs);

    const table = new StoreTable(
      db,
      this,
      tableSchema,
      config,
      this.eventEmitter,
      true // isConnected - DDL already exists in storage
    );

    this.tables.set(tableKey, table);
    return table;
  }

  /**
   * Destroys a store table and its storage.
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

    // Close the store via provider
    await this.provider.closeStore(schemaName, tableName);
    this.stores.delete(tableKey);
    this.coordinators.delete(tableKey);

    // Emit schema change event for table drop
    this.eventEmitter?.emitSchemaChange({
      type: 'drop',
      objectType: 'table',
      schemaName,
      objectName: tableName,
    });
  }

  /**
   * Creates an index on a store-backed table.
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
        `Store table '${tableName}' not found in schema '${schemaName}'`,
        StatusCode.NOTFOUND
      );
    }

    const store = await this.getStore(tableKey, table.getConfig());
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
        .setExplanation('Store primary key lookup')
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
        .setExplanation('Store primary key range scan')
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
          .setExplanation(`Store index scan on ${index.name}`)
          .build();
      }
    }

    // Fallback to full scan
    return AccessPlanBuilder
      .fullScan(estimatedRows)
      .setHandledFilters(new Array(request.filters.length).fill(false))
      .setExplanation('Store full table scan')
      .build();
  }

  // --- StoreTableModule interface implementation ---

  /**
   * Get or create a store for a table.
   */
  async getStore(tableKey: string, _config: StoreTableConfig): Promise<KVStore> {
    let store = this.stores.get(tableKey);
    if (!store) {
      const [schemaName, tableName] = tableKey.split('.');
      store = await this.provider.getStore(schemaName, tableName);
      this.stores.set(tableKey, store);
    }
    return store;
  }

  /**
   * Get or create a transaction coordinator for a table.
   */
  async getCoordinator(tableKey: string, config: StoreTableConfig): Promise<TransactionCoordinator> {
    let coordinator = this.coordinators.get(tableKey);
    if (!coordinator) {
      const store = await this.getStore(tableKey, config);
      coordinator = new TransactionCoordinator(store, this.eventEmitter);
      this.coordinators.set(tableKey, coordinator);
    }
    return coordinator;
  }

  /**
   * Save table DDL to persistent storage (both table store and catalog).
   */
  async saveTableDDL(tableSchema: TableSchema): Promise<void> {
    const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
    const ddl = generateTableDDL(tableSchema);
    const metaKey = buildMetaKey('ddl', tableSchema.schemaName, tableSchema.name);
    const encoder = new TextEncoder();
    const encodedDDL = encoder.encode(ddl);

    // Save to table's own store
    const store = this.stores.get(tableKey);
    if (store) {
      await store.put(metaKey, encodedDDL);
    }

    // Also save to catalog store for discovery
    const catalogStore = await this.provider.getCatalogStore();
    await catalogStore.put(metaKey, encodedDDL);
  }

  /**
   * Load all DDL statements from the catalog store.
   * Used to restore persisted tables on startup.
   */
  async loadAllDDL(): Promise<string[]> {
    const catalogStore = await this.provider.getCatalogStore();
    const bounds = buildMetaScanBounds('ddl');
    const decoder = new TextDecoder();
    const ddlStatements: string[] = [];

    for await (const entry of catalogStore.iterate(bounds)) {
      const ddl = decoder.decode(entry.value);
      ddlStatements.push(ddl);
    }

    return ddlStatements;
  }

  /**
   * Remove DDL from the catalog store when a table is dropped.
   */
  async removeTableDDL(schemaName: string, tableName: string): Promise<void> {
    const metaKey = buildMetaKey('ddl', schemaName, tableName);
    const catalogStore = await this.provider.getCatalogStore();
    await catalogStore.delete(metaKey);
  }

  /**
   * Parse module configuration from vtab args.
   */
  private parseConfig(args: Record<string, SqlValue> | undefined): StoreModuleConfig {
    return {
      collation: (args?.collation as 'BINARY' | 'NOCASE') || 'NOCASE',
    };
  }

  /**
   * Close all stores.
   */
  async closeAll(): Promise<void> {
    for (const table of this.tables.values()) {
      await table.disconnect();
    }
    this.tables.clear();
    this.coordinators.clear();

    await this.provider.closeAll();
    this.stores.clear();
  }

  /**
   * Get a table by schema and name.
   */
  getTable(schemaName: string, tableName: string): StoreTable | undefined {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    return this.tables.get(tableKey);
  }
}
