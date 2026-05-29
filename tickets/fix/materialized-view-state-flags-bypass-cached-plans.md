description: A materialized view's build-time read-state flags (`diverged`, `stale`) are bypassed by already-cached prepared-statement plans — a query planned before the flag was set keeps reading the backing table and returns wrong/stale rows with no error, defeating the "no silent wrong reads" guarantee.
files: packages/quereus/src/planner/building/select.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/schema.ts
----

## Problem

Both materialized-view read-state guards live in `select.ts` `buildFrom`
(`mvSchema.diverged` → unconditional error; `mvSchema.stale` → body re-validation),
i.e. they fire at **plan-build time**. A `Statement` caches its optimized plan and
only recompiles when a schema-change *event* invalidates one of its tracked
dependencies (see `statement.ts` — `schemaChangeUnsubscriber`, `needsCompile`).

The `diverged` flag is set on the **post-commit incremental-maintenance path**
(`database-materialized-views.ts` `apply` catch → `mv.diverged = true`) **without
emitting any schema-change event**. So a prepared statement that was planned
against the MV *before* it diverged keeps its cached plan, reads the backing table
directly, and returns the (now wrong) rows with **no error** — exactly the silent
wrong read the parent ticket set out to prevent.

`stale` has the **same** bypass for the same reason (it is set by the schema-change
subscription, but a cached `select <cols> from mv` statement depends on the backing
table, not the source, so the source's `table_modified` event does not invalidate
it). The parent ticket inherited the limitation; it did not introduce it.

### Reproduction (verified during review)

```ts
const stmt = await db.prepare('select id, x from mv order by id');
for await (const r of stmt.iterateRows()) { /* plan cached here */ }

db._setMaterializedViewMaintenanceFault(p => {
  if (p === 'residual' || p === 'rebuild') throw new Error('inject');
});
await db.exec('update t set x = 999 where id = 2;');   // -> mv.diverged === true

await stmt.reset();
for await (const r of stmt.iterateRows()) { /* RETURNS OLD ROWS, NO ERROR */ }
// A *fresh* `db.eval('select ... from mv')` errors correctly.
```

The same shape reproduces for `stale` via a source `alter table ... add column`.

## Expected behavior

A read against an MV whose `diverged` (or `stale`) flag is set must surface the
diagnostic regardless of whether the reading statement's plan was cached before the
flag flipped. No code path should silently serve diverged/stale backing rows.

## Notes for the implementer (design space, not a plan)

- The flags are runtime-only and currently toggle without notifying the
  statement-cache invalidation machinery. Candidate directions:
  - Emit a schema-change / invalidation signal for the MV (and/or its backing
    table) when `diverged`/`stale` toggles, so dependent cached plans recompile and
    re-hit the build-time guard. The `diverged` set happens in the post-commit
    window — confirm emitting an invalidation event there is safe.
  - Or move the guard from plan-build time to emit/runtime (check the live flag when
    the backing-table scan actually runs), so it is immune to plan caching.
- Whatever the fix, cover **both** `diverged` and `stale` — they share the gap.
- Regression test: prepare a statement, flip the flag via the existing
  `_setMaterializedViewMaintenanceFault` seam (diverged) and a source schema change
  (stale), then re-execute the *same* prepared statement and assert it errors.

## Related

- Parent: `materialized-view-incremental-apply-failure-visibility` (added the
  `diverged` flag + two-tier recovery; its docs now carry a caveat pointing here).
