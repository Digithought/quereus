/**
 * Integration tests for HTTP routes.
 */

import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  createCoordinatorServer,
  loadConfig,
  type CoordinatorServer,
} from '../src/index.js';

// Database IDs are just strings
const TEST_DATABASE_ID = 'my-test-database';

// Valid 22-character base64url site IDs (16 bytes each)
// These represent valid UUIDs encoded as base64url
const TEST_SITE_ID = 'AAAAAAAAAAAAAAAAAAAAAA'; // 16 zero bytes

describe('HTTP Routes', () => {
  let server: CoordinatorServer;
  let baseUrl: string;
  let testDataDir: string;

  before(async () => {
    testDataDir = join(tmpdir(), `sync-http-test-${randomUUID()}`);
    const config = loadConfig({
      overrides: {
        port: 0, // Random available port
        dataDir: testDataDir,
        basePath: '/sync',
      },
    });

    server = await createCoordinatorServer({ config });
    await server.start();

    // Get the actual port from the server
    const address = server.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 3000;
    baseUrl = `http://127.0.0.1:${port}/sync`;
  });

  after(async () => {
    await server.stop();
    try {
      await rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('GET /status', () => {
    it('should return server status', async () => {
      const response = await fetch(`${baseUrl}/status`);
      expect(response.ok).to.be.true;

      const body = await response.json() as { ok: boolean; data: { openStores: number; connectedClients: number } };
      expect(body.ok).to.be.true;
      expect(body.data).to.have.property('openStores');
      expect(body.data).to.have.property('connectedClients');
      expect(body.data.connectedClients).to.equal(0);
    });
  });

  describe('GET /metrics', () => {
    it('should return Prometheus metrics', async () => {
      const response = await fetch(`${baseUrl}/metrics`);
      expect(response.ok).to.be.true;
      expect(response.headers.get('content-type')).to.include('text/plain');

      const body = await response.text();
      expect(body).to.include('# HELP');
      expect(body).to.include('# TYPE');
      expect(body).to.include('sync_websocket_connections_active');
    });
  });

  describe('GET /:databaseId/changes', () => {
    it('should require authentication (X-Site-Id header)', async () => {
      const response = await fetch(`${baseUrl}/${TEST_DATABASE_ID}/changes`);
      expect(response.status).to.equal(401);
    });

    it('should return changes with valid site ID', async () => {
      const response = await fetch(`${baseUrl}/${TEST_DATABASE_ID}/changes`, {
        headers: { 'X-Site-Id': TEST_SITE_ID },
      });
      expect(response.ok).to.be.true;

      const body = await response.json() as { ok: boolean; data: { changes: unknown[] } };
      expect(body.ok).to.be.true;
      expect(body.data.changes).to.be.an('array');
    });

    it('should reject empty database ID', async () => {
      // Empty path segment is invalid
      const response = await fetch(`${baseUrl}//changes`, {
        headers: { 'X-Site-Id': TEST_SITE_ID },
      });
      expect(response.status).to.equal(400);

      const body = await response.json() as { ok: boolean; error: { code: string } };
      expect(body.ok).to.be.false;
      expect(body.error.code).to.equal('INVALID_DATABASE_ID');
    });
  });

  describe('POST /:databaseId/changes', () => {
    it('should require authentication', async () => {
      const response = await fetch(`${baseUrl}/${TEST_DATABASE_ID}/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [] }),
      });
      expect(response.status).to.equal(401);
    });

    it('should reject invalid body', async () => {
      const response = await fetch(`${baseUrl}/${TEST_DATABASE_ID}/changes`, {
        method: 'POST',
        headers: {
          'X-Site-Id': TEST_SITE_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ notChanges: true }),
      });
      expect(response.status).to.equal(400);

      const body = await response.json() as { ok: boolean; error: { code: string } };
      expect(body.ok).to.be.false;
      expect(body.error.code).to.equal('INVALID_BODY');
    });

    it('should accept empty changes array', async () => {
      const response = await fetch(`${baseUrl}/${TEST_DATABASE_ID}/changes`, {
        method: 'POST',
        headers: {
          'X-Site-Id': TEST_SITE_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ changes: [] }),
      });
      expect(response.ok).to.be.true;

      const body = await response.json() as { ok: boolean; data: { applied: number } };
      expect(body.ok).to.be.true;
      expect(body.data.applied).to.equal(0);
    });
  });

  describe('GET /:databaseId/snapshot', () => {
    it('should require authentication', async () => {
      const response = await fetch(`${baseUrl}/${TEST_DATABASE_ID}/snapshot`);
      expect(response.status).to.equal(401);
    });

    it('should stream snapshot as NDJSON with valid content-type', async () => {
      const response = await fetch(`${baseUrl}/${TEST_DATABASE_ID}/snapshot`, {
        headers: { 'X-Site-Id': TEST_SITE_ID },
      });
      expect(response.ok).to.be.true;
      expect(response.headers.get('content-type')).to.include('application/x-ndjson');
    });
  });

  describe('Token authentication', () => {
    let tokenServer: CoordinatorServer;
    let tokenBaseUrl: string;
    let tokenDataDir: string;

    before(async () => {
      tokenDataDir = join(tmpdir(), `sync-token-test-${randomUUID()}`);
      const config = loadConfig({
        overrides: {
          port: 0,
          dataDir: tokenDataDir,
          basePath: '/sync',
          auth: { mode: 'token-whitelist', tokens: ['valid-token'] },
        },
      });

      tokenServer = await createCoordinatorServer({ config });
      await tokenServer.start();

      const address = tokenServer.app.server.address();
      const port = typeof address === 'object' && address ? address.port : 3000;
      tokenBaseUrl = `http://127.0.0.1:${port}/sync`;
    });

    after(async () => {
      await tokenServer.stop();
      await rm(tokenDataDir, { recursive: true, force: true }).catch(() => {});
    });

    it('should reject without token', async () => {
      const response = await fetch(`${tokenBaseUrl}/${TEST_DATABASE_ID}/changes`, {
        headers: { 'X-Site-Id': TEST_SITE_ID },
      });
      expect(response.status).to.equal(401);
    });

    it('should reject invalid token', async () => {
      const response = await fetch(`${tokenBaseUrl}/${TEST_DATABASE_ID}/changes`, {
        headers: {
          'X-Site-Id': TEST_SITE_ID,
          'Authorization': 'Bearer invalid-token',
        },
      });
      expect(response.status).to.equal(401);
    });

    it('should accept valid token', async () => {
      const response = await fetch(`${tokenBaseUrl}/${TEST_DATABASE_ID}/changes`, {
        headers: {
          'X-Site-Id': TEST_SITE_ID,
          'Authorization': 'Bearer valid-token',
        },
      });
      expect(response.ok).to.be.true;
    });
  });
});

