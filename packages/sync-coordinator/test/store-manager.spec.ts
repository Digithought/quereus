/**
 * Tests for StoreManager - multi-tenant LevelDB store management.
 */

import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { StoreManager } from '../src/service/store-manager.js';

const TEST_DATABASE_ID = 'test-db-1';
const TEST_DATABASE_ID_2 = 'test-db-2';

describe('StoreManager', () => {
  let manager: StoreManager;
  let testDataDir: string;

  beforeEach(() => {
    testDataDir = join(tmpdir(), `sync-store-test-${randomUUID()}`);
    manager = new StoreManager({
      dataDir: testDataDir,
      maxOpenStores: 3,
      idleTimeoutMs: 100,
      cleanupIntervalMs: 50,
    });
    manager.start();
  });

  afterEach(async () => {
    await manager.shutdown();
    await rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('validateDatabaseId', () => {
    it('should accept alphanumeric IDs', () => {
      expect(manager.validateDatabaseId('my-database')).to.be.true;
      expect(manager.validateDatabaseId('org:type_id')).to.be.true;
      expect(manager.validateDatabaseId('a1.b2.c3')).to.be.true;
    });

    it('should reject empty string', () => {
      expect(manager.validateDatabaseId('')).to.be.false;
    });

    it('should reject IDs with unsafe characters', () => {
      expect(manager.validateDatabaseId('path/traversal')).to.be.false;
      expect(manager.validateDatabaseId('../escape')).to.be.false;
      expect(manager.validateDatabaseId('has spaces')).to.be.false;
    });

    it('should use custom isValidDatabaseId hook', () => {
      const customManager = new StoreManager({
        dataDir: testDataDir,
        hooks: {
          isValidDatabaseId: (id) => id.startsWith('org:'),
        },
      });
      expect(customManager.validateDatabaseId('org:db1')).to.be.true;
      expect(customManager.validateDatabaseId('db1')).to.be.false;
    });
  });

  describe('acquire and release', () => {
    it('should open a store on first acquire', async () => {
      expect(manager.openCount).to.equal(0);
      const entry = await manager.acquire(TEST_DATABASE_ID);
      expect(entry).to.have.property('store');
      expect(entry).to.have.property('syncManager');
      expect(entry.databaseId).to.equal(TEST_DATABASE_ID);
      expect(entry.refCount).to.equal(1);
      expect(manager.openCount).to.equal(1);
    });

    it('should return cached store on subsequent acquire', async () => {
      const entry1 = await manager.acquire(TEST_DATABASE_ID);
      const entry2 = await manager.acquire(TEST_DATABASE_ID);
      expect(entry1).to.equal(entry2);
      expect(entry2.refCount).to.equal(2);
      expect(manager.openCount).to.equal(1);
    });

    it('should decrement refCount on release', async () => {
      const entry = await manager.acquire(TEST_DATABASE_ID);
      await manager.acquire(TEST_DATABASE_ID);
      expect(entry.refCount).to.equal(2);

      manager.release(TEST_DATABASE_ID);
      expect(entry.refCount).to.equal(1);
    });

    it('should not go below zero refCount', () => {
      manager.release('non-existent-db');
      // Should not throw
    });

    it('should open separate stores for different databases', async () => {
      await manager.acquire(TEST_DATABASE_ID);
      await manager.acquire(TEST_DATABASE_ID_2);
      expect(manager.openCount).to.equal(2);
    });
  });

  describe('isOpen and get', () => {
    it('should report open state correctly', async () => {
      expect(manager.isOpen(TEST_DATABASE_ID)).to.be.false;
      await manager.acquire(TEST_DATABASE_ID);
      expect(manager.isOpen(TEST_DATABASE_ID)).to.be.true;
    });

    it('should return entry for open store via get', async () => {
      expect(manager.get(TEST_DATABASE_ID)).to.be.undefined;
      await manager.acquire(TEST_DATABASE_ID);
      const entry = manager.get(TEST_DATABASE_ID);
      expect(entry).to.not.be.undefined;
      expect(entry!.databaseId).to.equal(TEST_DATABASE_ID);
    });
  });

  describe('LRU eviction', () => {
    it('should evict LRU store when maxOpenStores reached', async () => {
      // maxOpenStores is 3 - open 3 stores
      await manager.acquire('db-a');
      manager.release('db-a');
      await manager.acquire('db-b');
      manager.release('db-b');
      await manager.acquire('db-c');
      manager.release('db-c');

      expect(manager.openCount).to.equal(3);

      // Opening a 4th should evict the oldest (db-a)
      await manager.acquire('db-d');
      expect(manager.openCount).to.be.at.most(3);
      expect(manager.isOpen('db-d')).to.be.true;
    });
  });

  describe('shutdown', () => {
    it('should close all stores', async () => {
      await manager.acquire(TEST_DATABASE_ID);
      await manager.acquire(TEST_DATABASE_ID_2);
      expect(manager.openCount).to.equal(2);

      await manager.shutdown();
      expect(manager.openCount).to.equal(0);
    });

    it('should be idempotent', async () => {
      await manager.acquire(TEST_DATABASE_ID);
      await manager.shutdown();
      await manager.shutdown(); // Second call should not throw
      expect(manager.openCount).to.equal(0);
    });
  });
});

