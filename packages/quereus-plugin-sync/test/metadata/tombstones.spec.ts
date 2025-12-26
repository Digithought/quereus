/**
 * Tests for TombstoneStore.
 */

import { expect } from 'chai';
import { TombstoneStore, serializeTombstone, deserializeTombstone, type Tombstone } from '../../src/metadata/tombstones.js';
import { type HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';

// Mock KVStore for testing
class MockKVStore {
  private data = new Map<string, Uint8Array>();

  async get(key: Uint8Array): Promise<Uint8Array | undefined> {
    return this.data.get(this.keyToString(key));
  }

  async put(key: Uint8Array, value: Uint8Array): Promise<void> {
    this.data.set(this.keyToString(key), value);
  }

  async delete(key: Uint8Array): Promise<void> {
    this.data.delete(this.keyToString(key));
  }

  async *iterate(options?: { gte?: Uint8Array; lt?: Uint8Array }): AsyncIterable<{ key: Uint8Array; value: Uint8Array }> {
    const entries = Array.from(this.data.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    for (const [keyStr, value] of entries) {
      const key = new TextEncoder().encode(keyStr);
      if (options?.gte && this.keyToString(key) < this.keyToString(options.gte)) continue;
      if (options?.lt && this.keyToString(key) >= this.keyToString(options.lt)) continue;
      yield { key, value };
    }
  }

  batch() {
    const ops: Array<{ type: 'put' | 'delete'; key: Uint8Array; value?: Uint8Array }> = [];
    return {
      put: (key: Uint8Array, value: Uint8Array) => ops.push({ type: 'put', key, value }),
      delete: (key: Uint8Array) => ops.push({ type: 'delete', key }),
      commit: async () => {
        for (const op of ops) {
          if (op.type === 'put') await this.put(op.key, op.value!);
          else await this.delete(op.key);
        }
      },
    };
  }

  private keyToString(key: Uint8Array): string {
    return new TextDecoder().decode(key);
  }
}

describe('Tombstone', () => {
  describe('serialization', () => {
    it('should round-trip serialize/deserialize', () => {
      const siteId = generateSiteId();
      const tombstone: Tombstone = {
        hlc: { wallTime: BigInt(Date.now()), counter: 42, siteId },
        deletedAt: Date.now(),
      };

      const serialized = serializeTombstone(tombstone);
      const deserialized = deserializeTombstone(serialized);

      expect(deserialized.hlc.wallTime).to.equal(tombstone.hlc.wallTime);
      expect(deserialized.hlc.counter).to.equal(tombstone.hlc.counter);
      expect(deserialized.deletedAt).to.equal(tombstone.deletedAt);
    });
  });

  describe('TombstoneStore', () => {
    let store: TombstoneStore;
    let kv: MockKVStore;
    const TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

    beforeEach(() => {
      kv = new MockKVStore();
      store = new TombstoneStore(kv as any, TTL);
    });

    it('should store and retrieve tombstones', async () => {
      const siteId = generateSiteId();
      const hlc: HLC = { wallTime: BigInt(Date.now()), counter: 1, siteId };

      await store.setTombstone('main', 'users', [1], hlc);
      const retrieved = await store.getTombstone('main', 'users', [1]);

      expect(retrieved).to.not.be.undefined;
      expect(retrieved!.hlc.counter).to.equal(1);
    });

    it('should return undefined for non-existent tombstones', async () => {
      const result = await store.getTombstone('main', 'users', [999]);
      expect(result).to.be.undefined;
    });

    it('should block writes when tombstone exists and resurrection not allowed', async () => {
      const siteId = generateSiteId();
      const deleteHLC: HLC = { wallTime: BigInt(2000), counter: 0, siteId };
      const writeHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId };

      await store.setTombstone('main', 'users', [1], deleteHLC);

      // Write with older HLC should be blocked
      const isBlocked = await store.isDeletedAndBlocking('main', 'users', [1], writeHLC, false);
      expect(isBlocked).to.be.true;
    });

    it('should allow resurrection when enabled', async () => {
      const siteId = generateSiteId();
      const deleteHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId };
      const writeHLC: HLC = { wallTime: BigInt(2000), counter: 0, siteId };

      await store.setTombstone('main', 'users', [1], deleteHLC);

      // Write with newer HLC should not be blocked when resurrection allowed
      const isBlocked = await store.isDeletedAndBlocking('main', 'users', [1], writeHLC, true);
      expect(isBlocked).to.be.false;
    });

    it('should not block when no tombstone exists', async () => {
      const siteId = generateSiteId();
      const writeHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId };

      const isBlocked = await store.isDeletedAndBlocking('main', 'users', [1], writeHLC, false);
      expect(isBlocked).to.be.false;
    });
  });
});

