/**
 * Tests for SQLiteStore using better-sqlite3 as a stand-in for NativeScript SQLite.
 */

import { expect } from 'chai';
import { SQLiteStore } from '../src/store.js';
import { createSQLiteProvider } from '../src/provider.js';
import { createTestDatabase } from './better-sqlite3-adapter.js';

describe('SQLiteStore', () => {
  let db: ReturnType<typeof createTestDatabase>;
  let store: SQLiteStore;

  beforeEach(() => {
    db = createTestDatabase();
    store = SQLiteStore.create(db, 'test_kv');
  });

  afterEach(async () => {
    await store.close();
    db.close();
  });

  describe('basic operations', () => {
    it('should put and get a value', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const value = new Uint8Array([4, 5, 6]);

      await store.put(key, value);
      const result = await store.get(key);

      expect(result).to.deep.equal(value);
    });

    it('should return undefined for missing key', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const result = await store.get(key);

      expect(result).to.be.undefined;
    });

    it('should delete a value', async () => {
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

    it('should overwrite existing value', async () => {
      const key = new Uint8Array([1, 2, 3]);
      const value1 = new Uint8Array([4, 5, 6]);
      const value2 = new Uint8Array([7, 8, 9]);

      await store.put(key, value1);
      await store.put(key, value2);
      const result = await store.get(key);

      expect(result).to.deep.equal(value2);
    });
  });

  describe('iteration and ordering', () => {
    beforeEach(async () => {
      // Insert keys in non-sorted order
      await store.put(new Uint8Array([0x03]), new Uint8Array([3]));
      await store.put(new Uint8Array([0x01]), new Uint8Array([1]));
      await store.put(new Uint8Array([0x05]), new Uint8Array([5]));
      await store.put(new Uint8Array([0x02]), new Uint8Array([2]));
      await store.put(new Uint8Array([0x04]), new Uint8Array([4]));
    });

    it('should iterate in sorted order', async () => {
      const entries = [];
      for await (const entry of store.iterate()) {
        entries.push(entry.key[0]);
      }

      expect(entries).to.deep.equal([1, 2, 3, 4, 5]);
    });

    it('should iterate in reverse order', async () => {
      const entries = [];
      for await (const entry of store.iterate({ reverse: true })) {
        entries.push(entry.key[0]);
      }

      expect(entries).to.deep.equal([5, 4, 3, 2, 1]);
    });

    it('should respect gte bound', async () => {
      const entries = [];
      for await (const entry of store.iterate({ gte: new Uint8Array([0x03]) })) {
        entries.push(entry.key[0]);
      }

      expect(entries).to.deep.equal([3, 4, 5]);
    });

    it('should respect lt bound', async () => {
      const entries = [];
      for await (const entry of store.iterate({ lt: new Uint8Array([0x03]) })) {
        entries.push(entry.key[0]);
      }

      expect(entries).to.deep.equal([1, 2]);
    });

    it('should respect gte and lt bounds together', async () => {
      const entries = [];
      for await (const entry of store.iterate({
        gte: new Uint8Array([0x02]),
        lt: new Uint8Array([0x04]),
      })) {
        entries.push(entry.key[0]);
      }

      expect(entries).to.deep.equal([2, 3]);
    });

    it('should respect limit', async () => {
      const entries = [];
      for await (const entry of store.iterate({ limit: 2 })) {
        entries.push(entry.key[0]);
      }

      expect(entries).to.deep.equal([1, 2]);
    });
  });

  describe('batch operations', () => {
    it('should execute batch atomically', async () => {
      const batch = store.batch();
      batch.put(new Uint8Array([1]), new Uint8Array([10]));
      batch.put(new Uint8Array([2]), new Uint8Array([20]));
      batch.put(new Uint8Array([3]), new Uint8Array([30]));
      await batch.write();

      expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
      expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
      expect(await store.get(new Uint8Array([3]))).to.deep.equal(new Uint8Array([30]));
    });

    it('should handle mixed put and delete in batch', async () => {
      await store.put(new Uint8Array([1]), new Uint8Array([10]));
      await store.put(new Uint8Array([2]), new Uint8Array([20]));

      const batch = store.batch();
      batch.delete(new Uint8Array([1]));
      batch.put(new Uint8Array([3]), new Uint8Array([30]));
      await batch.write();

      expect(await store.has(new Uint8Array([1]))).to.be.false;
      expect(await store.has(new Uint8Array([2]))).to.be.true;
      expect(await store.has(new Uint8Array([3]))).to.be.true;
    });
  });
});

describe('createSQLiteProvider', () => {
  let db: ReturnType<typeof createTestDatabase>;

  beforeEach(() => {
    db = createTestDatabase();
  });

  afterEach(() => {
    db.close();
  });

  it('should create a provider that returns SQLiteStore instances', async () => {
    const provider = createSQLiteProvider({ db });
    const store = await provider.getStore('main', 'test_store');

    expect(store).to.be.instanceOf(SQLiteStore);
    await store.close();
  });

  it('should return the same store for the same name', async () => {
    const provider = createSQLiteProvider({ db });
    const store1 = await provider.getStore('main', 'test_store');
    const store2 = await provider.getStore('main', 'test_store');

    expect(store1).to.equal(store2);
    await store1.close();
  });

  it('should return different stores for different names', async () => {
    const provider = createSQLiteProvider({ db });
    const store1 = await provider.getStore('main', 'store_a');
    const store2 = await provider.getStore('main', 'store_b');

    expect(store1).to.not.equal(store2);
    await store1.close();
    await store2.close();
  });

  it('should isolate data between stores', async () => {
    const provider = createSQLiteProvider({ db });
    const store1 = await provider.getStore('main', 'store_a');
    const store2 = await provider.getStore('main', 'store_b');

    const key = new Uint8Array([1, 2, 3]);
    const value = new Uint8Array([4, 5, 6]);

    await store1.put(key, value);

    expect(await store1.get(key)).to.deep.equal(value);
    expect(await store2.get(key)).to.be.undefined;

    await store1.close();
    await store2.close();
  });
});

