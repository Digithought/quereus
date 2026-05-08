description: Add a host-supplied batch lifecycle around `emitApplySchema`'s migration-DDL loop so vtab modules (Lamina) can fold an entire APPLY SCHEMA into a single substrate commit. Capability-keyed so non-batching hosts pay nothing.
files:
  packages/quereus/src/runtime/emit/schema-declarative.ts (`emitApplySchema` — current per-DDL `_execWithinTransaction(ddl)` loop at lines 93-194 / inner loop 126-139)
  packages/quereus/src/core/database.ts (`_execWithinTransaction` at 573+; possibly add a sibling `_execWithinDDLBatch` or capability-keyed dispatch)
----

## Background

`emitApplySchema` runs each generated migration statement through
`db._execWithinTransaction(ddl)` in a serial loop. Every statement is its
own self-contained DDL execution from the engine's point of view: parse →
plan → emit → run → return.

For Lamina, every CREATE TABLE in that loop drives multiple substrate
commits (cellstore writes + a fact-log `appendSchemaFactGroup`). On a
44-table declaration this costs hundreds of `fdatasync` calls in series.
The architectural floor is **one** substrate commit for the whole APPLY
SCHEMA — the vtab module cannot reach that floor without a way to know
when the DDL loop starts and ends.

The lamina-side companion ticket is
`apply-schema-batched-overlay` in the lamina repo
(`tickets/backlog/optim/apply-schema-batched-overlay.md`); it depends on
the hook surface this ticket adds.

## Goal

Expose a capability-keyed lifecycle hook so the host (a vtab module, in
practice) can wrap the migration-DDL loop in a "schema batch":

```
emitApplySchema:
  beginBatch?  ← host opt-in; called once, before the migration loop
  for ddl of migrationStatements:
      _execWithinTransaction(ddl)   // unchanged
  endBatch?    ← called once, after the loop (also on error → endBatch(err))
```

Shape options (pick one in plan stage, but the surface must satisfy
all of):

- **Database capability**. A host registers a `schemaBatchHook` on
  `Database` (or via a known `db.<extension>` slot). `emitApplySchema`
  reads it via the runtime context and calls `beginBatch` / `endBatch`.
- **Module-level callback**. The vtab module that owns the schema's
  tables exposes optional `beginSchemaBatch` / `endSchemaBatch`
  callbacks; the engine resolves the relevant module(s) for the schema
  being applied and fans out.

The hook runs **inside** the existing `exec()` mutex hold, so the
host's batch context lives entirely within one engine-level transaction.

Vanilla Quereus hosts (no batching support) see no behaviour change:
hook absent → loop runs as today.

## Requirements

- Hook is opt-in and capability-gated. No new required surface for
  existing modules.
- `endBatch` is called exactly once per `beginBatch`, on both success
  and error paths. Error path receives the failure so the host can
  abort/discard its in-flight overlay rather than commit partial state.
- The hook surrounds the **migration-DDL loop only**, not the seed-data
  application that follows (`applyStmt.withSeed` — lines 142-183). Seed
  inserts go through the normal write path; batching them is a separate
  concern.
- Idempotency fast-path stays out of the hook: when `migrationStatements`
  is empty there is nothing to batch — `beginBatch` should not fire so
  the host doesn't start an empty overlay.
- The hook is observable from the vtab `xCreate` / equivalent table-
  creation callbacks during the loop (the host needs to thread the batch
  context into per-table work). Either the runtime context carries the
  active batch handle, or the host's own `Database` extension slot does
  — the design needs to make one of these explicit.

## Non-goals

- Changing `_execWithinTransaction` semantics. Each DDL inside the loop
  still parses, plans, and runs as today.
- Cross-statement DDL parallelism. The loop stays serial.
- Touching the seed-data path.

## Test ideas

- A no-op host (no hook registered) runs APPLY SCHEMA and produces the
  same observable outcome as today (golden-vector or table-shape parity
  on memory backend).
- A test host that records `beginBatch` / `endBatch` events sees exactly
  one of each per APPLY SCHEMA with ≥1 migration statement, in the
  expected order, with the host's batch context visible from the
  per-table vtab callback.
- An APPLY SCHEMA whose migration loop throws mid-way calls `endBatch`
  exactly once with the error; the host can roll back its in-flight
  state.
- An APPLY SCHEMA against an already-up-to-date schema (empty
  `migrationStatements`) does **not** call `beginBatch` / `endBatch`.
