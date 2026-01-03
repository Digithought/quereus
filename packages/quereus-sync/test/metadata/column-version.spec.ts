/**
 * Tests for ColumnVersionStore.
 */

import { expect } from 'chai';
import { ColumnVersionStore, serializeColumnVersion, deserializeColumnVersion, type ColumnVersion } from '../../src/metadata/column-version.js';
import type { HLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { InMemoryKVStore } from '@quereus/store';

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
    let kv: InMemoryKVStore;

    beforeEach(() => {
      kv = new InMemoryKVStore();
      store = new ColumnVersionStore(kv);
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

