/**
 * Tests for IndexedDB store implementation using fake-indexeddb.
 */

import { expect } from 'chai';
import 'fake-indexeddb/auto';
import { IndexedDBStore } from '../src/store.js';
import { IndexedDBManager } from '../src/manager.js';

describe('IndexedDBStore', () => {
  const testDbName = 'test-store-db';
  const storeName = 'test-store';
  let store: IndexedDBStore;

  beforeEach(async () => {
    const manager = IndexedDBManager.getInstance(testDbName);
    await manager.ensureObjectStore(storeName);
    store = await IndexedDBStore.openForTable(testDbName, storeName);
  });

  afterEach(async () => {
    await store.close();
    const manager = IndexedDBManager.getInstance(testDbName);
    await manager.close();
    IndexedDBManager.resetInstance(testDbName);

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

    it('should iterate in reverse', async () => {
      const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
      for await (const entry of store.iterate({ reverse: true })) {
        entries.push(entry);
      }

      expect(entries).to.have.length(5);
      expect(entries[0].key).to.deep.equal(new Uint8Array([5]));
      expect(entries[4].key).to.deep.equal(new Uint8Array([1]));
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
  });
});

