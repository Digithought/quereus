---
description: Public Database.getTable() that returns a Table handle exposing per-table event subscription
files:
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/vtab/table.ts
  - packages/quereus/src/core/database-events.ts
  - packages/quereus/test/vtab-events.spec.ts
---

## Motivation

`vtab-events.spec.ts:310` carries a `describe.skip('getEventEmitter API', …)` block with
the note *"Database.getTable() API is not yet implemented"*. The intended ergonomic for
consumers wanting per-table reactivity is:

```ts
const table = db.getTable('main', 'users');
const emitter = table?.getEventEmitter?.();
emitter?.onDataChange((event) => { … });
```

Today the surface area is:

- `db.schemaManager.getTable(schema, name)` — internal, returns `TableSchema` (metadata),
  not a Table handle.
- `Table.getEventEmitter()` is declared optional on the vtab `Table` interface
  (`packages/quereus/src/vtab/table.ts:203`) and wired through
  `tryGetEventEmitter` for module-level subscription, but no public API exposes a Table
  instance to user code.
- `Database.getEventEmitter()` exists but returns the database-level
  `DatabaseEventEmitter`, not a per-table one.

## Scope

Design and implement a public `Database.getTable(schemaName, tableName): Table | undefined`
that returns a handle suitable for subscribing to data and schema change events for a
single table. Decide whether to expose the underlying vtab `Table` directly or wrap it in a
narrower public-facing interface (the latter avoids leaking vtab internals).

Cover the trio of common consumer needs: subscribe to row-level data changes, subscribe to
schema mutations affecting the table, and detach cleanly. Lifecycle question: what happens
to subscribers after `DROP TABLE` / table replacement? Document the contract.

Once the API exists, un-skip the `describe.skip` block in `vtab-events.spec.ts` and
expand it with subscription, unsubscription, and post-DROP behavior coverage.

## Out of scope

- New event types beyond what `VTableEventEmitter` already exposes.
- Cross-table or pattern-based subscriptions (separate concern).
