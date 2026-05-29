description: Accept `with refresh = 'on-commit-incremental'` over a recursive-CTE body by maintaining it as a whole-MV global rebuild on any source change (correctness-first, full recompute per commit). Removes the create-time rejection; true incremental (semi-naïve/DRed) delta evaluation is deferred to backlog.
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, docs/materialized-views.md, docs/incremental-maintenance.md
----

## Problem & decision

A recursive CTE computes a fixpoint (transitive closure or similar). A single
changed source row can ripple through arbitrarily many iterations, so there is
**no bounded per-binding residual** that recomputes "the affected rows only".
The per-binding delete-then-upsert model the incremental MV manager uses
(`runResidual` + `injectKeyFilter`) fundamentally cannot maintain such a body —
which is exactly why `materialized-view-incremental-refresh` rejects recursive
bodies at create time today.

The acceptance bar in the original plan ticket is *correctness*: the MV must
"either maintain correctly on COMMIT … **or** continue to error clearly." There
is already an always-correct maintenance path in the manager for bodies it can't
bind per-row: the **`'global'` binding → `rebuildBacking`** route (the same
full-rebuild path manual `refresh` and the cost-fallback demotion use). It re-runs
the *whole* body via `collectBodyRows` — which for a recursive body is precisely
the correct fixpoint recomputation.

**Decision (Phase 1): accept recursive `on-commit-incremental` bodies by
classifying the whole MV as `'global'`, so any source mutation triggers a full
`rebuildBacking` at COMMIT.** This is correct (including the shrinking-closure
delete case — a from-scratch recompute is always right), zero new evaluation
machinery, and reuses the proven, fault-injection-tested rebuild path. It is *not*
incremental in the algorithmic sense — every source commit re-derives the fixpoint.
That trade is documented loudly; the user explicitly opted into commit-time
maintenance, and `manual` refresh remains for those who want control. True
incremental delta evaluation (semi-naïve insert + DRed delete) is genuinely
research-grade and is parked in `materialized-view-recursive-semi-naive-delta`.

## Why this integrates cleanly (verified against current code)

- **The global path already exists and is wired end-to-end.** In
  `database-materialized-views.ts` `buildSubscription` → `apply`:
  `if (input.globalRelations.size > 0) { await rebuildBacking(db, mv); … }`
  (around line 577). The `DeltaExecutor` puts a relation into `globalRelations`
  whenever its `BindingMode` is `{ kind: 'global' }`
  (`delta-executor.ts` `runOne`, the `binding.kind === 'global'` branch). Verified
  by `test/incremental/delta-executor.spec.ts` "dispatches 'global' bindings via
  globalRelations set".
- **`compile()` already skips residual compilation for `'global'` bindings**
  (`if (mode.kind === 'global') continue;` in the residual loop), so no
  `injectKeyFilter` / scheduler is built for them. Nothing else to suppress.
- **Dependencies are captured automatically.** `dependencies` (= `baseTablesInPlan`)
  is derived from `relationToBase`, which we populate from `collectTableRefs(analyzed)`.
  `RecursiveCTENode.getChildren()` returns `[baseCaseQuery, recursiveCaseQuery, …]`
  (recursive-cte-node.ts:94), and `collectTableRefs` recurses via `getChildren()`,
  so every real source `TableReferenceNode` in **both** the base and recursive
  cases is collected. The recursive self-reference is an
  `InternalRecursiveCTERefNode` (not a `TableReferenceNode`), so it is correctly
  *excluded* — only the genuine source tables (e.g. `edges`) become dependencies.
- **`rebuildBacking` runs recursive bodies correctly already** — it is the same
  code path as manual `refresh materialized view`, which works for recursive
  bodies today (see `test/logic/51-materialized-views.sqllogic` / recursive-CTE
  plan tests).

## Design

Two edits, both small:

### 1. Stop rejecting recursive bodies at build time

`planner/building/materialized-view.ts` — `rejectUnsupportedIncrementalBody`
currently throws for `select.withClause?.recursive`. Remove **only** that branch
(keep the bag-distinguishing set-op rejection). Eligibility for recursive bodies
now resolves in `compile()` at create time (create stays all-or-nothing: if
`compile()` throws for some *other* reason, the MV is rolled back as before).

