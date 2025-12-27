/**
 * Integration tests for HTTP routes.
 */

import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createCoordinatorServer, loadConfig, type CoordinatorServer } from '../src/index.js';

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

      const body = await response.json() as { ok: boolean; data: { siteId: string; connectedClients: number } };
      expect(body.ok).to.be.true;
      expect(body.data).to.have.property('siteId');
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

  describe('GET /changes', () => {
    it('should require authentication (X-Site-Id header)', async () => {
      const response = await fetch(`${baseUrl}/changes`);
      expect(response.status).to.equal(401);
    });

    it('should return changes with valid site ID', async () => {
      const siteId = '0123456789abcdef0123456789abcdef';
      const response = await fetch(`${baseUrl}/changes`, {
        headers: { 'X-Site-Id': siteId },
      });
      expect(response.ok).to.be.true;

      const body = await response.json() as { ok: boolean; data: { changes: unknown[] } };
      expect(body.ok).to.be.true;
      expect(body.data.changes).to.be.an('array');
    });
  });

  describe('POST /changes', () => {
    it('should require authentication', async () => {
      const response = await fetch(`${baseUrl}/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes: [] }),
      });
      expect(response.status).to.equal(401);
    });

    it('should reject invalid body', async () => {
      const siteId = '0123456789abcdef0123456789abcdef';
      const response = await fetch(`${baseUrl}/changes`, {
        method: 'POST',
        headers: {
          'X-Site-Id': siteId,
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
      const siteId = '0123456789abcdef0123456789abcdef';
      const response = await fetch(`${baseUrl}/changes`, {
        method: 'POST',
        headers: {
          'X-Site-Id': siteId,
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
      const response = await fetch(`${tokenBaseUrl}/changes`, {
        headers: { 'X-Site-Id': '0123456789abcdef0123456789abcdef' },
      });
      expect(response.status).to.equal(401);
    });

    it('should reject invalid token', async () => {
      const response = await fetch(`${tokenBaseUrl}/changes`, {
        headers: {
          'X-Site-Id': '0123456789abcdef0123456789abcdef',
          'Authorization': 'Bearer invalid-token',
        },
      });
      expect(response.status).to.equal(401);
    });

    it('should accept valid token', async () => {
      const response = await fetch(`${tokenBaseUrl}/changes`, {
        headers: {
          'X-Site-Id': '0123456789abcdef0123456789abcdef',
          'Authorization': 'Bearer valid-token',
        },
      });
      expect(response.ok).to.be.true;
    });
  });
});

