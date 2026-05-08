description: Add optional module-level `beginSchemaBatch`/`endSchemaBatch` callbacks. `emitApplySchema` invokes them around the migration-DDL loop so vtab modules (Lamina) can fold an APPLY SCHEMA into a single substrate commit. Capability-keyed: hook absent → today's behaviour exactly.
files:
  packages/quereus/src/vtab/module.ts (add optional callbacks to `VirtualTableModule` interface)
  packages/quereus/src/runtime/emit/schema-declarative.ts (`emitApplySchema` — wrap the DDL loop at lines 124-139)
  packages/quereus/src/schema/manager.ts (expose iterator over registered modules; already has `modules` Map)
  packages/quereus/src/index.ts (re-export type if any new types are introduced — keep surface minimal)
  packages/quereus/test/schema-batch-hook.spec.ts (new test file)
----

## Architecture

### Shape: module-level callbacks (option B from the plan)

Add two optional methods to `VirtualTableModule`:

```ts
/**
 * Optional. Called once by APPLY SCHEMA before the migration-DDL loop runs,
 * iff there are migration statements to execute. The module may use this to
 * open an in-memory overlay/batch that subsequent xCreate/destroy/alter
 * callbacks (during the loop) join, so the whole APPLY SCHEMA produces a
 * single substrate commit.
 *
 * The hook runs inside the engine's exec() mutex hold, so the batch lives
 * entirely within one engine-level execution scope.
 *
 * Modules that own no tables in `schemaName` should no-op.
 */
beginSchemaBatch?(db: Database, schemaName: string): Promise<void>;

/**
 * Optional. Called exactly once per successful `beginSchemaBatch`, on both
 * success (`error` undefined) and failure (`error` is the failure that
 * aborted the migration loop). On error, the module should discard the
 * in-flight overlay; on success, it commits.
 *
 * Errors thrown from `endSchemaBatch` itself are logged and rethrown only
 * if no prior loop error exists — if a loop error is being propagated, the
 * end-batch failure is logged and swallowed so the original cause survives.
 */
endSchemaBatch?(db: Database, schemaName: string, error?: unknown): Promise<void>;
```

Rationale (vs the database-capability variant): the batch context is module-
internal (Lamina's overlay vs Memory's no-op), and a single APPLY SCHEMA can
in principle touch multiple modules. Module-level callbacks let each module
own its own state without threading a batch handle through `RuntimeContext`,
and let mixed-module schemas batch only the modules that opt in.

### Engine flow in `emitApplySchema`

```
const migrationStatements = generateMigrationDDL(diff, schemaName);

if (migrationStatements.length === 0) {
    // idempotency fast-path: no batch, no hook calls
} else {
    const startedModules = await beginSchemaBatchAll(rctx.db, schemaName);
    let loopError: unknown = undefined;
    try {
        for (const ddl of migrationStatements) {
            await rctx.db._execWithinTransaction(ddl);  // unchanged
            // existing try/catch wraps with QuereusError on failure
        }
    } catch (e) {
        loopError = e;
        throw e;          // rethrown after endSchemaBatchAll fires in finally
    } finally {
        await endSchemaBatchAll(startedModules, rctx.db, schemaName, loopError);
    }
}
```

`beginSchemaBatchAll` iterates `db.schemaManager.getModules()` (new accessor),
calls `beginSchemaBatch?` on each, and returns the list of modules that
**successfully began** (so we don't call `endSchemaBatch` on a module that
threw during begin or never started). If a module's `beginSchemaBatch` throws,
we abort: call `endSchemaBatch` on already-started modules with the begin-time
error, then rethrow.

`endSchemaBatchAll` walks `startedModules` in reverse, calls `endSchemaBatch`
on each. Per-module errors during end:
- If `loopError === undefined`, capture the first end-error and rethrow at the
  end (after firing all remaining ends).
- If `loopError !== undefined`, log per-module end-errors but never let them
  shadow the original loop error.

Errors are logged via the existing `runtime:emit:declare` logger.

### Schema manager surface

`SchemaManager` already holds `private modules = new Map<string, { module, auxData }>()`.
Add a public accessor:

```ts
/** Iterate registered (name, module, auxData) tuples in registration order. */
*allModules(): IterableIterator<{ name: string; module: AnyVirtualTableModule; auxData?: unknown }> {
    for (const [name, reg] of this.modules) yield { name, module: reg.module, auxData: reg.auxData };
}
```

This avoids exposing the internal map shape; consumers iterate and filter on
the optional `beginSchemaBatch`/`endSchemaBatch`.

### Seed path is untouched