### 2. Classify a recursive body as whole-MV global in `compile()`

`core/database-materialized-views.ts` — `compile()`. Immediately after
`collectTableRefs(analyzed)` and the empty-source guard, **before** the
`findAggregate(analyzed)` branch, detect recursion and short-circuit:

```
if (containsNodeType(analyzed, PlanNodeType.RecursiveCTE)) {
  // A recursive fixpoint has no bounded per-binding residual; maintain the
  // whole MV by full rebuild on any source change (always correct). True
  // incremental delta evaluation is tracked in
  // materialized-view-recursive-semi-naive-delta.
  for (const [relKey, ref] of tableRefByRelKey) {
    const base = `${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase();
    perRelation.set(relKey, { kind: 'global' });
    relationToBase.set(relKey, base);
  }
  // …fall through to the existing bindings/dependency/pkIndices assembly,
  //    which already handles an all-'global' perRelation (residual loop skips
  //    them; apply routes globalRelations → rebuildBacking).
}
```

Placing this **before** `findAggregate` matters: a recursive body whose outer
query aggregates or joins (`select count(*) from closure`, or the `r ⋈ edges`
join inside the recursive case) must not be misrouted into the aggregate /
non-inner-join rejections. Recursion-present ⇒ global, unconditionally and
conservatively.

`containsNodeType` and `PlanNodeType.RecursiveCTE` are already imported/used in
this file (the set-op check uses `containsNodeType(analyzed, PlanNodeType.SetOperation)`).
Detecting `PlanNodeType.RecursiveCTE` on the analyzed plan is sufficient;
`InternalRecursiveCTERef` need not be matched (it only appears *inside* a
`RecursiveCTENode`'s recursive case).

### Behavioral consequences (correct by construction)

- **Insert / update / delete on any source** → `rebuildBacking` recomputes the
  fixpoint from scratch. Shrinking-closure deletes (an edge removal that
  disconnects a subgraph) are handled correctly because rebuild does not
  incrementally subtract — it re-derives.
- **`union all` recursive body that yields duplicates** → `rebuildBacking` →
  `replaceBaseLayer` raises the existing `materializedViewNotASetError`
  ("must be a set"), consistent with create/refresh. A `union` (distinct)
  transitive closure is a set and materializes fine.
- **Cascading (recursive MV read by another incremental MV)** → the recursive
  MV's rebuild marks its backing base in `globallyChangedBacking`
  (`markBackingRebuilt`), forcing dependents to rebuild too. Already handled.
- **Apply-failure / diverged** → rebuild *is* the apply here; if it throws, the
  existing Tier-1/Tier-2 catch sets `diverged`. Unchanged.
- **Performance foot-gun (document, don't fix):** every source commit re-derives
  the whole closure (potentially O(V·E) or worse). Unlike non-recursive bodies,
  there is no per-row fast path — even a 1-row insert triggers a full recompute.
  This is the price of correctness-first; the perf win is the deferred research
  ticket.

## Key tests & expected outputs

### Oracle equivalence (the acceptance bar) — `52-materialized-views-incremental.sqllogic`

Add a recursive-CTE section. Pattern: one **`manual`** MV (the oracle, refreshed
explicitly) and one **`on-commit-incremental`** MV over the *same* transitive-closure
body; after each source mutation assert the incremental MV equals the manually
refreshed oracle.

```
create table edges (src integer, dst integer, primary key (src, dst));
insert into edges values (1,2),(2,3),(3,4);

create materialized view reach_inc as
  with recursive r(src, dst) as (
    select src, dst from edges
    union
    select r.src, e.dst from r join edges e on r.dst = e.src
  )
  select distinct src, dst from r
  with refresh = 'on-commit-incremental';

-- create-time fixpoint: 1→{2,3,4}, 2→{3,4}, 3→4
select * from reach_inc order by src, dst;
→ [{"src":1,"dst":2},{"src":1,"dst":3},{"src":1,"dst":4},{"src":2,"dst":3},{"src":2,"dst":4},{"src":3,"dst":4}]

