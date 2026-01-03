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

/**
 * Provider interface for creating/getting KVStore instances.
 *
 * This abstraction allows different storage backends (LevelDB, IndexedDB,
 * React Native AsyncStorage, etc.) to be used with the StoreModule.
 *
 * Implementations should manage store lifecycle and caching.
 */
export interface KVStoreProvider {
  /**
   * Get or create a KVStore for a table.
   * @param schemaName - The schema name (e.g., 'main')
   * @param tableName - The table name
   * @param options - Additional options passed from CREATE TABLE
   * @returns The KVStore instance
   */
  getStore(schemaName: string, tableName: string, options?: Record<string, unknown>): Promise<KVStore>;

  /**
   * Get or create a KVStore for catalog/DDL metadata.
   * Some providers may use the same store as data, others may use a separate store.
   * @returns The KVStore instance for catalog data
   */
  getCatalogStore(): Promise<KVStore>;

  /**
   * Close a specific store.
   * @param schemaName - The schema name
   * @param tableName - The table name
   */
  closeStore(schemaName: string, tableName: string): Promise<void>;

  /**
   * Close all stores managed by this provider.
   */
  closeAll(): Promise<void>;

  /**
   * Optional: Called when a store is first accessed to perform any setup.
   * @param store - The store that was just opened
   * @param schemaName - The schema name
   * @param tableName - The table name
   */
  onStoreOpened?(store: KVStore, schemaName: string, tableName: string): void;
}

