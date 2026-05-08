description: Review the new optional `beginSchemaBatch`/`endSchemaBatch` module-level hooks fired by APPLY SCHEMA's migration-DDL loop. Capability-keyed: hook absent → today's behaviour exactly.
files:
  packages/quereus/src/vtab/module.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/test/schema-batch-hook.spec.ts
  docs/schema.md
----

## What landed

### Engine surface (`packages/quereus/src/vtab/module.ts`)

Two new optional methods on `VirtualTableModule`:

- `beginSchemaBatch(db, schemaName)` — called once before the migration-DDL loop runs, only when there is at least one statement to execute.
- `endSchemaBatch(db, schemaName, error?)` — called exactly once per successful begin, on both success (`error` undefined) and failure (`error` is the loop failure being propagated).

Modules without the hooks pay nothing — they're skipped via `typeof === 'function'` in `beginSchemaBatchAll`.

### Module enumeration (`packages/quereus/src/schema/manager.ts`)

Added `allModules()` generator to `SchemaManager`:

```ts
*allModules(): IterableIterator<{ name: string; module: AnyVirtualTableModule; auxData?: unknown }>
```

Iterates the module registry in registration order without exposing the internal map shape.

### Migration loop (`packages/quereus/src/runtime/emit/schema-declarative.ts`)

`emitApplySchema` now branches on `migrationStatements.length === 0`:

- Empty → idempotency fast-path: no batch hooks fire. (Original code path otherwise unchanged.)
- Non-empty → `runBatchedMigrationLoop()`:
  - `beginSchemaBatchAll(db, schemaName)` walks every registered module that defines `beginSchemaBatch` and calls it; on a begin-failure, already-started modules receive `endSchemaBatch(error)` in reverse order and the original error rethrows.
  - The existing per-DDL `_execWithinTransaction` loop and its `QuereusError` wrapping run inside try/catch.
  - `finally` calls `endSchemaBatchAll(startedModules, db, schemaName, loopError)` in reverse registration order. `loopError === undefined` on success; the loop error otherwise.
  - End-error policy: on the success path, the first end-error is captured and rethrown after every remaining end fires. On the failure path, end-errors are logged but never shadow the original loop error.

The seed-data block (`applyStmt.withSeed`) is untouched and runs after the batch's `endSchemaBatch` fires.

## Test cases (`packages/quereus/test/schema-batch-hook.spec.ts`)

The spec uses a `RecordingMemoryModule` (extends `MemoryTableModule`) registered as the default vtab for the test database, so the canonical `create table foo (...)` migration DDL routes through it. The recording module captures begin/end/create calls and exposes a `batchActive` flag that `create` consults.

Six passing cases:

1. **Pass-through** — module without hooks (default `MemoryTableModule`) produces the same final catalog as today (two declared tables registered with expected columns).
2. **Begin/End ordering** — recording module sees exactly one `beginSchemaBatch` and one `endSchemaBatch` (with `error === undefined`) around a 2-table migration; the loop body ran ≥2 times via the recorded `create` calls.
3. **Visibility from xCreate** — every `create` call recorded `batchActive === true`; after `endSchemaBatch` fires, `batchActive === false`.
4. **Error propagation** — module configured to throw from the 2nd table's `create`. Exception propagates from `apply schema`, `endSchemaBatch` fires exactly once with the loop error attached, `batchActive === false`.
5. **Idempotency fast-path** — second `apply schema` against an already-up-to-date schema: zero additional begin/end/create calls.
6. **Begin-failure** — module's `beginSchemaBatch` throws. No DDL runs (no `create` calls), end is *not* called for the failing module, the begin error propagates, no table registered.

## Validation

- `yarn lint` (packages/quereus): clean.
- `yarn test` (full repo): all suites pass; quereus core 2643 passing including the 6 new ones.

## Review hints

- **Surface cleanliness** — the new hooks are optional (`?`) on `VirtualTableModule`; existing modules are unaffected. The `allModules()` iterator is a cheap pass over the registry; no new state.
- **Error policy** — the begin-failure cleanup loop and the success-vs-failure end-error swallowing rules are subtle; verify against the doc comments on the interface methods and the inline `log()` lines in `endSchemaBatchAll`.
- **Idempotency** — the fast-path is a single `if (migrationStatements.length > 0)` guard before `runBatchedMigrationLoop`; the seed-data block sits unconditionally below, so `apply schema main with seed` against an unchanged schema still seeds without firing batch hooks. (Not separately tested — flag if you want a case for that.)
- **Seed timing** — seed data still runs through normal write paths after the batch closes. Batching seeds was explicitly out of scope per the implement ticket.
- **Cross-platform** — pure async/await, no Node-specific APIs, no FS or process state.

## Docs

- `docs/schema.md` — added a new "Module Batch Hooks" subsection under "Declarative Schema" (above "Seed Data") describing the contract, the begin-failure fan-out, and the rethrow-vs-log policy. Single paragraph as scoped.
- `docs/architecture.md` was checked; it does not enumerate vtab module hooks, so no update there (per implement-ticket guidance).

## End
