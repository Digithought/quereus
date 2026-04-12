description: Add a pluggable conflict resolution strategy to quereus-sync, with column-level LWW as the default
dependencies: quereus-sync (existing CRDT merge logic)
files: docs/sync.md, packages/quereus-sync/src/
----

## Motivation

The sync module currently hardcodes column-level LWW (highest HLC wins) for data conflicts and "most destructive wins" for schema conflicts. There's no way for consumers to customize this behavior.

Use cases for custom strategies include:

- **Target always wins**: The receiving replica preserves its own value regardless of HLC. Useful when a server is the authoritative source and should never be overwritten by client changes.
- **Source always wins**: The incoming change always takes precedence. Useful for push-based replication where the sender is authoritative.
- **Field-level policies**: Different columns may need different strategies (e.g., LWW for most fields, but max-wins for a counter, or merge for a JSON blob).
- **Application-level merge**: Callback to application code for domain-specific resolution (e.g., merging shopping carts, combining edit histories).

## Design

### Conflict Resolution Hook

A `conflictResolver` callback on `SyncConfig` that is invoked whenever a remote change conflicts with a local value. The default implementation is the current LWW behavior.

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

interface SyncConfig {
  // ... existing fields ...

  /**
   * Custom conflict resolution strategy.
   * Called when a remote column write conflicts with a local value.
   * Default: LWW (higher HLC wins; site ID breaks ties).
   */
  conflictResolver?: ConflictResolver;
}
```

### Schema Conflicts

Schema conflicts (the "most destructive wins" hierarchy) should remain non-pluggable for now. Allowing arbitrary schema conflict resolution opens up dangerous inconsistencies (e.g., one replica drops a column while another adds data to it). The hook applies to data conflicts only.

If schema conflict customization is needed later, it can be added as a separate `schemaConflictResolver` with a more constrained API.

### Built-in Strategies

Provide a few common strategies as named exports:

```typescript
/** Default: higher HLC wins, site ID breaks ties */
export const lwwResolver: ConflictResolver = ...;

/** Local value always wins (target-wins) */
export const localWinsResolver: ConflictResolver = ...;

/** Remote value always wins (source-wins) */
export const remoteWinsResolver: ConflictResolver = ...;
```

### Integration Points

The merge decision currently lives in the column-change application path. The resolver needs to be threaded through to wherever `applyChanges` compares local vs remote HLCs for column values. The tombstone/resurrection logic (`allowResurrection`) is orthogonal and should remain separate.
