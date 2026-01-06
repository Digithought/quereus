/**
 * HTTP routes for sync operations.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { siteIdFromBase64, siteIdToBase64, deserializeHLC, serializeHLC, type HLC, type ChangeSet } from '@quereus/sync';
import type { CoordinatorService } from '../service/coordinator-service.js';
import type { AuthContext, ClientIdentity } from '../service/types.js';
import { httpLog } from '../common/logger.js';

/**
 * Register sync HTTP routes.
 */
export function registerRoutes(
  app: FastifyInstance,
  service: CoordinatorService,
  basePath: string
): void {
  // Helper to extract auth context from request
  const getAuthContext = (request: FastifyRequest, databaseId: string): AuthContext => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : authHeader;

    const siteIdRaw = request.headers['x-site-id'] as string | undefined;

    return {
      databaseId,
      token,
      siteIdRaw,
      siteId: siteIdRaw ? siteIdFromBase64(siteIdRaw) : undefined,
      request,
    };
  };

  // Helper for error responses
  const errorResponse = (reply: FastifyReply, code: string, message: string, status = 400) => {
    return reply.status(status).send({
      ok: false,
      error: { code, message },
    });
  };

  // Validate database ID from path parameter
  const validateDatabaseId = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const params = request.params as { databaseId?: string };
    const databaseId = params.databaseId;
    if (!databaseId || !service.isValidDatabaseId(databaseId)) {
      errorResponse(reply, 'INVALID_DATABASE_ID', `Invalid database ID: ${databaseId}`, 400);
      return null;
    }
    return databaseId;
  };

  // Authenticate and get client identity
  const authenticate = async (request: FastifyRequest, reply: FastifyReply, databaseId: string): Promise<ClientIdentity | null> => {
    try {
      const context = getAuthContext(request, databaseId);
      return await service.authenticate(context);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      errorResponse(reply, 'AUTH_FAILED', message, 401);
      return null;
    }
  };

  // GET /status - Health check and stats
  app.get(`${basePath}/status`, async (_request, reply) => {
    httpLog('GET %s/status', basePath);
    const status = service.getStatus();
    return reply.send({ ok: true, data: status });
  });

  // GET /metrics - Prometheus metrics
  app.get(`${basePath}/metrics`, async (_request, reply) => {
    httpLog('GET %s/metrics', basePath);
    const metrics = service.getMetrics();
    const output = metrics.registry.format();
    return reply
      .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(output);
  });

  // GET /:databaseId/changes - Get changes since HLC
  app.get(`${basePath}/:databaseId/changes`, async (request, reply) => {
    const databaseId = validateDatabaseId(request, reply);
    if (!databaseId) return;

    httpLog('GET %s/%s/changes', basePath, databaseId);

    const client = await authenticate(request, reply, databaseId);
    if (!client) return;

    try {
      const query = request.query as { sinceHLC?: string };
      let sinceHLC: HLC | undefined;

      if (query.sinceHLC) {
        // HLC is passed as base64-encoded serialized form
        const hlcBytes = Buffer.from(query.sinceHLC, 'base64');
        sinceHLC = deserializeHLC(hlcBytes);
      }

      const changes = await service.getChangesSince(databaseId, client, sinceHLC);

      // Serialize HLCs in response for JSON transport
      const serializedChanges = changes.map(cs => ({
        ...cs,
        siteId: siteIdToBase64(cs.siteId),
        hlc: Buffer.from(serializeHLC(cs.hlc)).toString('base64'),
        changes: cs.changes.map(c => ({
          ...c,
          hlc: Buffer.from(serializeHLC(c.hlc)).toString('base64'),
        })),
        schemaMigrations: cs.schemaMigrations.map(m => ({
          ...m,
          hlc: Buffer.from(serializeHLC(m.hlc)).toString('base64'),
        })),
      }));

      return reply.send({ ok: true, data: { changes: serializedChanges } });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get changes';
      httpLog('GET /%s/changes error: %s', databaseId, message);
      return errorResponse(reply, 'GET_CHANGES_FAILED', message, 500);
    }
  });

  // POST /:databaseId/changes - Apply changes from client
  app.post(`${basePath}/:databaseId/changes`, async (request, reply) => {
    const databaseId = validateDatabaseId(request, reply);
    if (!databaseId) return;

    httpLog('POST %s/%s/changes', basePath, databaseId);

    const client = await authenticate(request, reply, databaseId);
    if (!client) return;

    try {
      const body = request.body as { changes: unknown[] };
      if (!body.changes || !Array.isArray(body.changes)) {
        return errorResponse(reply, 'INVALID_BODY', 'Request body must contain changes array');
      }

      // Deserialize HLCs from JSON transport format
      const changes: ChangeSet[] = (body.changes as Record<string, unknown>[]).map((cs) => ({
        siteId: siteIdFromBase64(cs.siteId as string),
        transactionId: cs.transactionId as string,
        hlc: deserializeHLC(Buffer.from(cs.hlc as string, 'base64')),
        changes: (cs.changes as Record<string, unknown>[]).map(c => ({
          ...c,
          hlc: deserializeHLC(Buffer.from(c.hlc as string, 'base64')),
        })),
        schemaMigrations: ((cs.schemaMigrations as Record<string, unknown>[]) || []).map(m => ({
          ...m,
          hlc: deserializeHLC(Buffer.from(m.hlc as string, 'base64')),
        })),
      })) as ChangeSet[];

      const result = await service.applyChanges(databaseId, client, changes);
      return reply.send({ ok: true, data: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply changes';
      httpLog('POST /%s/changes error: %s', databaseId, message);
      return errorResponse(reply, 'APPLY_CHANGES_FAILED', message, 500);
    }
  });

  // GET /:databaseId/snapshot - Stream full snapshot
  app.get(`${basePath}/:databaseId/snapshot`, async (request, reply) => {
    const databaseId = validateDatabaseId(request, reply);
    if (!databaseId) return;

    httpLog('GET %s/%s/snapshot', basePath, databaseId);

    const client = await authenticate(request, reply, databaseId);
    if (!client) return;

    try {
      // Stream snapshot as newline-delimited JSON
      reply.raw.setHeader('Content-Type', 'application/x-ndjson');
      reply.raw.setHeader('Transfer-Encoding', 'chunked');

      for await (const chunk of service.getSnapshotStream(databaseId, client)) {
        const serialized = JSON.stringify(chunk) + '\n';
        reply.raw.write(serialized);
      }

      reply.raw.end();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get snapshot';
      httpLog('GET /%s/snapshot error: %s', databaseId, message);
      // Can't send error response if we've started streaming
      reply.raw.end();
    }
  });
}

