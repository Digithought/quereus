/**
 * Tests for unified IndexedDB architecture using fake-indexeddb.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import {
  UnifiedIndexedDBManager,
  UnifiedIndexedDBStore,
  MultiStoreWriteBatch,
} from '../src/indexeddb/unified-database.js';

describe('UnifiedIndexedDBManager', () => {
  const testDbName = 'test-unified-db';

  afterEach(async () => {
    // Clean up: close and delete the database
    const manager = UnifiedIndexedDBManager.getInstance(testDbName);
    await manager.close();
    UnifiedIndexedDBManager.resetInstance(testDbName);

    // Delete the database
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(testDbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });

  describe('Singleton behavior', () => {
    it('should return the same instance for the same database name', () => {
      const manager1 = UnifiedIndexedDBManager.getInstance(testDbName);
      const manager2 = UnifiedIndexedDBManager.getInstance(testDbName);
      expect(manager1).to.equal(manager2);
    });

    it('should return different instances for different database names', () => {
      const manager1 = UnifiedIndexedDBManager.getInstance('db1');
      const manager2 = UnifiedIndexedDBManager.getInstance('db2');
      expect(manager1).to.not.equal(manager2);

      // Cleanup
      manager1.close();
      manager2.close();
      UnifiedIndexedDBManager.resetInstance('db1');
      UnifiedIndexedDBManager.resetInstance('db2');
    });
  });

  describe('Object store management', () => {
    it('should create object stores on demand', async () => {
      const manager = UnifiedIndexedDBManager.getInstance(testDbName);
      await manager.ensureObjectStore('store1');
      await manager.ensureObjectStore('store2');

      const stores = manager.getObjectStoreNames();
      expect(stores).to.include('store1');
      expect(stores).to.include('store2');
    });

    it('should not duplicate existing object stores', async () => {
      const manager = UnifiedIndexedDBManager.getInstance(testDbName);
      await manager.ensureObjectStore('store1');
      await manager.ensureObjectStore('store1'); // Second call should be no-op

      const stores = manager.getObjectStoreNames();
      expect(stores.filter(s => s === 'store1')).to.have.length(1);
    });

    it('should delete object stores', async () => {
      const manager = UnifiedIndexedDBManager.getInstance(testDbName);
      await manager.ensureObjectStore('store1');
      await manager.ensureObjectStore('store2');

      await manager.deleteObjectStore('store1');

      const stores = manager.getObjectStoreNames();
      expect(stores).to.not.include('store1');
      expect(stores).to.include('store2');
    });
  });
});

describe('UnifiedIndexedDBStore', () => {
  const testDbName = 'test-store-db';
  const storeName = 'test-store';
  let store: UnifiedIndexedDBStore;

  beforeEach(async () => {
    const manager = UnifiedIndexedDBManager.getInstance(testDbName);
    await manager.ensureObjectStore(storeName);
    store = await UnifiedIndexedDBStore.openForTable(testDbName, storeName);
  });

  afterEach(async () => {
    await store.close();
    const manager = UnifiedIndexedDBManager.getInstance(testDbName);
    await manager.close();
    UnifiedIndexedDBManager.resetInstance(testDbName);

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(testDbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });

  describe('Basic operations', () => {
    it('should put and get a value', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const value = new Uint8Array([4, 5, 6]);

      await store.put(key, value);
      const result = await store.get(key);

      expect(result).to.deep.equal(value);
    });

    it('should return undefined for non-existent key', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const result = await store.get(key);
      expect(result).to.be.undefined;
    });

    it('should delete a key', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const value = new Uint8Array([4, 5, 6]);

      await store.put(key, value);
      await store.delete(key);
      const result = await store.get(key);

      expect(result).to.be.undefined;
    });

    it('should check if key exists with has()', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const value = new Uint8Array([4, 5, 6]);

      expect(await store.has(key)).to.be.false;
      await store.put(key, value);
      expect(await store.has(key)).to.be.true;
    });

    it('should overwrite existing values', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const value1 = new Uint8Array([4, 5, 6]);
      const value2 = new Uint8Array([7, 8, 9]);

      await store.put(key, value1);
      await store.put(key, value2);
      const result = await store.get(key);

      expect(result).to.deep.equal(value2);
    });
  });

  describe('Iteration', () => {
    beforeEach(async () => {
      // Insert some test data in sorted order
      await store.put(new Uint8Array([1]), new Uint8Array([10]));
      await store.put(new Uint8Array([2]), new Uint8Array([20]));
      await store.put(new Uint8Array([3]), new Uint8Array([30]));
      await store.put(new Uint8Array([4]), new Uint8Array([40]));
      await store.put(new Uint8Array([5]), new Uint8Array([50]));
    });

    it('should iterate all entries in order', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate({})) {
        entries.push(entry);
      }

      expect(entries).to.have.length(5);
      expect(entries[0].key).to.deep.equal(new Uint8Array([1]));
      expect(entries[4].key).to.deep.equal(new Uint8Array([5]));
    });

    it('should iterate with gte bound', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate({ gte: new Uint8Array([3]) })) {
        entries.push(entry);
      }

      expect(entries).to.have.length(3);
      expect(entries[0].key).to.deep.equal(new Uint8Array([3]));
    });

    it('should iterate with lt bound', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate({ lt: new Uint8Array([3]) })) {
        entries.push(entry);
      }

      expect(entries).to.have.length(2);
      expect(entries[1].key).to.deep.equal(new Uint8Array([2]));
    });

    it('should iterate in reverse', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate({ reverse: true })) {
        entries.push(entry);
      }

      expect(entries).to.have.length(5);
      expect(entries[0].key).to.deep.equal(new Uint8Array([5]));
      expect(entries[4].key).to.deep.equal(new Uint8Array([1]));
    });

    it('should respect limit', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate({ limit: 2 })) {
        entries.push(entry);
      }

      expect(entries).to.have.length(2);
    });
  });

  describe('Batch operations', () => {
    it('should execute batch put operations', async () => {
      const batch = store.batch();
      batch.put(new Uint8Array([1]), new Uint8Array([10]));
      batch.put(new Uint8Array([2]), new Uint8Array([20]));
      batch.put(new Uint8Array([3]), new Uint8Array([30]));
      await batch.write();

      expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
      expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
      expect(await store.get(new Uint8Array([3]))).to.deep.equal(new Uint8Array([30]));
    });

    it('should execute batch delete operations', async () => {
      await store.put(new Uint8Array([1]), new Uint8Array([10]));
      await store.put(new Uint8Array([2]), new Uint8Array([20]));

      const batch = store.batch();
      batch.delete(new Uint8Array([1]));
      await batch.write();

      expect(await store.get(new Uint8Array([1]))).to.be.undefined;
      expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
    });
  });
});

describe('MultiStoreWriteBatch', () => {
  const testDbName = 'test-multi-store-db';
  let manager: UnifiedIndexedDBManager;

  beforeEach(async () => {
    manager = UnifiedIndexedDBManager.getInstance(testDbName);
    await manager.ensureObjectStore('store1');
    await manager.ensureObjectStore('store2');
  });

  afterEach(async () => {
    await manager.close();
    UnifiedIndexedDBManager.resetInstance(testDbName);

    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase(testDbName);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  });

  it('should write atomically across multiple stores', async () => {
    const batch = new MultiStoreWriteBatch(manager);
    batch.putToStore('store1', new Uint8Array([1]), new Uint8Array([10]));
    batch.putToStore('store2', new Uint8Array([2]), new Uint8Array([20]));
    await batch.write();

    // Verify both stores have data
    const store1 = await UnifiedIndexedDBStore.openForTable(testDbName, 'store1');
    const store2 = await UnifiedIndexedDBStore.openForTable(testDbName, 'store2');

    expect(await store1.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
    expect(await store2.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));

    await store1.close();
    await store2.close();
  });

  it('should support mixed put and delete operations', async () => {
    // Pre-populate
    const store1 = await UnifiedIndexedDBStore.openForTable(testDbName, 'store1');
    await store1.put(new Uint8Array([1]), new Uint8Array([10]));
    await store1.close();

    // Batch with mixed operations
    const batch = new MultiStoreWriteBatch(manager);
    batch.deleteFromStore('store1', new Uint8Array([1]));
    batch.putToStore('store2', new Uint8Array([2]), new Uint8Array([20]));
    await batch.write();

    // Verify
    const s1 = await UnifiedIndexedDBStore.openForTable(testDbName, 'store1');
    const s2 = await UnifiedIndexedDBStore.openForTable(testDbName, 'store2');

    expect(await s1.get(new Uint8Array([1]))).to.be.undefined;
    expect(await s2.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));

    await s1.close();
    await s2.close();
  });
});