-- INSERT extends the closure, auto-maintained at commit (no manual refresh)
insert into edges values (4,5);
select * from reach_inc order by src, dst;
→ (closure now includes 1→5, 2→5, 3→5, 4→5)

-- DELETE that disconnects a subgraph SHRINKS the closure (rebuild handles it)
delete from edges where src = 3 and dst = 4;
select * from reach_inc order by src, dst;
→ (every pair whose only path used 3→4 is gone: 1→4,1→5,2→4,2→5,3→4,3→5,4→5 recomputed correctly)
```

Expected outputs must be computed by hand (or cross-checked against a parallel
`manual` MV refreshed in the same script) so the assertion is a true oracle, not
a restatement of the implementation.

### Eligibility (`materialized-view-diagnostics.spec.ts` or a sqllogic `error` case)

- `create materialized view … with refresh='on-commit-incremental'` over a
  recursive body **now succeeds** (previously threw
  `…does not support recursive CTE bodies yet…`). Add a positive test; remove or
  invert any existing test asserting the rejection.
- A recursive `union all` body that produces duplicate rows still raises the
  "must be a set" diagnostic at create (full-rebuild path).

### Auto-update without manual refresh

Assert a recursive `on-commit-incremental` MV reflects a source insert on the
next read with no intervening `refresh` (mirrors the existing per-row section's
"reflected at commit, no manual refresh" assertions).

## Docs

- `docs/materialized-views.md` — in **Incremental refresh → Eligibility**, move
  recursive CTEs out of the "Rejected up front" list into an accepted-but-global
  note: recursive bodies are maintained via full rebuild on every source commit
  (correctness-first; not algorithmically incremental), with a forward pointer to
  `materialized-view-recursive-semi-naive-delta`. Update the **Out of scope /
  roadmap → Incremental refresh** bullet to mark recursive-CTE bodies *delivered
  (global-rebuild)* and reference the deferred true-incremental ticket.
- `docs/incremental-maintenance.md` — note recursive MV bodies bind whole-MV
  `'global'` (no per-binding residual) under the MaterializedViewManager section.

## TODO

- [ ] Remove the `select.withClause?.recursive` rejection branch in
      `rejectUnsupportedIncrementalBody` (planner/building/materialized-view.ts);
      keep the set-op branch.
- [ ] In `compile()` (core/database-materialized-views.ts), add the
      `containsNodeType(analyzed, PlanNodeType.RecursiveCTE)` short-circuit
      *before* `findAggregate`, setting every collected source ref to
      `{ kind: 'global' }` and populating `relationToBase`. Verify the existing
      bindings/dependency/pkIndices assembly and residual loop handle an
      all-`'global'` `perRelation` unchanged.
- [ ] Confirm (read-through, no code change expected) that
      `optimizeForAnalysis` preserves the `RecursiveCTENode` and that
      `collectTableRefs` yields the real source tables (not the internal
      recursive ref) as dependencies.
- [ ] Add the recursive-CTE oracle section to
      `52-materialized-views-incremental.sqllogic` (insert-extends, delete-shrinks,
      update, bulk; distinct-closure set body). Hand-verify expected rows.
- [ ] Add/adjust eligibility tests: recursive `on-commit-incremental` now creates
      successfully; recursive `union all` bag still raises "must be a set".
- [ ] Update `docs/materialized-views.md` and `docs/incremental-maintenance.md`
      per the Docs section.
- [ ] `yarn workspace @quereus/quereus run build`, then
      `yarn test 2>&1 | tee /tmp/mv-rec.log; tail -n 80 /tmp/mv-rec.log`, then
      lint (single-quoted globs on Windows). Fix any regressions in the MV /
      incremental suites.

## Handoff notes for review

- The whole correctness argument rests on `rebuildBacking` being identical to the
  manual-refresh recompute — confirm no recursive-specific path diverges from
  `collectBodyRows`.
- Watch for the cost-fallback / `getRowCount` interaction: a `'global'` binding
  bypasses the ratio check entirely (it never reaches `getChangedTuples`), so
  recursive MVs always rebuild regardless of change size — intended.
- The deferred true-incremental work is `materialized-view-recursive-semi-naive-delta`
  (backlog); do not attempt it here.
