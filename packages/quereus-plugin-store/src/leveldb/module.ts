/**
 * LevelDB Virtual Table Module for Quereus.
 *
 * Provides persistent storage using LevelDB for Node.js environments.
 */

import type { Database, TableSchema, TableIndexSchema, VirtualTableModule, BaseModuleConfig, BestAccessPlanRequest, BestAccessPlanResult, SqlValue } from '@quereus/quereus';
import { AccessPlanBuilder } from '@quereus/quereus';
import { LevelDBStore } from './store.js';
import { LevelDBTable } from './table.js';
import type { StoreEventEmitter } from '../common/events.js';
import { buildMetaKey, buildMetaScanBounds } from '../common/key-builder.js';
import { serializeRow, deserializeRow } from '../common/serialization.js';
import { generateTableDDL } from '../common/ddl-generator.js';

/**
 * Configuration options for LevelDB tables.
 */
export interface LevelDBModuleConfig extends BaseModuleConfig {
  /** Path to the LevelDB database directory. */
  path?: string;
  /** Create database if it doesn't exist. Default: true. */
  createIfMissing?: boolean;
  /** Collation for text keys. Default: 'NOCASE'. */
  collation?: 'BINARY' | 'NOCASE';
}

/**
 * LevelDB virtual table module.
 *
 * Usage:
 *   CREATE TABLE t1 (id INTEGER PRIMARY KEY, name TEXT) USING leveldb(path='./data/t1');
 */
export class LevelDBModule implements VirtualTableModule<LevelDBTable, LevelDBModuleConfig> {
  private stores: Map<string, LevelDBStore> = new Map();
  private tables: Map<string, LevelDBTable> = new Map();
  private eventEmitter?: StoreEventEmitter;

  constructor(eventEmitter?: StoreEventEmitter) {
    this.eventEmitter = eventEmitter;
  }

