import type { SqlValue } from '@quereus/quereus';
import type { PluginManifest as BasePluginManifest } from '@quereus/plugin-loader';

// Re-export plugin types for convenience, but extend PluginManifest with UI-specific properties
export type { PluginRecord, PluginSetting } from '@quereus/plugin-loader';

// Extended PluginManifest for UI display with provides information
export interface PluginManifest extends BasePluginManifest {
  provides?: {
    vtables?: string[];         // names of vtable modules provided
    functions?: string[];       // names of functions provided
    collations?: string[];      // names of collations provided
  };
}

// ============================================================================
// Storage Module Types
// ============================================================================

/**
 * Available storage module types.
 */
export type StorageModuleType = 'memory' | 'store' | 'sync';

/**
 * Sync connection state for UI display.
 */
export type SyncStatus =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'syncing'; progress: number }
  | { status: 'synced'; lastSyncTime: number }
  | { status: 'error'; message: string };

/**
 * Sync event types for UI notifications.
 */
export type SyncEventType = 'remote-change' | 'local-change' | 'conflict' | 'state-change' | 'error';

/**
 * Sync event for UI display.
 */
export interface SyncEvent {
  type: SyncEventType;
  timestamp: number;
  message: string;
  details?: {
    table?: string;
    changeCount?: number;
    conflictColumn?: string;
    winner?: 'local' | 'remote';
  };
}

export interface PlanGraphNode {
  id: string;                 // stable, local to this plan
  opcode: string;             // "SCAN", "HASH_JOIN", etc.
  estCost: number;            // planner estimate
  estRows: number;
  actTimeMs?: number;         // present when withActual = true
  actRows?: number;
  sqlSpan?: { start: number; end: number };  // char offsets in original SQL
  extra?: {
    detail?: string;
    objectName?: string;      // table/index/object name
    alias?: string;           // query alias
    nodeType?: string;        // node type from plan
    subqueryLevel?: number;   // nesting level
    selectid?: any;
    order?: any;
  };
  children: PlanGraphNode[];
}

export interface PlanGraph {
  root: PlanGraphNode;
  totals: { estCost: number; estRows: number; actTimeMs?: number; };
}

export interface QuereusWorkerAPI {
  /**
   * Initialize a new Quereus database session
   */
  initialize(): Promise<void>;

  /**
   * Execute a SQL query and return results
   */
  executeQuery(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<Record<string, SqlValue>[]>;

  /**
   * Execute a SQL statement without returning results (for DDL, DML)
   */
  executeStatement(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<void>;

  /**
   * Get the query execution plan
   */
  explainQuery(sql: string): Promise<any>;

  /**
   * Get the scheduler program (compiled instructions)
   */
  explainProgram(sql: string): Promise<Record<string, SqlValue>[]>;

  /**
   * Get execution trace data
   */
  executionTrace(sql: string): Promise<Record<string, SqlValue>[]>;

  /**
   * Get row-level execution trace data
   */
  rowTrace(sql: string): Promise<Record<string, SqlValue>[]>;

  /**
   * Get query plan as a graph structure for visualization
   */
  explainPlanGraph(sql: string, options?: { withActual?: boolean }): Promise<PlanGraph>;

  /**
   * Load a plugin module from a URL
   */
  loadModule(url: string, config?: Record<string, SqlValue>): Promise<PluginManifest | undefined>;

  /**
   * List all tables in the database
   */
  listTables(): Promise<Array<{ name: string; type: string }>>;

  /**
   * Get schema information for a table
   */
  getTableSchema(tableName: string): Promise<any>;

  /**
   * Preview CSV data before import
   */
  previewCsv(csvData: string): Promise<CsvPreview>;

  /**
   * Import CSV data as a table
   */
  importCsv(csvData: string, tableName: string): Promise<{ rowsImported: number }>;

  /**
   * Close the database connection
   */
  close(): Promise<void>;

  // ============================================================================
  // Storage Module Management
  // ============================================================================

  /**
   * Get current storage module type
   */
  getStorageModule(): StorageModuleType;

  /**
   * Set the default storage module
   * Must be called before creating tables that should use the module
   */
  setStorageModule(module: StorageModuleType): Promise<void>;

  /**
   * Get available storage modules
   */
  getAvailableModules(): StorageModuleType[];

  // ============================================================================
  // Sync Operations
  // ============================================================================

  /**
   * Get current sync status
   */
  getSyncStatus(): SyncStatus;

  /**
   * Connect to a sync server
   */
  connectSync(url: string, token?: string): Promise<void>;

  /**
   * Disconnect from sync server
   */
  disconnectSync(): Promise<void>;

  /**
   * Get recent sync events for display
   */
  getSyncEvents(limit?: number): SyncEvent[];

  /**
   * Register a callback for sync events (called via Comlink proxy)
   * Returns an unsubscribe ID
   */
  onSyncEvent(callback: (event: SyncEvent) => void): string;

  /**
   * Unsubscribe from sync events
   */
  offSyncEvent(subscriptionId: string): void;
}

export interface QueryPlan {
  query: string;
  plan: any;
  estimatedCost?: number;
  estimatedRows?: number;
}

export interface TableInfo {
  name: string;
  type: 'table' | 'view' | 'index';
  sql?: string;
  columns?: ColumnInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue?: SqlValue;
  primaryKey: boolean;
}

export interface CsvPreview {
  columns: string[];
  sampleRows: Record<string, any>[];
  totalRows: number;
  errors: string[];
  inferredTypes: Record<string, string>;
}
