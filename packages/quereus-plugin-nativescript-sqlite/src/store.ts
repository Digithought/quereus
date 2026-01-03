/**
 * SQLite-based KVStore implementation for NativeScript.
 *
 * Uses @nativescript-community/sqlite for SQLite bindings on iOS/Android.
 * Keys and values are stored as BLOBs for correct lexicographic ordering.
 */

import type { KVStore, KVEntry, WriteBatch, IterateOptions } from '@quereus/store';

/**
 * Type definition for @nativescript-community/sqlite database.
 * We use a minimal interface to avoid hard dependency on the package types.
 */
export interface SQLiteDatabase {
  execute(sql: string, params?: unknown[]): void;
  select(sql: string, params?: unknown[]): unknown[];
  transaction<T>(fn: (cancelTransaction: () => void) => T): T;
  close(): void;
}

/**
 * Options for opening a SQLite store.
 */
export interface SQLiteStoreOptions {
  /** The SQLite database instance. */
  db: SQLiteDatabase;
  /** Table name for this KV store. Default: 'kv' */
  tableName?: string;
}

/**
 * SQLite implementation of KVStore for NativeScript.
 *
 * Keys and values are stored as BLOBs. SQLite compares BLOBs using memcmp(),
 * which provides correct lexicographic byte ordering for range scans.
 */
export class SQLiteStore implements KVStore {
  private db: SQLiteDatabase;
  private tableName: string;
  private closed = false;

  // Prepared SQL statements (built once)
  private readonly sqlGet: string;
  private readonly sqlPut: string;
  private readonly sqlDelete: string;
  private readonly sqlHas: string;

  constructor(options: SQLiteStoreOptions) {
    this.db = options.db;
    this.tableName = options.tableName ?? 'kv';

    // Pre-build SQL statements
    this.sqlGet = `select value from ${this.tableName} where key = ?`;
    this.sqlPut = `insert or replace into ${this.tableName} (key, value) values (?, ?)`;
    this.sqlDelete = `delete from ${this.tableName} where key = ?`;
    this.sqlHas = `select 1 from ${this.tableName} where key = ? limit 1`;

    // Create table if it doesn't exist
    this.ensureTable();
  }

  /**
   * Create a SQLiteStore with a new table in the given database.
   */
  static create(db: SQLiteDatabase, tableName: string = 'kv'): SQLiteStore {
    return new SQLiteStore({ db, tableName });
  }

  private ensureTable(): void {
    // Use WITHOUT ROWID for better key-value performance
    // Keys are BLOBs - SQLite uses memcmp() for correct byte ordering
    this.db.execute(`
      create table if not exists ${this.tableName} (
        key blob primary key,
        value blob
      ) without rowid
    `);
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.checkOpen();
    const rows = this.db.select(this.sqlGet, [toArrayBuffer(key)]) as Array<{ value: ArrayBuffer | null }>;

    if (rows.length === 0 || rows[0].value === null) {
      return undefined;
    }

    return toUint8Array(rows[0].value);
  }

  async put(key: Uint8Array, value: Uint8Array): Promise<void> {
    this.checkOpen();
    this.db.execute(this.sqlPut, [toArrayBuffer(key), toArrayBuffer(value)]);
  }

  async delete(key: Uint8Array): Promise<void> {
    this.checkOpen();
    this.db.execute(this.sqlDelete, [toArrayBuffer(key)]);
  }

  async has(key: Uint8Array): Promise<boolean> {
    this.checkOpen();
    const rows = this.db.select(this.sqlHas, [toArrayBuffer(key)]);
    return rows.length > 0;
  }

  async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
    this.checkOpen();

    const { sql, params } = this.buildIterateQuery(options);
    const rows = this.db.select(sql, params) as Array<{ key: ArrayBuffer; value: ArrayBuffer }>;