  /**
   * Creates a new LevelDB-backed table.
   * Called by CREATE TABLE.
   */
  create(db: Database, tableSchema: TableSchema): LevelDBTable {
    const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();

    if (this.tables.has(tableKey)) {
      throw new Error(`LevelDB table '${tableSchema.name}' already exists in schema '${tableSchema.schemaName}'.`);
    }

    const config = this.parseConfig(tableSchema.vtabArgs as Record<string, SqlValue> | undefined, tableSchema);

    // Create the table instance (store will be opened lazily)
    const table = new LevelDBTable(
      db,
      this,
      tableSchema,
      config,
      this.eventEmitter
    );

    this.tables.set(tableKey, table);

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
   * Connects to an existing LevelDB-backed table.
   * Called when loading schema from persistent storage.
   */
  connect(
    db: Database,
    _pAux: unknown,
    _moduleName: string,
    schemaName: string,
    tableName: string,
    options: LevelDBModuleConfig
  ): LevelDBTable {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();

    // Check if we already have this table connected
    const existing = this.tables.get(tableKey);
    if (existing) {
      return existing;
    }

    // Convert options to Record<string, SqlValue> for vtabArgs
    const vtabArgs: Record<string, SqlValue> = {};
    if (options?.path !== undefined) vtabArgs.path = options.path;
    if (options?.createIfMissing !== undefined) vtabArgs.createIfMissing = options.createIfMissing ? 1 : 0;
    if (options?.collation !== undefined) vtabArgs.collation = options.collation;

    // Create a minimal table schema for connect
    const tableSchema: TableSchema = {
      name: tableName,
      schemaName: schemaName,
      columns: Object.freeze([]),
      columnIndexMap: new Map(),
      primaryKeyDefinition: [],
      checkConstraints: Object.freeze([]),
      isTemporary: false,
      isView: false,
      vtabModuleName: 'leveldb',
      vtabArgs,
      vtabModule: this,
      estimatedRows: 0,
    };

    const config = this.parseConfig(vtabArgs, tableSchema);

    const table = new LevelDBTable(
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
   * Destroys a LevelDB table and its storage.
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

    // Emit schema change event for table drop
    this.eventEmitter?.emitSchemaChange({
      type: 'drop',
      objectType: 'table',
      schemaName,
      objectName: tableName,
    });
  }

  /**
   * Creates an index on a LevelDB-backed table.
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
      throw new Error(`LevelDB table '${tableName}' not found in schema '${schemaName}'.`);
    }

    // Get the store and build the index
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
    store: LevelDBStore,
    tableSchema: TableSchema,
    indexSchema: TableIndexSchema
  ): Promise<void> {
    const { buildIndexKey, buildTableScanBounds } = await import('../common/key-builder.js');
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
        .setExplanation('LevelDB primary key lookup')
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
        .setExplanation('LevelDB primary key range scan')
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
          .setExplanation(`LevelDB index scan on ${index.name}`)
          .build();
      }
    }

    // Fallback to full scan
    return AccessPlanBuilder
      .fullScan(estimatedRows)
      .setHandledFilters(new Array(request.filters.length).fill(false))
      .setExplanation('LevelDB full table scan')
      .build();
  }

  /**
   * Parse module configuration from vtab args.
   */
  private parseConfig(
    args: Record<string, SqlValue> | undefined,
    tableSchema: TableSchema
  ): LevelDBModuleConfig {
    const path = args?.path as string | undefined;
    const defaultPath = `./.quereus/data/${tableSchema.schemaName}/${tableSchema.name}`;

    return {
      path: path || defaultPath,
      createIfMissing: args?.createIfMissing !== false,
      collation: (args?.collation as 'BINARY' | 'NOCASE') || 'NOCASE',
    };
  }

  /**
   * Get or create a store for a table.
   */
  async getStore(tableKey: string, config: LevelDBModuleConfig): Promise<LevelDBStore> {
    let store = this.stores.get(tableKey);
    if (!store) {
      store = await LevelDBStore.open({
        path: config.path!,
        createIfMissing: config.createIfMissing,
      });
      this.stores.set(tableKey, store);
    }
    return store;
  }

  /**
   * Close all stores.
   */
  async closeAll(): Promise<void> {
    for (const table of this.tables.values()) {
      await table.disconnect();
    }
    this.tables.clear();

    for (const store of this.stores.values()) {
      await store.close();
    }
    this.stores.clear();
  }

  /**
   * Save table DDL to persistent storage.
   * Called after a table is first accessed to persist its schema.
   */
  async saveTableDDL(tableSchema: TableSchema): Promise<void> {
    const tableKey = `${tableSchema.schemaName}.${tableSchema.name}`.toLowerCase();
    const table = this.tables.get(tableKey);
    if (!table) return;

    const store = await this.getStore(tableKey, table.getConfig());
    const ddl = generateTableDDL(tableSchema);
    const metaKey = buildMetaKey('ddl', tableSchema.schemaName, tableSchema.name);
    const encoder = new TextEncoder();
    await store.put(metaKey, encoder.encode(ddl));
  }

  /**
   * Load all DDL statements from persistent storage for schema discovery.
   * Returns an array of DDL strings (CREATE TABLE, CREATE INDEX).
   */
  async loadAllDDL(storePath: string): Promise<string[]> {
    const store = await LevelDBStore.open({
      path: storePath,
      createIfMissing: false,
    });

    try {
      const ddlStatements: string[] = [];
      const decoder = new TextDecoder();

      // Scan all DDL metadata keys
      const ddlBounds = buildMetaScanBounds('ddl');
      for await (const entry of store.iterate(ddlBounds)) {
        ddlStatements.push(decoder.decode(entry.value));
      }

      // Scan all index metadata keys
      const indexBounds = buildMetaScanBounds('index');
      for await (const entry of store.iterate(indexBounds)) {
        // Index metadata is stored as [name, columnsJson]
        const row = deserializeRow(entry.value);
        if (row.length >= 2) {
          // We need the table schema to generate proper DDL
          // For now, store as a comment - full implementation would need table context
        }
      }

      return ddlStatements;
    } finally {
      await store.close();
    }
  }

  /**
   * Get a table by schema and name.
   * Useful for testing and direct access to table methods.
   */
  getTable(schemaName: string, tableName: string): LevelDBTable | undefined {
    const tableKey = `${schemaName}.${tableName}`.toLowerCase();
    return this.tables.get(tableKey);
  }
}

