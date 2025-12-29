/**
 * Unified IndexedDB Database Manager.
 *
 * Manages a single IndexedDB database with multiple object stores (one per table).
 * This enables cross-table atomic transactions using native IDB transaction support.
 *
 * Architecture:
 *   - Single IDB database (e.g., 'quereus_main')
 *   - One object store per table (e.g., 'users', 'orders')
 *   - One 'catalog' object store for DDL metadata
 *   - Native cross-table transactions for atomicity
 */

import { QuereusError, StatusCode } from '@quereus/quereus';
import type { KVStore, KVEntry, WriteBatch, IterateOptions, KVStoreOptions } from '../common/kv-store.js';

/** Default database name for unified storage. */
const DEFAULT_DATABASE_NAME = 'quereus_unified';

/** Reserved object store for catalog/DDL metadata. */
const CATALOG_STORE_NAME = '__catalog__';



/**
 * Convert Uint8Array to ArrayBuffer for use as IDBValidKey.
 */
function toKey(key: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(key.byteLength);
  new Uint8Array(copy).set(key);
  return copy;
}

/**
 * Singleton manager for a unified IndexedDB database.
 * All tables share this database with separate object stores.
 */
export class UnifiedIndexedDBManager {
  private static instances: Map<string, UnifiedIndexedDBManager> = new Map();

  private dbName: string;
  private db: IDBDatabase | null = null;
  private dbVersion: number = 1;
  private objectStores: Set<string> = new Set();
  private openPromise: Promise<void> | null = null;
  private closed = false;

  private constructor(dbName: string) {
    this.dbName = dbName;
  }

  /**
   * Get or create the singleton manager instance for a database name.
   */
  static getInstance(dbName: string = DEFAULT_DATABASE_NAME): UnifiedIndexedDBManager {
    let instance = this.instances.get(dbName);
    if (!instance) {
      instance = new UnifiedIndexedDBManager(dbName);
      this.instances.set(dbName, instance);
    }
    return instance;
  }

  /**
   * Reset a singleton instance (for testing purposes).
   */
  static resetInstance(dbName: string): void {
    this.instances.delete(dbName);
  }

  /**
   * Get the list of object store names in the database.
   */
  getObjectStoreNames(): string[] {
    return Array.from(this.objectStores);
  }

  /**
   * Ensure the database is open and has the required object stores.
   */
  async ensureOpen(): Promise<IDBDatabase> {
    if (this.closed) {
      throw new QuereusError('UnifiedIndexedDBManager is closed', StatusCode.MISUSE);
    }

    if (this.db) {
      return this.db;
    }

    // Serialize opening to prevent race conditions
    if (this.openPromise) {
      await this.openPromise;
      return this.db!;
    }

    this.openPromise = this.doOpen();
    await this.openPromise;
    this.openPromise = null;
    return this.db!;
  }

  private async doOpen(): Promise<void> {
    // First, try to open the existing database to get its version
    const existingInfo = await this.getExistingDatabaseInfo();

    if (existingInfo) {
      this.dbVersion = existingInfo.version;
      this.objectStores = existingInfo.objectStores;
    }

    // Open with the current version
    this.db = await this.openDatabase(this.dbVersion);
  }

  private async getExistingDatabaseInfo(): Promise<{ version: number; objectStores: Set<string> } | null> {
    return new Promise((resolve) => {
      // Try to open without specifying version to get current state
      const request = indexedDB.open(this.dbName);

      request.onerror = () => resolve(null);

      request.onsuccess = () => {
        const db = request.result;
        const stores = new Set<string>();
        for (let i = 0; i < db.objectStoreNames.length; i++) {
          stores.add(db.objectStoreNames[i]);
        }
        const version = db.version;
        db.close();
        resolve({ version, objectStores: stores });
      };
    });
  }

