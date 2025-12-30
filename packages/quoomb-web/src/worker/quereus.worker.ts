import * as Comlink from 'comlink';
import { Database, type SqlValue } from '@quereus/quereus';
import { dynamicLoadModule } from '@quereus/plugin-loader';
import { IndexedDBModule, IndexedDBStore, StoreEventEmitter, type KVStore } from '@quereus/plugin-store/browser';
import {
  createSyncModule,
  createStoreAdapter,
  siteIdToBase64,
  siteIdFromBase64,
  serializeHLC,
  deserializeHLC,
  type SyncManager,
  type SyncEventEmitter as SyncEventEmitterType,
  type ChangeSet,
  type Change,
  type SchemaMigration,
  type SiteId,
  type RemoteChangeEvent,
  type LocalChangeEvent,
  type ConflictEvent,
  type SyncState,
} from '@quereus/plugin-sync';
import type {
  QuereusWorkerAPI,
  TableInfo,
  ColumnInfo,
  CsvPreview,
  PlanGraph,
  PlanGraphNode,
  PluginManifest,
  StorageModuleType,
  SyncStatus,
  SyncEvent
} from './types.js';
import Papa from 'papaparse';

// Maximum number of sync events to keep in history
const MAX_SYNC_EVENTS = 100;

// Helper to deserialize a ChangeSet from JSON transport format
function deserializeChangeSet(cs: Record<string, unknown>): ChangeSet {
  return {
    siteId: siteIdFromBase64(cs.siteId as string),
    transactionId: cs.transactionId as string,
    hlc: deserializeHLC(Uint8Array.from(atob(cs.hlc as string), c => c.charCodeAt(0))),
    changes: (cs.changes as Record<string, unknown>[]).map(c => ({
      ...c,
      hlc: deserializeHLC(Uint8Array.from(atob(c.hlc as string), ch => ch.charCodeAt(0))),
    })) as Change[],
    schemaMigrations: ((cs.schemaMigrations as Record<string, unknown>[]) || []).map(m => ({
      ...m,
      hlc: deserializeHLC(Uint8Array.from(atob(m.hlc as string), ch => ch.charCodeAt(0))),
    })) as SchemaMigration[],
  };
}

// Helper to serialize a ChangeSet for JSON transport
function serializeChangeSet(cs: ChangeSet): object {
  const hlcBytes = serializeHLC(cs.hlc);
  return {
    siteId: siteIdToBase64(cs.siteId),
    transactionId: cs.transactionId,
    hlc: btoa(String.fromCharCode(...hlcBytes)),
    changes: cs.changes.map(c => {
      const chlcBytes = serializeHLC(c.hlc);
      return {
        ...c,
        hlc: btoa(String.fromCharCode(...chlcBytes)),
      };
    }),
    schemaMigrations: cs.schemaMigrations.map(m => {
      const mhlcBytes = serializeHLC(m.hlc);
      return {
        ...m,
        hlc: btoa(String.fromCharCode(...mhlcBytes)),
      };
    }),
  };
}

class QuereusWorker implements QuereusWorkerAPI {
  private db: Database | null = null;

  // Storage module state
  private currentStorageModule: StorageModuleType = 'memory';
  private storeEvents: StoreEventEmitter | null = null;
  private kvStore: KVStore | null = null;
  private indexedDBModule: IndexedDBModule | null = null;

  // Sync module state
  private syncManager: SyncManager | null = null;
  private syncEvents: SyncEventEmitterType | null = null;
  private syncStatus: SyncStatus = { status: 'disconnected' };
  private syncEventHistory: SyncEvent[] = [];
  private syncEventSubscribers = new Map<string, (event: SyncEvent) => void>();
  private syncWebSocket: WebSocket | null = null;
  private serverSiteId: SiteId | null = null;

  // Initialization promises to prevent race conditions
  private storeModuleInitPromise: Promise<void> | null = null;

  async initialize(): Promise<void> {
    try {
      this.db = new Database();
      // Database is ready for use
    } catch (error) {
      throw new Error(`Failed to initialize Quereus database: ${error instanceof Error ? error.message : error}`);
    }
  }

