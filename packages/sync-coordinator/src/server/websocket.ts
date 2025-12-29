/**
 * WebSocket handler for real-time sync.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket, RawData } from 'ws';
import {
  siteIdFromBase64,
  siteIdToBase64,
  deserializeHLC,
  serializeHLC,
  type HLC,
  type ChangeSet,
  type SnapshotCheckpoint,
} from 'quereus-plugin-sync';
import type { CoordinatorService } from '../service/coordinator-service.js';
import type { ClientIdentity, ClientSession } from '../service/types.js';
import { wsLog } from '../common/logger.js';

// ============================================================================
// Message Types
// ============================================================================

interface HandshakeMessage {
  type: 'handshake';
  siteId: string;
  token?: string;
}

interface GetChangesMessage {
  type: 'get_changes';
  sinceHLC?: string; // base64 encoded
}

interface ApplyChangesMessage {
  type: 'apply_changes';
  changes: unknown[];
}

interface GetSnapshotMessage {
  type: 'get_snapshot';
}

interface ResumeSnapshotMessage {
  type: 'resume_snapshot';
  checkpoint: SnapshotCheckpoint;
}

interface PingMessage {
  type: 'ping';
}

type ClientMessage =
  | HandshakeMessage
  | GetChangesMessage
  | ApplyChangesMessage
  | GetSnapshotMessage
  | ResumeSnapshotMessage
  | PingMessage;

// ============================================================================
// WebSocket Handler
// ============================================================================

/**
 * Register WebSocket handler.
 */
export function registerWebSocket(
  app: FastifyInstance,
  service: CoordinatorService,
  basePath: string
): void {
  app.get(`${basePath}/ws`, { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    wsLog('New WebSocket connection from %s', request.ip);

    let session: ClientSession | null = null;

    const sendError = (code: string, message: string) => {
      socket.send(JSON.stringify({ type: 'error', code, message }));
    };

    const sendMessage = (msg: object) => {
      socket.send(JSON.stringify(msg));
    };

    socket.on('message', async (data: RawData) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        wsLog('Received message: %s', message.type);

        switch (message.type) {
          case 'handshake':
            await handleHandshake(message);
            break;
          case 'get_changes':
            await handleGetChanges(message);
            break;
          case 'apply_changes':
            await handleApplyChanges(message);
            break;
          case 'get_snapshot':
            await handleGetSnapshot();
            break;
          case 'ping':
            sendMessage({ type: 'pong' });
            break;
          default:
            sendError('UNKNOWN_MESSAGE', `Unknown message type: ${(message as { type: string }).type}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Message processing failed';
        wsLog('Message error: %s', msg);
        sendError('MESSAGE_ERROR', msg);
      }
    });

    socket.on('close', () => {
      wsLog('WebSocket closed: %s', session?.connectionId?.slice(0, 8) || 'no-session');
      if (session) {
        service.unregisterSession(session.connectionId);
      }
    });

    socket.on('error', (err) => {
      wsLog('WebSocket error: %O', err);
    });

    // Handler functions
    async function handleHandshake(msg: HandshakeMessage) {
      if (session) {
        sendError('ALREADY_AUTHENTICATED', 'Already authenticated');
        return;
      }

      try {
        const identity: ClientIdentity = await service.authenticate({
          token: msg.token,
          siteIdRaw: msg.siteId,
          siteId: siteIdFromBase64(msg.siteId),
          socket,
        });

        session = await service.registerSession(socket, identity);

        sendMessage({
          type: 'handshake_ack',
          serverSiteId: siteIdToBase64(service.getSiteId()),
          connectionId: session.connectionId,
        });

        wsLog('Handshake complete: %s', session.connectionId.slice(0, 8));
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Authentication failed';
        sendError('AUTH_FAILED', msg);
        socket.close(4001, 'Authentication failed');
      }
    }

    async function handleGetChanges(msg: GetChangesMessage) {
      if (!session) {
        sendError('NOT_AUTHENTICATED', 'Must handshake first');
        return;
      }

      let sinceHLC: HLC | undefined;
      if (msg.sinceHLC) {
        sinceHLC = deserializeHLC(Buffer.from(msg.sinceHLC, 'base64'));
      }

      const changes = await service.getChangesSince(session.identity, sinceHLC);

      // Serialize for JSON transport
      const serializedChanges = changes.map(cs => serializeChangeSet(cs));

      sendMessage({ type: 'changes', changeSets: serializedChanges });
    }

    async function handleApplyChanges(msg: ApplyChangesMessage) {
      if (!session) {
        sendError('NOT_AUTHENTICATED', 'Must handshake first');
        return;
      }

      // Deserialize from JSON transport
      const changes: ChangeSet[] = msg.changes.map(cs => deserializeChangeSet(cs));

      const result = await service.applyChanges(session.identity, changes);

      sendMessage({ type: 'apply_result', ...result });
    }

    async function handleGetSnapshot() {
      if (!session) {
        sendError('NOT_AUTHENTICATED', 'Must handshake first');
        return;
      }

      // Stream snapshot chunks
      for await (const chunk of service.getSnapshotStream(session.identity)) {
        sendMessage({ ...chunk, type: 'snapshot_chunk' });
      }

      sendMessage({ type: 'snapshot_complete' });
    }
  });
}

// ============================================================================
// Serialization Helpers
// ============================================================================

function serializeChangeSet(cs: ChangeSet): object {
  return {
    siteId: siteIdToBase64(cs.siteId),
    transactionId: cs.transactionId,
    hlc: Buffer.from(serializeHLC(cs.hlc)).toString('base64'),
    changes: cs.changes.map(c => ({
      ...c,
      hlc: Buffer.from(serializeHLC(c.hlc)).toString('base64'),
    })),
    schemaMigrations: cs.schemaMigrations.map(m => ({
      ...m,
      hlc: Buffer.from(serializeHLC(m.hlc)).toString('base64'),
    })),
  };
}

function deserializeChangeSet(cs: unknown): ChangeSet {
  const obj = cs as Record<string, unknown>;
  return {
    siteId: siteIdFromBase64(obj.siteId as string),
    transactionId: obj.transactionId as string,
    hlc: deserializeHLC(Buffer.from(obj.hlc as string, 'base64')),
    changes: (obj.changes as Record<string, unknown>[]).map(c => ({
      ...c,
      hlc: deserializeHLC(Buffer.from(c.hlc as string, 'base64')),
    })),
    schemaMigrations: ((obj.schemaMigrations as Record<string, unknown>[]) || []).map(m => ({
      ...m,
      hlc: deserializeHLC(Buffer.from(m.hlc as string, 'base64')),
    })),
  } as ChangeSet;
}