  private async openDatabase(version: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new QuereusError('IndexedDB open timed out after 10 seconds', StatusCode.CANTOPEN));
      }, 10000);

      const request = indexedDB.open(this.dbName, version);

      request.onerror = () => {
        clearTimeout(timeout);
        reject(new QuereusError(`Failed to open IndexedDB: ${request.error?.message}`, StatusCode.CANTOPEN));
      };

      request.onblocked = () => {
        clearTimeout(timeout);
        reject(new QuereusError('IndexedDB is blocked by another connection', StatusCode.CANTOPEN));
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        // Ensure catalog store exists
        if (!db.objectStoreNames.contains(CATALOG_STORE_NAME)) {
          db.createObjectStore(CATALOG_STORE_NAME);
          this.objectStores.add(CATALOG_STORE_NAME);
        }
      };

      request.onsuccess = () => {
        clearTimeout(timeout);
        const db = request.result;
        // Update objectStores from actual database
        this.objectStores.clear();
        for (let i = 0; i < db.objectStoreNames.length; i++) {
          this.objectStores.add(db.objectStoreNames[i]);
        }
        resolve(db);
      };
    });
  }

  /**
   * Ensure an object store exists for a table.
   * Creates the store via database version upgrade if needed.
   */
  async ensureObjectStore(storeName: string): Promise<void> {
    await this.ensureOpen();

    if (this.objectStores.has(storeName)) {
      return; // Already exists
    }

    // Close current connection and reopen with new version
    this.db?.close();
    this.db = null;
    this.dbVersion++;

    this.db = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new QuereusError('IndexedDB upgrade timed out', StatusCode.CANTOPEN));
      }, 10000);

      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        clearTimeout(timeout);
        reject(new QuereusError(`Failed to upgrade IndexedDB: ${request.error?.message}`, StatusCode.CANTOPEN));
      };

      request.onblocked = () => {
        clearTimeout(timeout);
        reject(new QuereusError('IndexedDB upgrade blocked', StatusCode.CANTOPEN));
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      };

      request.onsuccess = () => {
        clearTimeout(timeout);
        const db = request.result;
        this.objectStores.clear();
        for (let i = 0; i < db.objectStoreNames.length; i++) {
          this.objectStores.add(db.objectStoreNames[i]);
        }
        resolve(db);
      };
    });
  }

  /**
   * Delete an object store (table).
   */
  async deleteObjectStore(storeName: string): Promise<void> {
    await this.ensureOpen();

    if (!this.objectStores.has(storeName)) {
      return; // Doesn't exist
    }

    // Close current connection and reopen with new version
    this.db?.close();
    this.db = null;
    this.dbVersion++;

    this.db = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new QuereusError('IndexedDB upgrade timed out', StatusCode.CANTOPEN));
      }, 10000);

      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onerror = () => {
        clearTimeout(timeout);
        reject(new QuereusError(`Failed to upgrade IndexedDB: ${request.error?.message}`, StatusCode.CANTOPEN));
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (db.objectStoreNames.contains(storeName)) {
          db.deleteObjectStore(storeName);
        }
      };

      request.onsuccess = () => {
        clearTimeout(timeout);
        const db = request.result;
        this.objectStores.clear();
        for (let i = 0; i < db.objectStoreNames.length; i++) {
          this.objectStores.add(db.objectStoreNames[i]);
        }
        resolve(db);
      };
    });
  }

  /**
   * Check if an object store exists.
   */
  hasObjectStore(storeName: string): boolean {
    return this.objectStores.has(storeName);
  }

  /**
   * Get the underlying IDBDatabase for direct transaction creation.
   */
  getDatabase(): IDBDatabase | null {
    return this.db;
  }

  /**
   * Get the catalog store name.
   */
  getCatalogStoreName(): string {
    return CATALOG_STORE_NAME;
  }

  /**
   * Create a read-write transaction spanning multiple object stores.
   * This enables atomic cross-table operations.
   */
  createTransaction(storeNames: string[], mode: IDBTransactionMode = 'readwrite'): IDBTransaction {
    if (!this.db) {
      throw new QuereusError('Database not open', StatusCode.MISUSE);
    }
    return this.db.transaction(storeNames, mode);
  }

  /**
   * Close the database and clean up.
   */
  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.closed = true;
    UnifiedIndexedDBManager.instances.delete(this.dbName);
  }

  /**
   * Delete the entire database (for testing or reset).
   */
  static async deleteDatabase(dbName: string = DEFAULT_DATABASE_NAME): Promise<void> {
    const instance = this.instances.get(dbName);
    if (instance) {
      await instance.close();
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(dbName);
      request.onerror = () => reject(new QuereusError('Failed to delete database', StatusCode.ERROR));
      request.onsuccess = () => resolve();
    });
  }
}