    for (const row of rows) {
      yield {
        key: toUint8Array(row.key),
        value: toUint8Array(row.value),
      };
    }
  }

  private buildIterateQuery(options?: IterateOptions): { sql: string; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.gte) {
      conditions.push('key >= ?');
      params.push(toArrayBuffer(options.gte));
    }
    if (options?.gt) {
      conditions.push('key > ?');
      params.push(toArrayBuffer(options.gt));
    }
    if (options?.lte) {
      conditions.push('key <= ?');
      params.push(toArrayBuffer(options.lte));
    }
    if (options?.lt) {
      conditions.push('key < ?');
      params.push(toArrayBuffer(options.lt));
    }

    let sql = `select key, value from ${this.tableName}`;
    if (conditions.length > 0) {
      sql += ` where ${conditions.join(' and ')}`;
    }
    sql += ` order by key ${options?.reverse ? 'desc' : 'asc'}`;
    if (options?.limit !== undefined) {
      sql += ` limit ${options.limit}`;
    }

    return { sql, params };
  }

  batch(): WriteBatch {
    this.checkOpen();
    return new SQLiteWriteBatch(this);
  }

  async close(): Promise<void> {
    // Mark as closed but don't close the DB - it may be shared
    this.closed = true;
  }

  async approximateCount(options?: IterateOptions): Promise<number> {
    this.checkOpen();

    if (!options?.gte && !options?.gt && !options?.lte && !options?.lt) {
      // Fast path: count all rows
      const rows = this.db.select(`select count(*) as cnt from ${this.tableName}`, []) as Array<{ cnt: number }>;
      return rows[0]?.cnt ?? 0;
    }

    // With bounds, we need to count with conditions
    const { sql, params } = this.buildIterateQuery(options);
    const countSql = sql.replace(/^select key, value/, 'select count(*) as cnt').replace(/ order by.*$/, '');
    const rows = this.db.select(countSql, params) as Array<{ cnt: number }>;
    return rows[0]?.cnt ?? 0;
  }

  private checkOpen(): void {
    if (this.closed) {
      throw new Error('SQLiteStore is closed');
    }
  }

  /**
   * Execute a batch of operations atomically.
   * Called by SQLiteWriteBatch.
   */
  executeBatch(ops: Array<{ type: 'put'; key: Uint8Array; value: Uint8Array } | { type: 'delete'; key: Uint8Array }>): void {
    this.checkOpen();

    this.db.transaction(() => {
      for (const op of ops) {
        if (op.type === 'put') {
          this.db.execute(this.sqlPut, [toArrayBuffer(op.key), toArrayBuffer(op.value)]);
        } else {
          this.db.execute(this.sqlDelete, [toArrayBuffer(op.key)]);
        }
      }
    });
  }
}

/**
 * WriteBatch implementation for SQLite.
 */
class SQLiteWriteBatch implements WriteBatch {
  private store: SQLiteStore;
  private ops: Array<{ type: 'put'; key: Uint8Array; value: Uint8Array } | { type: 'delete'; key: Uint8Array }> = [];

  constructor(store: SQLiteStore) {
    this.store = store;
  }

  put(key: Uint8Array, value: Uint8Array): void {
    this.ops.push({ type: 'put', key, value });
  }

  delete(key: Uint8Array): void {
    this.ops.push({ type: 'delete', key });
  }

  async write(): Promise<void> {
    if (this.ops.length > 0) {
      this.store.executeBatch(this.ops);
      this.ops = [];
    }
  }

  clear(): void {
    this.ops = [];
  }
}

// ============================================================================
// Binary conversion utilities
// ============================================================================

/**
 * Convert Uint8Array to ArrayBuffer for SQLite BLOB binding.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Create a new ArrayBuffer copy to handle views into SharedArrayBuffer
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

/**
 * Convert ArrayBuffer or Uint8Array to Uint8Array.
 */
function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  if (data instanceof Uint8Array) {
    return data;
  }
  return new Uint8Array(data);
}

