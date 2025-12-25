/**
 * Abstract key-value store interface.
 * Implemented by LevelDBStore (Node.js) and IndexedDBStore (browser).
 */

/**
 * Options for iterating over key-value pairs.
 */
export interface IterateOptions {
  /** Start key (inclusive). If omitted, starts from beginning. */
  gte?: Uint8Array;
  /** Start key (exclusive). */
  gt?: Uint8Array;
  /** End key (inclusive). */
  lte?: Uint8Array;
  /** End key (exclusive). If omitted, iterates to end. */
  lt?: Uint8Array;
  /** Iterate in reverse order. */
  reverse?: boolean;
  /** Maximum number of entries to return. */
  limit?: number;
}

/**
 * A key-value pair from iteration.
 */
export interface KVEntry {
  key: Uint8Array;
  value: Uint8Array;
}

/**
 * Batch operation types.
 */
export type BatchOp =
  | { type: 'put'; key: Uint8Array; value: Uint8Array }
  | { type: 'delete'; key: Uint8Array };

/**
 * Write batch for atomic operations.
 */
export interface WriteBatch {
  /** Queue a put operation. */
  put(key: Uint8Array, value: Uint8Array): void;
  /** Queue a delete operation. */
  delete(key: Uint8Array): void;
  /** Execute all queued operations atomically. */
  write(): Promise<void>;
  /** Discard all queued operations. */
  clear(): void;
}

/**
 * Abstract key-value store interface.
 * Provides sorted key-value storage with range iteration support.
 */
export interface KVStore {
  /**
   * Get a value by key.
   * @returns The value, or undefined if not found.
   */
  get(key: Uint8Array): Promise<Uint8Array | undefined>;

  /**
   * Put a key-value pair.
   */
  put(key: Uint8Array, value: Uint8Array): Promise<void>;

  /**
   * Delete a key.
   */
  delete(key: Uint8Array): Promise<void>;

  /**
   * Check if a key exists.
   */
  has(key: Uint8Array): Promise<boolean>;

  /**
   * Iterate over key-value pairs in sorted order.
   * Keys are compared lexicographically by bytes.
   */
  iterate(options?: IterateOptions): AsyncIterable<KVEntry>;

  /**
   * Create a write batch for atomic operations.
   */
  batch(): WriteBatch;

  /**
   * Close the store and release resources.
   */
  close(): Promise<void>;

  /**
   * Get approximate number of keys in a range.
   * Used for query planning cost estimation.
   */
  approximateCount(options?: IterateOptions): Promise<number>;
}

/**
 * Factory function to open a KVStore.
 */
export type KVStoreFactory = (options: KVStoreOptions) => Promise<KVStore>;

/**
 * Options for opening a KVStore.
 */
export interface KVStoreOptions {
  /** Storage path (LevelDB) or database name (IndexedDB). */
  path: string;
  /** Create if doesn't exist. Default: true. */
  createIfMissing?: boolean;
  /** Throw error if already exists. Default: false. */
  errorIfExists?: boolean;
}

