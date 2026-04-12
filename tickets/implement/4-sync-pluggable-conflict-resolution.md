description: Add a pluggable conflict resolution strategy to quereus-sync, with column-level LWW as the default
dependencies: none (self-contained within quereus-sync)
files:
  - packages/quereus-sync/src/sync/protocol.ts (SyncConfig, types)
  - packages/quereus-sync/src/sync/conflict-resolvers.ts (new — built-in strategies)
  - packages/quereus-sync/src/sync/change-applicator.ts (resolveChange — call resolver)
  - packages/quereus-sync/src/sync/sync-context.ts (SyncContext — add resolver)
  - packages/quereus-sync/src/sync/sync-manager-impl.ts (thread resolver through)
  - packages/quereus-sync/src/sync/events.ts (ConflictEvent — add schema field)
  - packages/quereus-sync/src/create-sync-module.ts (pass resolver from options)
  - packages/quereus-sync/src/index.ts (export new types and built-in resolvers)
  - packages/quereus-sync/test/sync/conflict-resolvers.spec.ts (new — unit tests)
  - docs/sync.md (document pluggable conflict resolution)
----

## Overview

Add an optional `conflictResolver` to `SyncConfig` that is invoked when a remote column change conflicts with a local value. The default is LWW (current behavior). Schema conflicts remain non-pluggable.

## Types

In `protocol.ts`, add:

```typescript
interface ConflictContext {
  schema: string;
  table: string;
  pk: SqlValue[];
  column: string;
  localValue: SqlValue;
  localHlc: HLC;
  remoteValue: SqlValue;
  remoteHlc: HLC;
}

type ConflictResolution = 'local' | 'remote';

type ConflictResolver = (ctx: ConflictContext) => ConflictResolution;
```

Add `conflictResolver?: ConflictResolver` to `SyncConfig`. Do NOT set a default in `DEFAULT_SYNC_CONFIG` — the absence of the resolver means the fast-path `shouldApplyWrite()` HLC comparison can be used directly (avoids the extra `getColumnVersion` call when no custom resolver is configured).

## Built-in Resolvers

Create `conflict-resolvers.ts` with three named exports:

```typescript
/** Default: higher HLC wins, site ID breaks ties (same as compareHLC > 0) */
export const lwwResolver: ConflictResolver = (ctx) =>
  compareHLC(ctx.remoteHlc, ctx.localHlc) > 0 ? 'remote' : 'local';

/** Local value always wins (target-wins) */
export const localWinsResolver: ConflictResolver = () => 'local';

/** Remote value always wins (source-wins) */
export const remoteWinsResolver: ConflictResolver = () => 'remote';
```

## Change Applicator Integration

In `resolveChange()` (`change-applicator.ts`), the column-change branch (line 211+) currently:
1. Calls `ctx.columnVersions.shouldApplyWrite(...)` — a pure HLC comparison
2. If false, emits conflict event with `winner: 'local'`
3. If true, checks tombstone blocking, then emits conflict event with `winner: 'remote'`

With the pluggable resolver, the logic changes to:

```
if (ctx.config.conflictResolver) {
  // Custom resolver path: always need the local version for context
  const localVersion = await ctx.columnVersions.getColumnVersion(...);
  if (localVersion) {
    const resolution = ctx.config.conflictResolver({
      schema, table, pk, column,
      localValue: localVersion.value, localHlc: localVersion.hlc,
      remoteValue: change.value, remoteHlc: change.hlc,
    });
    if (resolution === 'local') {
      // emit conflict event with winner: 'local', return 'conflict'
    }
    // else fall through to tombstone check + apply
  }
  // no local version → first write → apply
} else {
  // Original fast path: pure HLC comparison via shouldApplyWrite()
  // (existing code, unchanged)
}
```

