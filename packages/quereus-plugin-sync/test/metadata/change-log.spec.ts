/**
 * Tests for ChangeLogStore.
 */

import { expect } from 'chai';
import { ChangeLogStore } from '../../src/metadata/change-log.js';
import { type HLC, compareHLC } from '../../src/clock/hlc.js';
import { generateSiteId } from '../../src/clock/site.js';
import { InMemoryKVStore } from '@quereus/plugin-store';

describe('ChangeLogStore', () => {
  let kv: InMemoryKVStore;
  let store: ChangeLogStore;
  let siteId: Uint8Array;

  beforeEach(() => {
    kv = new InMemoryKVStore();
    store = new ChangeLogStore(kv);
    siteId = generateSiteId();
  });

  describe('recordColumnChange', () => {
    it('should record a column change', async () => {
      const hlc: HLC = { wallTime: BigInt(1000), counter: 1, siteId };

      await store.recordColumnChange(hlc, 'main', 'users', [1], 'name');

      // Verify by getting changes since before
      const sinceHLC: HLC = { wallTime: BigInt(500), counter: 0, siteId };
      const entries = [];
      for await (const entry of store.getChangesSince(sinceHLC)) {
        entries.push(entry);
      }

      expect(entries).to.have.lengthOf(1);
      expect(entries[0].schema).to.equal('main');
      expect(entries[0].table).to.equal('users');
      expect(entries[0].column).to.equal('name');
      expect(entries[0].entryType).to.equal('column');
    });
  });

  describe('recordDeletion', () => {
    it('should record a deletion', async () => {
      const hlc: HLC = { wallTime: BigInt(1000), counter: 1, siteId };

      await store.recordDeletion(hlc, 'main', 'users', [1]);

      const sinceHLC: HLC = { wallTime: BigInt(500), counter: 0, siteId };
      const entries = [];
      for await (const entry of store.getChangesSince(sinceHLC)) {
        entries.push(entry);
      }

      expect(entries).to.have.lengthOf(1);
      expect(entries[0].entryType).to.equal('delete');
    });
  });

  describe('getChangesSince', () => {
    it('should filter by HLC', async () => {
      const hlc1: HLC = { wallTime: BigInt(1000), counter: 1, siteId };
      const hlc2: HLC = { wallTime: BigInt(2000), counter: 1, siteId };
      const hlc3: HLC = { wallTime: BigInt(3000), counter: 1, siteId };

      await store.recordColumnChange(hlc1, 'main', 'users', [1], 'name');
      await store.recordColumnChange(hlc2, 'main', 'users', [2], 'name');
      await store.recordColumnChange(hlc3, 'main', 'users', [3], 'name');

      // Get changes since hlc1
      const entries = [];
      for await (const entry of store.getChangesSince(hlc1)) {
        entries.push(entry);
      }

      // Should only get hlc2 and hlc3
      expect(entries).to.have.lengthOf(2);
    });

    it('should return entries in HLC order', async () => {
      // Insert in reverse order
      const hlc3: HLC = { wallTime: BigInt(3000), counter: 1, siteId };
      const hlc1: HLC = { wallTime: BigInt(1000), counter: 1, siteId };
      const hlc2: HLC = { wallTime: BigInt(2000), counter: 1, siteId };

      await store.recordColumnChange(hlc3, 'main', 'users', [3], 'name');
      await store.recordColumnChange(hlc1, 'main', 'users', [1], 'name');
      await store.recordColumnChange(hlc2, 'main', 'users', [2], 'name');

      const sinceHLC: HLC = { wallTime: BigInt(0), counter: 0, siteId };
      const entries = [];
      for await (const entry of store.getChangesSince(sinceHLC)) {
        entries.push(entry);
      }

      expect(entries).to.have.lengthOf(3);
      // Entries should be in HLC order
      expect(compareHLC(entries[0].hlc, entries[1].hlc)).to.be.lessThan(0);
      expect(compareHLC(entries[1].hlc, entries[2].hlc)).to.be.lessThan(0);
    });
  });
});

