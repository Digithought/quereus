description: Pluggable conflict resolution strategy for quereus-sync with column-level LWW default
files:
  - packages/quereus-sync/src/sync/protocol.ts (ConflictContext, ConflictResolution, ConflictResolver types; conflictResolver on SyncConfig)
  - packages/quereus-sync/src/sync/conflict-resolvers.ts (lwwResolver, localWinsResolver, remoteWinsResolver)
  - packages/quereus-sync/src/sync/change-applicator.ts (resolveChange — custom resolver branch + original fast path)
  - packages/quereus-sync/src/sync/events.ts (ConflictEvent — added schema field)
  - packages/quereus-sync/src/index.ts (new exports)
  - packages/quereus-sync/test/sync/conflict-resolvers.spec.ts (8 test cases)
  - docs/sync.md (pluggable conflict resolution docs)
----

## What was built

Added an optional `conflictResolver` field to `SyncConfig` that lets callers plug in a custom strategy for column-level conflicts. Three built-in resolvers are exported: `lwwResolver`, `localWinsResolver`, `remoteWinsResolver`.

When no resolver is configured, the original fast-path (`shouldApplyWrite()` HLC comparison) is preserved exactly — no performance regression. When a resolver IS configured, the local column version is fetched so both values/HLCs can be passed to the resolver. Tombstone/resurrection logic remains orthogonal (checked after resolver).

`ConflictEvent` now includes a `schema` field for event consumers.

## Key design points

- **No default in DEFAULT_SYNC_CONFIG** — absence of resolver means the fast-path HLC comparison fires directly, avoiding the extra `getColumnVersion` call.
- **Tombstone blocking is orthogonal** — checked after resolver decision, same as before.
- **Schema conflicts remain non-pluggable** — only column-level data conflicts go through the resolver.

## Testing notes

8 new tests in `conflict-resolvers.spec.ts`:
- Default LWW behavior preserved (no resolver)
- `localWinsResolver`: local kept even when remote has higher HLC
- `remoteWinsResolver`: remote accepted even when local has higher HLC
- Custom field-level policy: different strategy per column
- Resolver receives correct `ConflictContext` fields (spy)
- No local version → resolver not called, remote applied directly
- Tombstone blocking works regardless of resolver
- `lwwResolver` (explicit) matches default fast path
- `ConflictEvent` includes `schema` field

All 163 tests pass. Type check clean.

## Usage

```typescript
import { createSyncModule, localWinsResolver } from '@quereus/sync';
import type { ConflictResolver } from '@quereus/sync';

// Built-in resolver
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: localWinsResolver,
});

// Custom resolver
const resolver: ConflictResolver = (ctx) => {
  if (ctx.column === 'counter') return 'remote';
  return 'local';
};
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: resolver,
});
```
