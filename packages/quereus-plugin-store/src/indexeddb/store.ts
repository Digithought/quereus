/**
 * IndexedDB-based KVStore implementation for browsers.
 * Uses the native IndexedDB API for persistent storage.
 */

import type { KVStore, KVEntry, WriteBatch, IterateOptions, KVStoreOptions } from '../common/kv-store.js';

const STORE_NAME = 'kv';

/**
 * Convert Uint8Array to ArrayBuffer for use as IDBValidKey.
 */
function toKey(key: Uint8Array): ArrayBuffer {
  // Create a new ArrayBuffer copy to ensure it's a proper ArrayBuffer (not SharedArrayBuffer)
  const copy = new ArrayBuffer(key.byteLength);
  new Uint8Array(copy).set(key);
  return copy;
}

export class IndexedDBStore implements KVStore {
  private db: IDBDatabase;
  private closed = false;

  private constructor(db: IDBDatabase) {
    this.db = db;
  }

  static async open(options: KVStoreOptions): Promise<IndexedDBStore> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(options.path, 1);
      request.onerror = () => reject(new Error('Failed to open IndexedDB'));
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(new IndexedDBStore(request.result));
    });
  }

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    this.checkOpen();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
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
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.put(value, toKey(key));
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
    });
  }

  async delete(key: Uint8Array): Promise<void> {
    this.checkOpen();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      store.delete(toKey(key));
      tx.onerror = () => reject(tx.error);
      tx.oncomplete = () => resolve();
    });
  }

  async has(key: Uint8Array): Promise<boolean> {
    this.checkOpen();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
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
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
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
    return new IndexedDBWriteBatch(this.db);
  }

  async approximateCount(options?: IterateOptions): Promise<number> {
    this.checkOpen();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const range = this.buildKeyRange(options);
      const request = store.count(range);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  private checkOpen(): void {
    if (this.closed) {
      throw new Error('Store is closed');
    }
  }
}

class IndexedDBWriteBatch implements WriteBatch {
  private db: IDBDatabase;
  private ops: Array<{ type: 'put' | 'del'; key: Uint8Array; value?: Uint8Array }> = [];

  constructor(db: IDBDatabase) {
    this.db = db;
  }

  put(key: Uint8Array, value: Uint8Array): void {
    this.ops.push({ type: 'put', key, value });
  }

  delete(key: Uint8Array): void {
    this.ops.push({ type: 'del', key });
  }

  async write(): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
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
