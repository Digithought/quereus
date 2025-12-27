#!/usr/bin/env node
/**
 * CLI entry point for sync-coordinator.
 */

import { Command } from 'commander';
import debug from 'debug';
import { loadConfig, type PartialCoordinatorConfig } from '../config/index.js';
import { createCoordinatorServer } from '../server/server.js';

const program = new Command();

program
  .name('sync-coordinator')
  .description('Standalone coordinator backend for Quereus Sync')
  .version('0.1.0')
  .option('-c, --config <path>', 'Path to config file (JSON)')
  .option('-h, --host <host>', 'Host to bind to')
  .option('-p, --port <port>', 'Port to listen on', parseInt)
  .option('-b, --base-path <path>', 'Base path for all routes')
  .option('-d, --data-dir <dir>', 'Directory for LevelDB data')
  .option('--cors-origin <origins>', 'CORS allowed origins (comma-separated, or "true"/"false")')
  .option('--auth-mode <mode>', 'Authentication mode: none, token-whitelist, custom')
  .option('--auth-tokens <tokens>', 'Comma-separated list of allowed tokens')
  .option('--debug <namespaces>', 'Debug namespaces (e.g., "sync-coordinator:*")')
  .action(async (options) => {
    // Enable debug logging if specified
    if (options.debug) {
      debug.enable(options.debug);
    }

    // Build overrides from CLI options
    const overrides: PartialCoordinatorConfig = {};

    if (options.host) overrides.host = options.host;
    if (options.port) overrides.port = options.port;
    if (options.basePath) overrides.basePath = options.basePath;
    if (options.dataDir) overrides.dataDir = options.dataDir;

    if (options.corsOrigin) {
      if (options.corsOrigin === 'true') {
        overrides.cors = { origin: true };
      } else if (options.corsOrigin === 'false') {
        overrides.cors = { origin: false };
      } else {
        overrides.cors = { origin: options.corsOrigin.split(',').map((o: string) => o.trim()) };
      }
    }

    if (options.authMode) {
      overrides.auth = { mode: options.authMode };
    }
    if (options.authTokens) {
      overrides.auth = overrides.auth || { mode: 'token-whitelist' };
      overrides.auth.tokens = options.authTokens.split(',').map((t: string) => t.trim());
    }

    // Load configuration
    const config = loadConfig({
      configPath: options.config,
      overrides,
    });

    console.log('Starting sync-coordinator...');
    console.log(`  Host: ${config.host}`);
    console.log(`  Port: ${config.port}`);
    console.log(`  Base path: ${config.basePath}`);
    console.log(`  Data dir: ${config.dataDir}`);
    console.log(`  Auth mode: ${config.auth.mode}`);

    try {
      const server = await createCoordinatorServer({ config });

      // Handle shutdown signals
      const shutdown = async () => {
        console.log('\nShutting down...');
        await server.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);

      await server.start();
    } catch (err) {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  });

program.parse();

