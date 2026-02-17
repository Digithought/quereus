/**
 * Integration tests for WebSocket handler.
 */

import { expect } from 'chai';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import WebSocket from 'ws';
import { createCoordinatorServer, loadConfig, type CoordinatorServer } from '../src/index.js';

// Test database ID in <org_id>:<type>_<id> format (see docs/database-sync.md)
const TEST_DATABASE_ID = 'default:s_test-scenario';

// Valid 22-character base64url site IDs (16 bytes each)
const TEST_SITE_ID_1 = 'AAAAAAAAAAAAAAAAAAAAAA'; // 16 zero bytes
const TEST_SITE_ID_2 = 'AAAAAAAAAAAAAAAAAAAAAB'; // slightly different

describe('WebSocket Handler', () => {
  let server: CoordinatorServer;
  let wsUrl: string;
  let testDataDir: string;

  before(async () => {
    testDataDir = join(tmpdir(), `sync-ws-test-${randomUUID()}`);
    const config = loadConfig({
      overrides: {
        port: 0,
        dataDir: testDataDir,
        basePath: '/sync',
      },
    });

    server = await createCoordinatorServer({ config });
    await server.start();

    const address = server.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 3000;
    wsUrl = `ws://127.0.0.1:${port}/sync/ws`;
  });

  after(async () => {
    await server.stop();
    try {
      await rm(testDataDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Helper to create a WebSocket and wait for connection.
   */
  function connectWs(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      ws.on('open', () => resolve(ws));
      ws.on('error', reject);
    });
  }

  /**
   * Helper to send a message and wait for response.
   */
  function sendAndReceive(ws: WebSocket, message: object): Promise<object> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout')), 5000);
      ws.once('message', (data) => {
        clearTimeout(timeout);
        resolve(JSON.parse(data.toString()));
      });
      ws.send(JSON.stringify(message));
    });
  }

  describe('Handshake', () => {
    it('should complete handshake with valid databaseId and siteId', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
        }) as { type: string; databaseId: string; serverSiteId: string; connectionId: string };

        expect(response.type).to.equal('handshake_ack');
        expect(response.databaseId).to.equal(TEST_DATABASE_ID);
        expect(response.serverSiteId).to.be.a('string');
        expect(response.connectionId).to.be.a('string');
      } finally {
        ws.close();
      }
    });

    it('should reject handshake without databaseId', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'handshake',
          siteId: TEST_SITE_ID_1,
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('MISSING_DATABASE_ID');
      } finally {
        ws.close();
      }
    });

    it('should reject handshake without siteId', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('AUTH_FAILED');
      } finally {
        ws.close();
      }
    });
  });

  describe('Ping/Pong', () => {
    it('should respond to ping', async () => {
      const ws = await connectWs();
      try {
        // Handshake first
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
        });

        const response = await sendAndReceive(ws, {
          type: 'ping',
        }) as { type: string };

        expect(response.type).to.equal('pong');
      } finally {
        ws.close();
      }
    });
  });

  describe('Get Changes', () => {
    it('should require authentication', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'get_changes',
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('NOT_AUTHENTICATED');
      } finally {
        ws.close();
      }
    });

    it('should return changes after handshake', async () => {
      const ws = await connectWs();
      try {
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
        });

        const response = await sendAndReceive(ws, {
          type: 'get_changes',
        }) as { type: string; changeSets: unknown[] };

        expect(response.type).to.equal('changes');
        expect(response.changeSets).to.be.an('array');
      } finally {
        ws.close();
      }
    });
  });

  describe('Duplicate handshake', () => {
    it('should reject duplicate handshake with ALREADY_AUTHENTICATED', async () => {
      const ws = await connectWs();
      try {
        // First handshake
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
        });

        // Second handshake on same connection
        const response = await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('ALREADY_AUTHENTICATED');
      } finally {
        ws.close();
      }
    });
  });

  describe('Unknown message type', () => {
    it('should return UNKNOWN_MESSAGE for unrecognized type', async () => {
      const ws = await connectWs();
      try {
        // Handshake first
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
        });

        const response = await sendAndReceive(ws, {
          type: 'totally_unknown',
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('UNKNOWN_MESSAGE');
      } finally {
        ws.close();
      }
    });
  });

  describe('Apply Changes via WS', () => {
    it('should require authentication for apply_changes', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'apply_changes',
          changes: [],
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('NOT_AUTHENTICATED');
      } finally {
        ws.close();
      }
    });

    it('should apply empty changes array', async () => {
      const ws = await connectWs();
      try {
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
        });

        const response = await sendAndReceive(ws, {
          type: 'apply_changes',
          changes: [],
        }) as { type: string; applied: number };

        expect(response.type).to.equal('apply_result');
        expect(response.applied).to.equal(0);
      } finally {
        ws.close();
      }
    });
  });

  describe('Get Snapshot via WS', () => {
    it('should require authentication for get_snapshot', async () => {
      const ws = await connectWs();
      try {
        const response = await sendAndReceive(ws, {
          type: 'get_snapshot',
        }) as { type: string; code: string };

        expect(response.type).to.equal('error');
        expect(response.code).to.equal('NOT_AUTHENTICATED');
      } finally {
        ws.close();
      }
    });

    it('should stream snapshot after handshake (known bug: BigInt serialization)', async function () {
      // BUG: handleGetSnapshot() sends raw SnapshotChunk objects containing HLC (BigInt wallTime)
      // and SiteId (Uint8Array), which JSON.stringify cannot serialize.
      // The handler should serialize these fields (like handleGetChanges does with serializeChangeSet).
      // Once fixed, this test should assert snapshot_chunk/snapshot_complete messages.
      const ws = await connectWs();
      try {
        await sendAndReceive(ws, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
        });

        const response = await sendAndReceive(ws, {
          type: 'get_snapshot',
        }) as { type: string; code?: string; message?: string };

        // Currently returns error due to BigInt serialization failure
        expect(response.type).to.equal('error');
        expect(response.code).to.equal('MESSAGE_ERROR');
        expect(response.message).to.include('BigInt');
      } finally {
        ws.close();
        // Wait for server-side session cleanup
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    });
  });

  describe('Connection tracking', () => {
    it('should track connected clients', async function () {
      // Allow any lingering connections from previous tests to fully close
      await new Promise(resolve => setTimeout(resolve, 300));
      const ws1 = await connectWs();
      const ws2 = await connectWs();

      try {
        // Handshake both with different site IDs
        await sendAndReceive(ws1, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_1,
        });
        await sendAndReceive(ws2, {
          type: 'handshake',
          databaseId: TEST_DATABASE_ID,
          siteId: TEST_SITE_ID_2,
        });

        // Check status
        const address = server.app.server.address();
        const port = typeof address === 'object' && address ? address.port : 3000;
        const response = await fetch(`http://127.0.0.1:${port}/sync/status`);
        const body = await response.json() as { data: { connectedClients: number } };

        expect(body.data.connectedClients).to.equal(2);
      } finally {
        ws1.close();
        ws2.close();
      }
    });
  });
});

