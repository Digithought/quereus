import type { SqlValue } from '@quereus/quereus';

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