  async executeQuery(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<Record<string, SqlValue>[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const results: Record<string, SqlValue>[] = [];

      for await (const row of this.db.eval(sql, params)) {
        results.push(row);
      }

      return results;
    } catch (error) {
      throw new Error(`Query execution failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async executeStatement(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      if (params) {
        const stmt = await this.db.prepare(sql);
        try {
          await stmt.run(params);
        } finally {
          await stmt.finalize();
        }
      } else {
        await this.db.exec(sql);
      }
    } catch (error) {
      throw new Error(`Statement execution failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async explainQuery(sql: string): Promise<any> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      // Use Quereus's query_plan() function with parameterized query to avoid escaping issues
      console.log('Original SQL:', sql);

      const results: Record<string, SqlValue>[] = [];

      // Try using parameterized query instead of string interpolation
      for await (const row of this.db.eval('SELECT * FROM query_plan(?)', [sql])) {
        results.push(row);
      }

      return results;
    } catch (error) {
      console.error('Query plan error:', error);
      throw new Error(`Query explanation failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async explainProgram(sql: string): Promise<Record<string, SqlValue>[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      console.log('Explaining program for SQL:', sql);

      const results: Record<string, SqlValue>[] = [];

      // Use Quereus's scheduler_program() function
      for await (const row of this.db.eval('SELECT * FROM scheduler_program(?)', [sql])) {
        results.push(row);
      }

      return results;
    } catch (error) {
      console.error('Program explanation error:', error);
      throw new Error(`Program explanation failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async executionTrace(sql: string): Promise<Record<string, SqlValue>[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      console.log('Getting execution trace for SQL:', sql);

      const results: Record<string, SqlValue>[] = [];

      // Use Quereus's execution_trace() function to get detailed instruction-level trace
      for await (const row of this.db.eval('SELECT * FROM execution_trace(?)', [sql])) {
        results.push(row);
      }

      return results;
    } catch (error) {
      console.error('Execution trace error:', error);
      throw new Error(`Execution trace failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async rowTrace(sql: string): Promise<Record<string, SqlValue>[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      console.log('Getting row trace for SQL:', sql);

      const results: Record<string, SqlValue>[] = [];

      // Use Quereus's row_trace() function to get detailed row-level trace
      for await (const row of this.db.eval('SELECT * FROM row_trace(?)', [sql])) {
        results.push(row);
      }

      return results;
    } catch (error) {
      console.error('Row trace error:', error);
      throw new Error(`Row trace failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async explainPlanGraph(sql: string, options?: { withActual?: boolean }): Promise<PlanGraph> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      console.log('Getting plan graph for SQL:', sql, 'withActual:', options?.withActual);

      // Get the base query plan
      const planResults: Record<string, SqlValue>[] = [];
      for await (const row of this.db.eval('SELECT * FROM query_plan(?)', [sql])) {
        planResults.push(row);
      }

      // Get actual execution data if requested
      let traceResults: Record<string, SqlValue>[] = [];
      if (options?.withActual) {
        try {
          // First execute the query to get actual timing data
          await this.db.eval(sql);

          // Then get execution trace
          for await (const row of this.db.eval('SELECT * FROM execution_trace(?)', [sql])) {
            traceResults.push(row);
          }
        } catch (error) {
          console.warn('Could not get actual execution data:', error);
          // Continue with estimated data only
        }
      }

      // Convert to graph structure
      return this.buildPlanGraph(planResults, traceResults, sql);
    } catch (error) {
      console.error('Plan graph error:', error);
      throw new Error(`Plan graph failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private buildPlanGraph(planRows: Record<string, SqlValue>[], traceRows: Record<string, SqlValue>[], originalSql: string): PlanGraph {
    // Build a simple linear plan structure from the plan data
    // This is a simplified version - real implementation would need to parse the actual plan structure
    const nodes: PlanGraphNode[] = [];
    let totalEstCost = 0;
    let totalEstRows = 0;
    let totalActTime = 0;

    // Create nodes from plan data
    planRows.forEach((row, index) => {
      const estCost = (row.est_cost as number) || 0;
      const estRows = (row.est_rows as number) || 0;

      totalEstCost += estCost;
      totalEstRows += estRows;

      // Use the proper fields from query_plan schema
      const op = (row.op as string) || 'UNKNOWN';
      const detail = (row.detail as string) || '';
      const objectName = (row.object_name as string) || null;
      const alias = (row.alias as string) || null;
      const nodeType = (row.node_type as string) || '';
      const subqueryLevel = (row.subquery_level as number) || 0;

      // Find corresponding trace data
      const traceRow = traceRows.find(trace =>
        (trace.step_id as number) === index + 1
      );

      const actTimeMs = traceRow ? (traceRow.duration_ms as number) : undefined;
      const actRows = traceRow ? (traceRow.rows_processed as number) : undefined;

      if (actTimeMs) totalActTime += actTimeMs;

      nodes.push({
        id: `node-${index}`,
        opcode: op, // Use the proper 'op' field
        estCost,
        estRows,
        actTimeMs,
        actRows,
        sqlSpan: undefined, // TODO: Extract from plan if available
        extra: {
          detail,
          objectName: objectName || undefined,
          alias: alias || undefined,
          nodeType,
          subqueryLevel,
          selectid: row.selectid,
          order: row.order
        },
        children: []
      });
    });

    // For now, create a simple linear tree (each node's child is the next node)
    // Real implementation would parse the actual tree structure from selectid/order
    for (let i = 0; i < nodes.length - 1; i++) {
      nodes[i].children = [nodes[i + 1]];
    }

    const root = nodes[0] || {
      id: 'root',
      opcode: 'EMPTY',
      estCost: 0,
      estRows: 0,
      children: []
    };

    return {
      root,
      totals: {
        estCost: totalEstCost,
        estRows: totalEstRows,
        actTimeMs: totalActTime > 0 ? totalActTime : undefined
      }
    };
  }

  async listTables(): Promise<Array<{ name: string; type: string }>> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const results: Array<{ name: string; type: string }> = [];

      for await (const row of this.db.eval(`
        SELECT name, type FROM sqlite_schema
        WHERE type IN ('table', 'view')
        ORDER BY name
      `)) {
        results.push({
          name: row.name as string,
          type: row.type as string,
        });
      }

      return results;
    } catch (error) {
      throw new Error(`Failed to list tables: ${error instanceof Error ? error.message : error}`);
    }
  }

  async getTableSchema(tableName: string): Promise<TableInfo> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      // Get table definition
      const tableResults: Array<{ name: string; type: string; sql: string }> = [];
      for await (const row of this.db.eval(`
        SELECT name, type, sql FROM sqlite_schema
        WHERE name = ? AND sql IS NOT NULL
      `, [tableName])) {
        tableResults.push({
          name: row.name as string,
          type: row.type as string,
          sql: row.sql as string,
        });
      }

      if (tableResults.length === 0) {
        throw new Error(`Table '${tableName}' not found`);
      }

      const table = tableResults[0];

      // Get column information
      const columns: ColumnInfo[] = [];
      for await (const row of this.db.eval(`PRAGMA table_info(${tableName})`)) {
        columns.push({
          name: row.name as string,
          type: (row.type as string) || 'TEXT',
          nullable: !(row.notnull as boolean),
          defaultValue: row.dflt_value as SqlValue,
          primaryKey: row.pk as boolean,
        });
      }

      return {
        name: table.name,
        type: table.type as 'table' | 'view' | 'index',
        sql: table.sql,
        columns,
      };
    } catch (error) {
      throw new Error(`Failed to get table schema: ${error instanceof Error ? error.message : error}`);
    }
  }

  async previewCsv(csvData: string): Promise<CsvPreview> {
    try {
      // Parse CSV
      const parseResult = Papa.parse(csvData, {
        header: true,
        skipEmptyLines: true,
        transform: (value, field) => {
          // Try to convert numbers
          if (value === '') return null;
          const num = Number(value);
          if (!isNaN(num) && value === num.toString()) {
            return num;
          }
          return value;
        }
      });

      // Filter out warnings that shouldn't block import
      const actualErrors = parseResult.errors.filter(error => {
        // Allow delimiter detection warnings to pass through
        if (error.message && error.message.includes('Unable to auto-detect delimiting character')) {
          return false;
        }
        // Allow other non-critical warnings
        if (error.type === 'Quotes' || error.type === 'Delimiter') {
          return false;
        }
        return true;
      });

      if (parseResult.data.length === 0) {
        return {
          columns: [],
          sampleRows: [],
          totalRows: 0,
          errors: actualErrors.map(e => e.message),
          inferredTypes: {}
        };
      }

      const firstRow = parseResult.data[0] as Record<string, any>;
      const originalColumns = Object.keys(firstRow);

      // Sanitize column names (same logic as import)
      const sanitizedColumns = originalColumns.map((col, index) => {
        let sanitizedCol = col.trim();
        if (!sanitizedCol) {
          sanitizedCol = `column_${index + 1}`;
        }
        sanitizedCol = sanitizedCol.replace(/[^a-zA-Z0-9_]/g, '_');
        if (/^[0-9]/.test(sanitizedCol)) {
          sanitizedCol = 'col_' + sanitizedCol;
        }
        // Ensure not empty after sanitization
        if (!sanitizedCol || sanitizedCol === '_'.repeat(sanitizedCol.length)) {
          sanitizedCol = `column_${index + 1}`;
        }
        return sanitizedCol;
      });

      // Infer column types from data (same logic as import)
      const inferredTypes: Record<string, string> = {};
      sanitizedColumns.forEach((sanitizedCol, index) => {
        const originalCol = originalColumns[index];
        const sampleValues = parseResult.data.slice(0, 10).map(row => (row as any)[originalCol]);
        const hasNumbers = sampleValues.some(val => typeof val === 'number');
        const hasStrings = sampleValues.some(val => typeof val === 'string' && val !== '');

        let type = 'TEXT';
        if (hasNumbers && !hasStrings) {
          type = 'REAL';
        }

        inferredTypes[sanitizedCol] = type;
      });

      // Create sample rows with sanitized column names
      const sampleRows = parseResult.data.slice(0, 5).map(row => {
        const sanitizedRow: Record<string, any> = {};
        originalColumns.forEach((originalCol, index) => {
          const sanitizedCol = sanitizedColumns[index];
          sanitizedRow[sanitizedCol] = (row as any)[originalCol];
        });
        return sanitizedRow;
      });

      return {
        columns: sanitizedColumns, // Return sanitized column names
        sampleRows,
        totalRows: parseResult.data.length,
        errors: actualErrors.map(e => e.message), // Only show actual errors
        inferredTypes
      };
    } catch (error) {
      throw new Error(`CSV preview failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async importCsv(csvData: string, tableName: string): Promise<{ rowsImported: number }> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      // Parse CSV
      const parseResult = Papa.parse(csvData, {
        header: true,
        skipEmptyLines: true,
        transform: (value, field) => {
          // Try to convert numbers
          if (value === '') return null;
          const num = Number(value);
          if (!isNaN(num) && value === num.toString()) {
            return num;
          }
          return value;
        }
      });

      // Filter out warnings that shouldn't block import
      const actualErrors = parseResult.errors.filter(error => {
        // Allow delimiter detection warnings to pass through
        if (error.message && error.message.includes('Unable to auto-detect delimiting character')) {
          return false;
        }
        // Allow other non-critical warnings
        if (error.type === 'Quotes' || error.type === 'Delimiter') {
          return false;
        }
        return true;
      });

      if (actualErrors.length > 0) {
        throw new Error(`CSV parsing errors: ${actualErrors.map(e => e.message).join(', ')}`);
      }

      if (parseResult.data.length === 0) {
        return { rowsImported: 0 };
      }

      // Better table name sanitization - ensure it's a valid SQL identifier
      let sanitizedTableName = tableName.trim();
      if (!sanitizedTableName) {
        sanitizedTableName = 'imported_table';
      }
      // Replace invalid characters with underscores
      sanitizedTableName = sanitizedTableName.replace(/[^a-zA-Z0-9_]/g, '_');
      // Ensure it doesn't start with a number
      if (/^[0-9]/.test(sanitizedTableName)) {
        sanitizedTableName = 'table_' + sanitizedTableName;
      }
      // Ensure it's not empty after sanitization
      if (!sanitizedTableName || sanitizedTableName === '_'.repeat(sanitizedTableName.length)) {
        sanitizedTableName = 'imported_table';
      }

      console.log('Sanitized table name:', sanitizedTableName);

      // Infer column types from data
      const firstRow = parseResult.data[0] as Record<string, any>;
      const columnNames = Object.keys(firstRow);

      if (columnNames.length === 0) {
        throw new Error('No columns found in CSV data');
      }

      // Sanitize column names and build column definitions
      const columnDefs = columnNames.map((col, index) => {
        // Sanitize column name
        let sanitizedCol = col.trim();
        if (!sanitizedCol) {
          sanitizedCol = `column_${index + 1}`;
        }
        sanitizedCol = sanitizedCol.replace(/[^a-zA-Z0-9_]/g, '_');
        if (/^[0-9]/.test(sanitizedCol)) {
          sanitizedCol = 'col_' + sanitizedCol;
        }
        // Ensure not empty after sanitization
        if (!sanitizedCol || sanitizedCol === '_'.repeat(sanitizedCol.length)) {
          sanitizedCol = `column_${index + 1}`;
        }

        // Infer type
        const sampleValues = parseResult.data.slice(0, 10).map(row => (row as any)[col]);
        const hasNumbers = sampleValues.some(val => typeof val === 'number');
        const hasStrings = sampleValues.some(val => typeof val === 'string' && val !== '');

        let type = 'TEXT';
        if (hasNumbers && !hasStrings) {
          type = 'REAL';
        }

        return `${sanitizedCol} ${type}`;
      });

      // Create table with proper SQL syntax - no quotes around column names in definition
      const createSql = `CREATE TABLE ${sanitizedTableName} (${columnDefs.join(', ')})`;
      console.log('CREATE TABLE SQL:', createSql);

      try {
        await this.db.exec(createSql);
      } catch (createError) {
        console.error('CREATE TABLE failed:', createError);
        throw new Error(`Failed to create table: ${createError instanceof Error ? createError.message : createError}`);
      }

      // Insert data with proper column mapping
      const sanitizedColumnNames = columnNames.map((col, index) => {
        let sanitizedCol = col.trim();
        if (!sanitizedCol) {
          sanitizedCol = `column_${index + 1}`;
        }
        sanitizedCol = sanitizedCol.replace(/[^a-zA-Z0-9_]/g, '_');
        if (/^[0-9]/.test(sanitizedCol)) {
          sanitizedCol = 'col_' + sanitizedCol;
        }
        if (!sanitizedCol || sanitizedCol === '_'.repeat(sanitizedCol.length)) {
          sanitizedCol = `column_${index + 1}`;
        }
        return sanitizedCol;
      });

      const placeholders = sanitizedColumnNames.map(() => '?').join(', ');
      const insertSql = `INSERT INTO ${sanitizedTableName} (${sanitizedColumnNames.join(', ')}) VALUES (${placeholders})`;
      console.log('INSERT SQL:', insertSql);

      const stmt = await this.db.prepare(insertSql);
      let insertCount = 0;

      try {
        for (const row of parseResult.data) {
          const values = columnNames.map(col => (row as any)[col]);
          await stmt.run(values);
          insertCount++;
        }
      } finally {
        await stmt.finalize();
      }

      return { rowsImported: insertCount };
    } catch (error) {
      throw new Error(`CSV import failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async loadModule(url: string, config?: Record<string, SqlValue>): Promise<PluginManifest | undefined> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      return await dynamicLoadModule(url, this.db, config ?? {});
    } catch (error) {
      console.error('Failed to load module:', error);
      throw error;
    }
  }

  // ============================================================================
  // Storage Module Management
  // ============================================================================

  getStorageModule(): StorageModuleType {
    return this.currentStorageModule;
  }

  async setStorageModule(module: StorageModuleType): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    if (module === this.currentStorageModule) {
      return; // Already set
    }

    // Clean up previous module state if switching away from store/sync
    if (this.currentStorageModule === 'sync' && this.syncWebSocket) {
      await this.disconnectSync();
    }

    switch (module) {
      case 'memory':
        // Set memory as the default module
        await this.db.exec("pragma default_vtab_module = 'memory'");
        this.currentStorageModule = 'memory';
        break;

      case 'store':
        // Initialize IndexedDB store and set as default
        // Set default module BEFORE restore so imported DDL uses correct module
        await this.initializeStoreModule();
        this.currentStorageModule = 'store';
        break;

      case 'sync':
        // Initialize store first, then sync on top
        await this.initializeStoreModule();
        await this.initializeSyncModule();
        this.currentStorageModule = 'sync';
        break;

      default:
        throw new Error(`Unknown storage module: ${module}`);
    }
  }

  getAvailableModules(): StorageModuleType[] {
    return ['memory', 'store', 'sync'];
  }
  private async initializeStoreModule(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Only initialize once - use promise to prevent race conditions
    if (this.storeModuleInitPromise) {
      return this.storeModuleInitPromise;
    }

    this.storeModuleInitPromise = this.doInitializeStoreModule();
    return this.storeModuleInitPromise;
  }

  private async doInitializeStoreModule(): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    // Create store event emitter
    this.storeEvents = new StoreEventEmitter();

    // Create and register IndexedDB module
    this.indexedDBModule = new IndexedDBModule(this.storeEvents);
    this.db.registerVtabModule('indexeddb', this.indexedDBModule);

    // Set default module BEFORE restore so imported DDL (which may lack USING clause) uses indexeddb
    await this.db.exec("pragma default_vtab_module = 'indexeddb'");

    // Open a default KV store for sync metadata and catalog
    this.kvStore = await IndexedDBStore.open({ path: 'quoomb_sync_meta' });

    // Restore persisted tables from IndexedDB
    await this.restorePersistedTables();
  }

  private async restorePersistedTables(): Promise<void> {
    if (!this.db || !this.indexedDBModule) {
      return;
    }

    try {
      // Load DDL from the central catalog store
      const ddlStatements = await this.indexedDBModule.loadAllDDL();

      if (ddlStatements.length > 0) {
        // Import the catalog into the schema manager
        // This calls connect() on the module instead of create()
        const imported = await this.db.schemaManager.importCatalog(ddlStatements);
      }
    } catch (error) {
      console.error('[Restore] Failed to restore persisted tables:', error);
    }
  }

  private async initializeSyncModule(): Promise<void> {
    if (!this.db || !this.storeEvents || !this.kvStore || !this.indexedDBModule) {
      throw new Error('Store module must be initialized first');
    }

    // Only initialize once
    if (this.syncManager) {
      return;
    }

    // Create store adapter for applying remote changes
    // This executes DDL/DML on the local database when remote changes arrive
    const db = this.db;
    const indexedDBModule = this.indexedDBModule;
    const getTableSchema = (schemaName: string, tableName: string) => {
      return db.schemaManager.getTable(schemaName, tableName);
    };

    // Get the correct KV store for each table
    // Each IndexedDB table has its own underlying database
    const getKVStore = async (schemaName: string, tableName: string) => {
      const tableKey = `${schemaName}.${tableName}`.toLowerCase();
      // Get the table's config to determine its database name
      const tableSchema = db.schemaManager.getTable(schemaName, tableName);
      if (!tableSchema) {
        throw new Error(`Table not found: ${schemaName}.${tableName}`);
      }
      const config = {
        database: (tableSchema.vtabArgs as Record<string, SqlValue>)?.database as string | undefined
          || `quereus_${schemaName}_${tableName}`,
        collation: 'NOCASE' as const,
      };
      return indexedDBModule.getStore(tableKey, config);
    };

    const applyToStore = createStoreAdapter({
      db: this.db,
      getKVStore,
      events: this.storeEvents,
      getTableSchema,
      collation: 'NOCASE',
    });

    // Create sync module with the store adapter and schema lookup
    // getTableSchema is needed for proper column name mapping in sync
    const { syncManager, syncEvents } = await createSyncModule(
      this.kvStore,
      this.storeEvents,
      { applyToStore, getTableSchema }
    );

    this.syncManager = syncManager;
    this.syncEvents = syncEvents;

    // Subscribe to sync events and forward to UI
    this.setupSyncEventListeners();
  }

  private setupSyncEventListeners(): void {
    if (!this.syncEvents) return;

    // Remote changes
    this.syncEvents.onRemoteChange((event: RemoteChangeEvent) => {
      this.addSyncEvent({
        type: 'remote-change',
        timestamp: Date.now(),
        message: `Received ${event.changes.length} changes from peer`,
        details: {
          changeCount: event.changes.length,
        },
      });
    });

    // Local changes - send to server if connected
    this.syncEvents.onLocalChange(async (event: LocalChangeEvent) => {
      this.addSyncEvent({
        type: 'local-change',
        timestamp: Date.now(),
        message: `Made ${event.changes.length} local changes`,
        details: {
          changeCount: event.changes.length,
        },
      });

      // Send changes to server if connected
      if (this.syncWebSocket?.readyState === WebSocket.OPEN && this.serverSiteId && this.syncManager) {
        try {
          // Get all pending changes to send to server
          const changesToSend = await this.syncManager.getChangesSince(this.serverSiteId);
          if (changesToSend.length > 0) {
            const serialized = changesToSend.map(cs => serializeChangeSet(cs));
            this.syncWebSocket.send(JSON.stringify({
              type: 'apply_changes',
              changes: serialized,
            }));
            this.addSyncEvent({
              type: 'state-change',
              timestamp: Date.now(),
              message: `Sent ${changesToSend.length} changeset(s) to server`,
            });
          }
        } catch (err) {
          console.error('Failed to send local changes to server:', err);
        }
      }
    });

    // Conflicts
    this.syncEvents.onConflictResolved((event: ConflictEvent) => {
      this.addSyncEvent({
        type: 'conflict',
        timestamp: Date.now(),
        message: `Conflict resolved in ${event.table}.${event.column} (${event.winner} won)`,
        details: {
          table: event.table,
          conflictColumn: event.column,
          winner: event.winner,
        },
      });
    });

    // State changes
    this.syncEvents.onSyncStateChange((state: SyncState) => {
      this.syncStatus = this.convertSyncState(state);
      this.addSyncEvent({
        type: 'state-change',
        timestamp: Date.now(),
        message: `Sync state: ${state.status}`,
      });
    });
  }

  private convertSyncState(state: SyncState): SyncStatus {
    switch (state.status) {
      case 'disconnected':
        return { status: 'disconnected' };
      case 'connecting':
        return { status: 'connecting' };
      case 'syncing':
        return { status: 'syncing', progress: state.progress ?? 0 };
      case 'synced':
        return { status: 'synced', lastSyncTime: Date.now() };
      case 'error':
        return { status: 'error', message: state.error?.message ?? 'Unknown error' };
      default:
        return { status: 'disconnected' };
    }
  }

  private addSyncEvent(event: SyncEvent): void {
    this.syncEventHistory.unshift(event);

    // Trim history
    if (this.syncEventHistory.length > MAX_SYNC_EVENTS) {
      this.syncEventHistory = this.syncEventHistory.slice(0, MAX_SYNC_EVENTS);
    }

    // Notify subscribers
    for (const callback of this.syncEventSubscribers.values()) {
      try {
        callback(event);
      } catch (error) {
        console.warn('Error in sync event subscriber:', error);
      }
    }
  }

  // ============================================================================
  // Sync Operations
  // ============================================================================

  getSyncStatus(): SyncStatus {
    return this.syncStatus;
  }

  async connectSync(url: string, token?: string): Promise<void> {
    if (!this.syncManager) {
      throw new Error('Sync module not initialized. Call setStorageModule("sync") first.');
    }

    // Close existing connection
    if (this.syncWebSocket) {
      this.syncWebSocket.close();
    }

    this.syncStatus = { status: 'connecting' };

    return new Promise((resolve, reject) => {
      try {
        // Add auth token to URL if provided
        const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
        this.syncWebSocket = new WebSocket(wsUrl);

        this.syncWebSocket.onopen = () => {
          // Send handshake message with our siteId
          const siteId = this.syncManager!.getSiteId();
          const handshake = JSON.stringify({
            type: 'handshake',
            siteId: siteIdToBase64(siteId),
            token: token,
          });
          this.syncWebSocket!.send(handshake);

          this.syncStatus = { status: 'syncing', progress: 0 };
          this.addSyncEvent({
            type: 'state-change',
            timestamp: Date.now(),
            message: 'Connected to sync server, handshake sent',
          });
          resolve();
        };

        this.syncWebSocket.onclose = () => {
          this.syncStatus = { status: 'disconnected' };
          this.addSyncEvent({
            type: 'state-change',
            timestamp: Date.now(),
            message: 'Disconnected from sync server',
          });
        };

        this.syncWebSocket.onerror = (event) => {
          const error = new Error('WebSocket connection failed');
          this.syncStatus = { status: 'error', message: error.message };
          this.addSyncEvent({
            type: 'error',
            timestamp: Date.now(),
            message: error.message,
          });
          reject(error);
        };

        this.syncWebSocket.onmessage = async (event) => {
          await this.handleSyncMessage(event.data);
        };
      } catch (error) {
        this.syncStatus = { status: 'error', message: error instanceof Error ? error.message : 'Connection failed' };
        reject(error);
      }
    });
  }

  private async handleSyncMessage(data: string): Promise<void> {
    if (!this.syncManager) return;

    try {
      const message = JSON.parse(data);

      switch (message.type) {
        case 'handshake_ack':
          // Server acknowledged our handshake - store server's siteId
          if (message.serverSiteId) {
            this.serverSiteId = siteIdFromBase64(message.serverSiteId);
          }
          this.addSyncEvent({
            type: 'state-change',
            timestamp: Date.now(),
            message: `Authenticated with server (connection: ${message.connectionId?.slice(0, 8) ?? 'unknown'})`,
          });
          // Request initial changes from server
          this.syncWebSocket?.send(JSON.stringify({
            type: 'get_changes',
          }));
          break;

        case 'changes':
        case 'push_changes':
          // Deserialize and apply incoming changes (from initial sync or broadcast)
          const changeSets: ChangeSet[] = (message.changeSets || []).map(
            (cs: Record<string, unknown>) => deserializeChangeSet(cs)
          );
          const result = await this.syncManager.applyChanges(changeSets);
          this.addSyncEvent({
            type: 'remote-change',
            timestamp: Date.now(),
            message: `Applied ${result.applied} changes (${result.conflicts} conflicts resolved)`,
            details: { changeCount: result.applied },
          });
          this.syncStatus = { status: 'synced', lastSyncTime: Date.now() };
          break;

        case 'request_changes':
          // Peer is requesting changes since a certain HLC
          const changes = await this.syncManager.getChangesSince(
            message.siteId,
            message.sinceHLC
          );
          this.syncWebSocket?.send(JSON.stringify({
            type: 'apply_changes',
            changes,
          }));
          break;

        case 'error':
          // Server sent an error
          this.addSyncEvent({
            type: 'error',
            timestamp: Date.now(),
            message: `Server error: ${message.message} (${message.code})`,
          });
          break;

        case 'pong':
          // Heartbeat response - no action needed
          break;

        case 'apply_result':
          // Server confirmed our changes were applied
          this.addSyncEvent({
            type: 'info',
            timestamp: Date.now(),
            message: `Server applied ${message.applied ?? 0} change(s)`,
          });
          break;

        default:
          console.warn('Unknown sync message type:', message.type);
      }
    } catch (error) {
      console.error('Error handling sync message:', error);
      this.addSyncEvent({
        type: 'error',
        timestamp: Date.now(),
        message: `Sync error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
    }
  }

  async disconnectSync(): Promise<void> {
    if (this.syncWebSocket) {
      this.syncWebSocket.close();
      this.syncWebSocket = null;
    }
    this.serverSiteId = null;
    this.syncStatus = { status: 'disconnected' };
  }

  getSyncEvents(limit?: number): SyncEvent[] {
    if (limit) {
      return this.syncEventHistory.slice(0, limit);
    }
    return [...this.syncEventHistory];
  }

  onSyncEvent(callback: (event: SyncEvent) => void): string {
    const id = crypto.randomUUID();
    this.syncEventSubscribers.set(id, callback);
    return id;
  }

  offSyncEvent(subscriptionId: string): void {
    this.syncEventSubscribers.delete(subscriptionId);
  }

  async close(): Promise<void> {
    // Clean up sync connection
    if (this.syncWebSocket) {
      this.syncWebSocket.close();
      this.syncWebSocket = null;
    }

    // Clean up KV store
    if (this.kvStore) {
      await this.kvStore.close();
      this.kvStore = null;
    }

    // Reset state
    this.syncManager = null;
    this.syncEvents = null;
    this.storeEvents = null;
    this.syncEventSubscribers.clear();
    this.syncEventHistory = [];
    this.currentStorageModule = 'memory';

    if (this.db) {
      try {
        await this.db.close();
      } catch (error) {
        console.warn('Error closing database:', error);
      }
      this.db = null;
    }
  }
}

// Expose the worker API via Comlink
const worker = new QuereusWorker();
Comlink.expose(worker);