The `applyStmt.withSeed` block (lines 142-183) runs **after** the
batch's `endSchemaBatch` fires. Seed inserts go through the normal write
path. Batching seed data is out of scope.

### Visibility from xCreate

The module's own batch state lives in module-private fields. When `xCreate`
runs during the loop, the module consults its own "batch active" flag and
joins the in-flight overlay. The engine does not thread anything through
`RuntimeContext` — keeping the engine surface minimal.

### Capability gating / zero-cost for non-batching hosts

- `VirtualTableModule.beginSchemaBatch` is optional. Modules without it pay
  nothing — `beginSchemaBatchAll` skips them via `typeof === 'function'`.
- For an APPLY SCHEMA where every registered module lacks the hook, the
  loop runs exactly as today (the begin/end iteration is a couple of cheap
  passes over the modules map).

## Tests (new spec: `test/schema-batch-hook.spec.ts`)

Use Mocha + a tiny in-test vtab module that records calls. Build it on top
of the memory module pattern (or just mock the relevant module surface
sufficient for `CREATE TABLE` to drive the engine through the loop).

- **Pass-through**: APPLY SCHEMA on a module without the hook produces the
  same final catalog (table list, columns) as today. Sanity check against
  `MemoryTableModule`.
- **Begin/End ordering**: a recording host module sees `beginSchemaBatch`
  fire exactly once before the first migration DDL, and `endSchemaBatch`
  exactly once after the last DDL, with `error === undefined`. Use a
  declared schema with ≥2 tables to ensure the loop body runs ≥2 times.
- **Visibility from xCreate**: in the recording module's `create` callback,
  assert that the module's "batch active" flag is true. (Validates the
  contract: per-table callbacks during the loop see the active batch.)
- **Error propagation**: declared schema whose 2nd CREATE TABLE raises (e.g.
  duplicate column or invalid type). Assert: `endSchemaBatch` fires exactly
  once with the QuereusError as `error`, the original error propagates out
  of APPLY SCHEMA, and the module's overlay-discard path executed.
- **Idempotency fast-path**: APPLY SCHEMA against an already-up-to-date
  declared schema (empty `migrationStatements`). Assert neither
  `beginSchemaBatch` nor `endSchemaBatch` fires.
- **Begin-failure**: a module whose `beginSchemaBatch` throws. Assert: no
  DDL executed, `endSchemaBatch` not called for that module, exception
  propagates with the begin error preserved.

## TODO

Phase 1 — engine surface

- Add `beginSchemaBatch?` / `endSchemaBatch?` to `VirtualTableModule` in
  `packages/quereus/src/vtab/module.ts` with the doc comments above.
- Add `allModules()` iterator to `SchemaManager` in
  `packages/quereus/src/schema/manager.ts`.

Phase 2 — wire the loop

- In `packages/quereus/src/runtime/emit/schema-declarative.ts`
  `emitApplySchema`:
  - After `migrationStatements` is computed, branch on
    `migrationStatements.length === 0` → existing behaviour, no hooks.
  - Otherwise call a local helper `runBatchedMigrationLoop(rctx.db,
    schemaName, migrationStatements)` that:
    - Walks `db.schemaManager.allModules()` and collects modules with a
      `beginSchemaBatch` function.
    - Calls each `beginSchemaBatch` in order; on failure, calls
      `endSchemaBatch(error)` on already-started ones (in reverse) and
      rethrows.
    - Runs the existing per-DDL loop with its existing try/catch/QuereusError
      wrapping.
    - In `finally`, calls `endSchemaBatch` on `startedModules` in reverse,
      passing `loopError` (undefined on success).
  - Keep the seed-data block untouched, after the batched loop returns.
- Make sure `void` is used on any per-module promise we intentionally
  ignore (we don't — we await all of them).

Phase 3 — tests

- Add `packages/quereus/test/schema-batch-hook.spec.ts` exercising the six
  cases above.
- The recording module can extend the existing memory module via a thin
  wrapper, or implement only the methods the test paths need (`create`,
  `connect`, `destroy`, plus the new hooks). Look at
  `packages/sample-plugins/json-table/index.ts` for a minimal reference
  module shape.
- Run `yarn test` from the repo root and confirm pass; lint
  `packages/quereus` (single-quoted globs on Windows).

Phase 4 — docs

- Brief mention in `docs/schema.md` (or wherever DECLARE/APPLY SCHEMA is
  documented) that vtab modules may opt into a per-APPLY-SCHEMA batch via
  `beginSchemaBatch`/`endSchemaBatch`. One paragraph; do not re-document
  the whole schema-declarative pipeline.
- If `docs/architecture.md` lists vtab module hooks, add the new pair
  there too. Otherwise skip.
