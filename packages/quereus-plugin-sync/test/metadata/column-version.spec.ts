/**
 * Tests for ColumnVersionStore.
 */

import { expect } from 'chai';
import { ColumnVersionStore, serializeColumnVersion, deserializeColumnVersion, type ColumnVersion } from '../../src/metadata/column-version.js';
import type { HLC } from '../../src/clock/hlc.js';
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

describe('ColumnVersion', () => {
  describe('serialization', () => {
    it('should round-trip serialize/deserialize', () => {
      const siteId = generateSiteId();
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(Date.now()), counter: 42, siteId },
        value: 'test value',
      };

      const serialized = serializeColumnVersion(version);
      const deserialized = deserializeColumnVersion(serialized);

      expect(deserialized.hlc.wallTime).to.equal(version.hlc.wallTime);
      expect(deserialized.hlc.counter).to.equal(version.hlc.counter);
      expect(deserialized.value).to.equal(version.value);
    });

    it('should handle null values', () => {
      const siteId = generateSiteId();
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(1234567890), counter: 0, siteId },
        value: null,
      };

      const serialized = serializeColumnVersion(version);
      const deserialized = deserializeColumnVersion(serialized);

      expect(deserialized.value).to.be.null;
    });

    it('should handle numeric values', () => {
      const siteId = generateSiteId();
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(1234567890), counter: 0, siteId },
        value: 42.5,
      };

      const serialized = serializeColumnVersion(version);
      const deserialized = deserializeColumnVersion(serialized);

      expect(deserialized.value).to.equal(42.5);
    });
  });

  describe('ColumnVersionStore', () => {
    let store: ColumnVersionStore;
    let kv: MockKVStore;

    beforeEach(() => {
      kv = new MockKVStore();
      store = new ColumnVersionStore(kv as any);
    });

    it('should store and retrieve column versions', async () => {
      const siteId = generateSiteId();
      const version: ColumnVersion = {
        hlc: { wallTime: BigInt(Date.now()), counter: 1, siteId },
        value: 'hello',
      };

      await store.setColumnVersion('main', 'users', [1], 'name', version);
      const retrieved = await store.getColumnVersion('main', 'users', [1], 'name');

      expect(retrieved).to.not.be.undefined;
      expect(retrieved!.value).to.equal('hello');
    });

    it('should return undefined for non-existent versions', async () => {
      const result = await store.getColumnVersion('main', 'users', [999], 'name');
      expect(result).to.be.undefined;
    });

    it('should correctly determine if write should apply (LWW)', async () => {
      const siteId1 = generateSiteId();
      const siteId2 = generateSiteId();

      const olderHLC: HLC = { wallTime: BigInt(1000), counter: 0, siteId: siteId1 };
      const newerHLC: HLC = { wallTime: BigInt(2000), counter: 0, siteId: siteId2 };

      // Store older version
      await store.setColumnVersion('main', 'users', [1], 'name', { hlc: olderHLC, value: 'old' });

      // Newer HLC should apply
      const shouldApplyNewer = await store.shouldApplyWrite('main', 'users', [1], 'name', newerHLC);
      expect(shouldApplyNewer).to.be.true;

      // Older HLC should not apply
      const shouldApplyOlder = await store.shouldApplyWrite('main', 'users', [1], 'name', olderHLC);
      expect(shouldApplyOlder).to.be.false;
    });
  });
});