/**
 * KVStore implementation that uses an object store within the unified database.
 * Implements the same interface as IndexedDBStore but shares the database.
 */
export class UnifiedIndexedDBStore implements KVStore {
  private manager: UnifiedIndexedDBManager;
  private storeName: string;
  private closed = false;

  private constructor(manager: UnifiedIndexedDBManager, storeName: string) {
    this.manager = manager;
    this.storeName = storeName;
  }

  /**
   * Open or create a store within the unified database.
   */
  static async open(options: KVStoreOptions): Promise<UnifiedIndexedDBStore> {
    const manager = UnifiedIndexedDBManager.getInstance(options.path);
    await manager.ensureOpen();

    // storeName should come from the table key (e.g., 'main.users')
    // For now we default to 'kv' for compatibility
    const storeName = (options as UnifiedKVStoreOptions).storeName || CATALOG_STORE_NAME;
    await manager.ensureObjectStore(storeName);

    return new UnifiedIndexedDBStore(manager, storeName);
  }

  /**
   * Create a store for a specific table within the unified database.
   */
  static async openForTable(
    dbName: string,
    tableKey: string
  ): Promise<UnifiedIndexedDBStore> {
    const manager = UnifiedIndexedDBManager.getInstance(dbName);
    await manager.ensureObjectStore(tableKey);
    return new UnifiedIndexedDBStore(manager, tableKey);
  }

  /**
   * Get the underlying manager for cross-table transactions.
   */
  getManager(): UnifiedIndexedDBManager {
    return this.manager;
  }

  /**
   * Get the object store name.
   */
  getStoreName(): string {
    return this.storeName;
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.checkOpen();
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.get(toKey(key));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const result = request.result;
        resolve(result === undefined ? undefined : new Uint8Array(result));
      };
    });
  }

  async put(key: Uint8Array, value: Uint8Array): Promise<void> {
    this.checkOpen();
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      store.put(value, toKey(key));
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
    });
  }

  async delete(key: Uint8Array): Promise<void> {
    this.checkOpen();
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      store.delete(toKey(key));
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
    });
  }

  async has(key: Uint8Array): Promise<boolean> {
    this.checkOpen();
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const request = store.count(toKey(key));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result > 0);
    });
  }

  async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
    this.checkOpen();
    const entries = await this.collectEntries(options);
    for (const entry of entries) {
      yield entry;
    }
  }

  private async collectEntries(options?: IterateOptions): Promise<KVEntry[]> {
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const range = this.buildKeyRange(options);
      const direction = options?.reverse ? 'prev' : 'next';
      const request = store.openCursor(range, direction);
      const entries: KVEntry[] = [];
      const limit = options?.limit;

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor && (limit === undefined || entries.length < limit)) {
          entries.push({
            key: new Uint8Array(cursor.key as ArrayBuffer),
            value: new Uint8Array(cursor.value as ArrayBuffer),
          });
          cursor.continue();
        } else {
          resolve(entries);
        }
      };
    });
  }

  private buildKeyRange(options?: IterateOptions): IDBKeyRange | undefined {
    if (options?.gte && options?.lt) {
      return IDBKeyRange.bound(toKey(options.gte), toKey(options.lt), false, true);
    } else if (options?.gte && options?.lte) {
      return IDBKeyRange.bound(toKey(options.gte), toKey(options.lte), false, false);
    } else if (options?.gt && options?.lt) {
      return IDBKeyRange.bound(toKey(options.gt), toKey(options.lt), true, true);
    } else if (options?.gt && options?.lte) {
      return IDBKeyRange.bound(toKey(options.gt), toKey(options.lte), true, false);
    } else if (options?.gte) {
      return IDBKeyRange.lowerBound(toKey(options.gte), false);
    } else if (options?.gt) {
      return IDBKeyRange.lowerBound(toKey(options.gt), true);
    } else if (options?.lte) {
      return IDBKeyRange.upperBound(toKey(options.lte), false);
    } else if (options?.lt) {
      return IDBKeyRange.upperBound(toKey(options.lt), true);
    }
    return undefined;
  }

  batch(): WriteBatch {
    this.checkOpen();
    return new UnifiedWriteBatch(this.manager, this.storeName);
  }

  async approximateCount(options?: IterateOptions): Promise<number> {
    this.checkOpen();
    const db = await this.manager.ensureOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const range = this.buildKeyRange(options);
      const request = store.count(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async close(): Promise<void> {
    // Individual stores don't close the shared database
    this.closed = true;
  }

  private checkOpen(): void {
    if (this.closed) {
      throw new QuereusError('Store is closed', StatusCode.MISUSE);
    }
  }
}

/**
 * Extended options for unified store.
 */
export interface UnifiedKVStoreOptions extends KVStoreOptions {
  storeName?: string;
}

/**
 * Write batch for unified database - can span multiple object stores.
 */
class UnifiedWriteBatch implements WriteBatch {
  private manager: UnifiedIndexedDBManager;
  private storeName: string;
  private ops: Array<{ type: 'put' | 'del'; key: Uint8Array; value?: Uint8Array }> = [];

  constructor(manager: UnifiedIndexedDBManager, storeName: string) {
    this.manager = manager;
    this.storeName = storeName;
  }

  put(key: Uint8Array, value: Uint8Array): void {
    this.ops.push({ type: 'put', key, value });
  }

  delete(key: Uint8Array): void {
    this.ops.push({ type: 'del', key });
  }

  async write(): Promise<void> {
    const db = this.manager.getDatabase();
    if (!db) {
      throw new QuereusError('Database not open', StatusCode.MISUSE);
    }

    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      for (const op of this.ops) {
        if (op.type === 'put' && op.value) {
          store.put(op.value, toKey(op.key));
        } else if (op.type === 'del') {
          store.delete(toKey(op.key));
        }
      }
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
    });
  }

  clear(): void {
    this.ops = [];
  }
}

