# @quereus/sync-coordinator

Standalone coordinator backend for [@quereus/sync](../quereus-sync) — a production-ready server for multi-master CRDT replication.

## Features

- **Production Ready**: Built with Fastify for high performance
- **Transport Flexibility**: HTTP polling and WebSocket real-time push
- **Extensible Hooks**: Custom authentication, authorization, and change validation
- **Zero Configuration**: Sensible defaults, configurable via CLI, env, or file

## Installation

```bash
npm install @quereus/sync-coordinator
```

## Quick Start

### CLI

```bash
# Start with defaults (port 3000, no auth)
npx sync-coordinator

# Custom port and debug logging
npx sync-coordinator --port 8080 --debug "sync-coordinator:*"

# With token authentication
npx sync-coordinator --auth-mode token-whitelist --auth-tokens "secret1,secret2"
```

### Programmatic

```typescript
import { createCoordinatorServer, loadConfig } from '@quereus/sync-coordinator';

const config = loadConfig({
  overrides: {
    port: 8080,
    dataDir: './data',
  }
});

const server = await createCoordinatorServer({ config });
await server.start();
```

## Configuration

Configuration sources (highest priority first):
1. CLI arguments
2. Environment variables
3. Config file (`sync-coordinator.json`)
4. Defaults

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SYNC_HOST` | Host to bind | `0.0.0.0` |
| `SYNC_PORT` | Port to listen | `3000` |
| `SYNC_BASE_PATH` | Base path for routes | `/sync` |
| `SYNC_DATA_DIR` | LevelDB data directory | `./.data` |
| `SYNC_CORS_ORIGIN` | CORS origins (`true`, `false`, or comma-separated) | `true` |
| `SYNC_AUTH_MODE` | Auth mode: `none`, `token-whitelist` | `none` |
| `SYNC_AUTH_TOKENS` | Comma-separated allowed tokens | — |

### CLI Options

```bash
npx sync-coordinator --help
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sync/status` | GET | Health check and stats |
| `/sync/metrics` | GET | Prometheus metrics |
| `/sync/changes` | GET | Get changes since HLC |
| `/sync/changes` | POST | Apply changes |
| `/sync/snapshot` | GET | Stream full snapshot |
| `/sync/ws` | WS | WebSocket for real-time sync |

## Prometheus Metrics

The `/sync/metrics` endpoint exposes metrics in Prometheus format:

```
sync_websocket_connections_active    # Current WebSocket connections
sync_websocket_connections_total     # Total connections since startup
sync_http_requests_total             # HTTP requests by endpoint/status
sync_changes_applied_total           # Changes applied
sync_changes_received_total          # Changes received from clients
sync_changes_rejected_total          # Changes rejected during validation
sync_auth_attempts_total             # Authentication attempts
sync_auth_failures_total             # Authentication failures
sync_apply_changes_duration_seconds  # Apply operation duration histogram
sync_get_changes_duration_seconds    # Get changes duration histogram
```

## Custom Hooks

Extend the coordinator with custom logic:

```typescript
import { createCoordinatorServer, loadConfig, type CoordinatorHooks } from '@quereus/sync-coordinator';

const hooks: CoordinatorHooks = {
  async onAuthenticate(ctx) {
    const user = await verifyJWT(ctx.token);
    return { userId: user.id, siteId: ctx.siteId! };
  },
  
  async onAuthorize(client, operation) {
    return checkPermissions(client.userId, operation);
  },
  
  async onBeforeApplyChanges(client, changes) {
    // Filter or reject changes
    return { approved: changes, rejected: [] };
  }
};

const server = await createCoordinatorServer({ 
  config: loadConfig(), 
  hooks 
});
```

## Debug Logging

Uses the `debug` library:

```bash
# All coordinator logs
DEBUG=sync-coordinator:* npx sync-coordinator

# Specific namespaces
DEBUG=sync-coordinator:ws,sync-coordinator:auth npx sync-coordinator
```

Namespaces: `server`, `http`, `ws`, `service`, `auth`, `config`

## Development

```bash
npm run build    # Compile TypeScript
npm run dev      # Build and run
npm test         # Run tests
```

## Related Packages

- [`@quereus/sync`](../quereus-sync/) - Client-side sync module
- [`@quereus/sync-client`](../quereus-sync-client/) - WebSocket sync client
- [`@quereus/store`](../quereus-store/) - Storage base layer

## License

MIT

