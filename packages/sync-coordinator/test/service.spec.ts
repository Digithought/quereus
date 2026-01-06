/**
 * Tests for CoordinatorService.
 */

import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { CoordinatorService } from '../src/service/coordinator-service.js';
import { DEFAULT_CONFIG, type CoordinatorConfig } from '../src/config/index.js';
import type { ClientIdentity, CoordinatorHooks } from '../src/service/types.js';
import { siteIdFromBase64 } from '@quereus/sync';

// Test site ID: ASNFZ4mrze8BI0VniavN7w (base64url of 0x0123456789abcdef0123456789abcdef)
const TEST_SITE_ID_BASE64 = 'ASNFZ4mrze8BI0VniavN7w';
// Test database ID in accountId-scenarioId format
const TEST_DATABASE_ID = 'my-test-database';

describe('CoordinatorService', () => {
  let service: CoordinatorService;
  let testDataDir: string;

  beforeEach(async () => {
    testDataDir = join(tmpdir(), `sync-coordinator-test-${randomUUID()}`);
    const config: CoordinatorConfig = {
      ...DEFAULT_CONFIG,
      dataDir: testDataDir,
    };
    service = new CoordinatorService({ config });
    await service.initialize();
  });

  afterEach(async () => {
    await service.shutdown();
    // Clean up test data
    try {
      await rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      const siteId = await service.getSiteId(TEST_DATABASE_ID);
      expect(siteId).to.be.instanceOf(Uint8Array);
      expect(siteId.length).to.equal(16);
    });

    it('should have a current HLC', async () => {
      const hlc = await service.getCurrentHLC(TEST_DATABASE_ID);
      expect(hlc).to.have.property('wallTime');
      expect(hlc).to.have.property('counter');
      expect(hlc).to.have.property('siteId');
    });
  });

  describe('authentication', () => {
    it('should authenticate with siteId in none mode', async () => {
      const identity = await service.authenticate({
        databaseId: TEST_DATABASE_ID,
        siteIdRaw: TEST_SITE_ID_BASE64,
      });
      expect(identity.siteId).to.deep.equal(siteIdFromBase64(TEST_SITE_ID_BASE64));
    });

    it('should reject without siteId', async () => {
      try {
        await service.authenticate({ databaseId: TEST_DATABASE_ID });
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as Error).message).to.equal('Site ID required');
      }
    });
  });

  describe('authorization', () => {
    it('should allow all operations by default', async () => {
      const client: ClientIdentity = {
        siteId: siteIdFromBase64(TEST_SITE_ID_BASE64),
      };

      const allowed = await service.authorize(client, { type: 'get_changes' });
      expect(allowed).to.be.true;
    });
  });

  describe('hooks', () => {
    it('should call onAuthenticate hook', async () => {
      let hookCalled = false;
      const hooks: CoordinatorHooks = {
        async onAuthenticate(context) {
          hookCalled = true;
          return { siteId: context.siteId! };
        },
      };

      const config: CoordinatorConfig = {
        ...DEFAULT_CONFIG,
        dataDir: join(tmpdir(), `sync-coordinator-test-hooks-${randomUUID()}`),
      };
      const hookedService = new CoordinatorService({ config, hooks });
      await hookedService.initialize();

      try {
        await hookedService.authenticate({
          databaseId: TEST_DATABASE_ID,
          siteIdRaw: TEST_SITE_ID_BASE64,
          siteId: siteIdFromBase64(TEST_SITE_ID_BASE64),
        });
        expect(hookCalled).to.be.true;
      } finally {
        await hookedService.shutdown();
        await rm(config.dataDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it('should call onAuthorize hook', async () => {
      let authorizedOperation: string | undefined;
      const hooks: CoordinatorHooks = {
        async onAuthorize(_client, operation) {
          authorizedOperation = operation.type;
          return true;
        },
      };

      const config: CoordinatorConfig = {
        ...DEFAULT_CONFIG,
        dataDir: join(tmpdir(), `sync-coordinator-test-auth-${randomUUID()}`),
      };
      const hookedService = new CoordinatorService({ config, hooks });
      await hookedService.initialize();

      try {
        const client: ClientIdentity = {
          siteId: siteIdFromBase64(TEST_SITE_ID_BASE64),
        };
        await hookedService.authorize(client, { type: 'get_snapshot' });
        expect(authorizedOperation).to.equal('get_snapshot');
      } finally {
        await hookedService.shutdown();
        await rm(config.dataDir, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  describe('getStatus', () => {
    it('should return server status', () => {
      const status = service.getStatus();
      expect(status).to.have.property('openStores');
      expect(status).to.have.property('connectedClients');
      expect(status).to.have.property('uptime');
      expect(status.connectedClients).to.equal(0);
    });
  });
});