Key points:
- When no `conflictResolver` is configured, the existing fast path is preserved exactly (no perf regression).
- When a `conflictResolver` IS configured, we must fetch the local column version to pass both values/HLCs to the resolver. This is one extra KV read per conflicting column.
- Tombstone/resurrection logic (`allowResurrection`) remains orthogonal and is checked AFTER the resolver, same as today.
- The `ConflictEvent` emitted to `syncEvents.emitConflictResolved()` should reflect the resolver's decision in its `winner` field, which it already will since we set `winner` based on the resolution.

## ConflictEvent Enhancement

Add the `schema` field to `ConflictEvent` in `events.ts` — currently it's missing, but `ConflictContext` includes it, and it's useful for event consumers:

```typescript
interface ConflictEvent {
  readonly schema: string;   // <-- add this
  readonly table: string;
  // ... rest unchanged
}
```

Update the two emit sites in `change-applicator.ts` to include `schema: change.schema`.

## SyncContext

No changes needed to the `SyncContext` interface — the resolver is accessed via `ctx.config.conflictResolver`, and `config` is already on the context.

## CreateSyncModule / SyncManagerImpl

`CreateSyncModuleOptions` already extends `Partial<SyncConfig>`, so `conflictResolver` will be available in options automatically. The spread in `createSyncModule` (`...configOverrides`) already passes it through to `fullConfig`. No code changes needed here beyond the type addition to `SyncConfig`.

## Exports

In `index.ts`, add to the protocol exports:
- `type ConflictContext`
- `type ConflictResolution`
- `type ConflictResolver`

Add new export block for built-in resolvers:
- `lwwResolver`
- `localWinsResolver`
- `remoteWinsResolver`

## Testing

Tests in `test/sync/conflict-resolvers.spec.ts`:

- **LWW resolver (default behavior preserved)**: Apply changes with no `conflictResolver` set. Verify older HLC loses, newer HLC wins — same as existing tests but confirming no regression.
- **localWinsResolver**: Two replicas write to the same column. Remote has higher HLC. With `localWinsResolver`, local value is preserved. Verify `ConflictEvent` has `winner: 'local'`.
- **remoteWinsResolver**: Two replicas write to the same column. Remote has lower HLC. With `remoteWinsResolver`, remote value is applied. Verify `ConflictEvent` has `winner: 'remote'`.
- **Custom resolver (field-level policy)**: A resolver that returns `'remote'` for column `"counter"` (max-wins simulation) and `'local'` for everything else. Verify per-column behavior.
- **Resolver receives correct context**: Spy on a custom resolver, verify `ConflictContext` fields are populated correctly (schema, table, pk, column, both values, both HLCs).
- **No local version (first write)**: When there's no existing local value, the resolver is NOT called and the remote change is applied directly.
- **Tombstone blocking still works**: With `remoteWinsResolver` + `allowResurrection: false`, a write to a tombstoned row is still blocked (resolver decision is orthogonal to tombstone logic).

## Documentation

Update `docs/sync.md`:
- In the "Conflict Resolution" section, mention that the strategy is pluggable via `conflictResolver` on `SyncConfig`.
- Add a brief subsection showing usage of built-in resolvers and a custom resolver example.
- Note that schema conflicts remain non-pluggable.

----

## TODO

### Phase 1: Types and built-in resolvers
- Add `ConflictContext`, `ConflictResolution`, `ConflictResolver` types to `protocol.ts`
- Add `conflictResolver?: ConflictResolver` to `SyncConfig`
- Create `conflict-resolvers.ts` with `lwwResolver`, `localWinsResolver`, `remoteWinsResolver`
- Add `schema` field to `ConflictEvent` in `events.ts`

### Phase 2: Integration
- Update `resolveChange()` in `change-applicator.ts` to call the resolver when configured
- Update conflict event emissions to include `schema` field
- Add new exports to `index.ts`

### Phase 3: Tests
- Create `test/sync/conflict-resolvers.spec.ts` with the test cases listed above
- Run existing sync tests to verify no regressions

### Phase 4: Docs
- Update `docs/sync.md` with pluggable conflict resolution documentation