/**
 * Multi-store write batch for cross-table atomic transactions.
 * Collects operations across multiple object stores and commits them atomically.
 */
export class MultiStoreWriteBatch implements WriteBatch {
  private manager: UnifiedIndexedDBManager;
  private ops: Array<{ storeName: string; type: 'put' | 'del'; key: Uint8Array; value?: Uint8Array }> = [];
  private storeNames: Set<string> = new Set();

  constructor(manager: UnifiedIndexedDBManager) {
    this.manager = manager;
  }

  /**
   * Queue a put operation for a specific store.
   */
  putToStore(storeName: string, key: Uint8Array, value: Uint8Array): void {
    this.ops.push({ storeName, type: 'put', key, value });
    this.storeNames.add(storeName);
  }

  /**
   * Queue a delete operation for a specific store.
   */
  deleteFromStore(storeName: string, key: Uint8Array): void {
    this.ops.push({ storeName, type: 'del', key });
    this.storeNames.add(storeName);
  }

  // Standard WriteBatch interface - not useful for multi-store but required
  put(_key: Uint8Array, _value: Uint8Array): void {
    throw new QuereusError('Use putToStore() for MultiStoreWriteBatch', StatusCode.MISUSE);
  }

  delete(_key: Uint8Array): void {
    throw new QuereusError('Use deleteFromStore() for MultiStoreWriteBatch', StatusCode.MISUSE);
  }

  /**
   * Write all operations atomically across all affected stores.
   */
  async write(): Promise<void> {
    const db = this.manager.getDatabase();
    if (!db) {
      throw new QuereusError('Database not open', StatusCode.MISUSE);
    }

    if (this.ops.length === 0) {
      return;
    }

    const storeNames = Array.from(this.storeNames);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, 'readwrite');

      for (const op of this.ops) {
        const store = tx.objectStore(op.storeName);
        if (op.type === 'put' && op.value) {
          store.put(op.value, toKey(op.key));
        } else if (op.type === 'del') {
          store.delete(toKey(op.key));
        }
      }

      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
    });
  }

  clear(): void {
    this.ops = [];
    this.storeNames.clear();
  }

  /**
   * Get the store names involved in this batch.
   */
  getStoreNames(): string[] {
    return Array.from(this.storeNames);
  }
}

