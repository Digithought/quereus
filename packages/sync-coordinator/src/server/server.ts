/**
 * Fastify server setup for sync-coordinator.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import type { CoordinatorConfig } from '../config/types.js';
import { CoordinatorService, type CoordinatorServiceOptions } from '../service/coordinator-service.js';
import type { CoordinatorHooks } from '../service/types.js';
import type { StoreManagerHooks } from '../service/store-manager.js';
import { registerRoutes } from './routes.js';
import { registerWebSocket } from './websocket.js';
import { serverLog } from '../common/logger.js';

/**
 * Options for creating a coordinator server.
 */
export interface CoordinatorServerOptions {
  /** Full configuration */
  config: CoordinatorConfig;
  /** Custom hooks for validation/auth */
  hooks?: CoordinatorHooks;
  /** Hooks for customizing store behavior (database ID handling, path resolution) */
  storeHooks?: StoreManagerHooks;
}

/**
 * Coordinator server instance.
 */
export interface CoordinatorServer {
  /** The Fastify instance */
  app: FastifyInstance;
  /** The coordinator service */
  service: CoordinatorService;
  /** Start the server */
  start(): Promise<void>;
  /** Stop the server */
  stop(): Promise<void>;
}

/**
 * Create a coordinator server.
 */
export async function createCoordinatorServer(
  options: CoordinatorServerOptions
): Promise<CoordinatorServer> {
  const { config, hooks, storeHooks } = options;

  serverLog('Creating coordinator server');

  // Create Fastify instance
  const app = Fastify({
    logger: config.logging.level === 'debug',
  });

  // Register CORS
  await app.register(fastifyCors, {
    origin: config.cors.origin,
    credentials: config.cors.credentials,
  });

  // Register WebSocket support
  await app.register(fastifyWebsocket);

  // Create service
  const serviceOptions: CoordinatorServiceOptions = {
    config,
    hooks,
    storeHooks,
  };
  const service = new CoordinatorService(serviceOptions);

  // Initialize service
  await service.initialize();

  // Register routes
  registerRoutes(app, service, config.basePath);
  registerWebSocket(app, service, config.basePath);

  serverLog('Routes registered at %s', config.basePath);

  // Server control
  const start = async () => {
    const address = await app.listen({
      host: config.host,
      port: config.port,
    });
    serverLog('Server listening at %s', address);
    console.log(`Sync coordinator listening at ${address}${config.basePath}`);
  };

  const stop = async () => {
    serverLog('Stopping server');
    await app.close();
    await service.shutdown();
    serverLog('Server stopped');
  };

  return { app, service, start, stop };
}

