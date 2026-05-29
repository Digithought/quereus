description: Accept recursive-CTE `on-commit-incremental` MV bodies by classifying the whole MV as `'global'` so any source mutation triggers a full `rebuildBacking` at COMMIT (correctness-first whole-MV recompute; the proven manual-refresh path). Removes the create-time recursive rejection; true semi-naïve/DRed delta evaluation stays deferred to `materialized-view-recursive-semi-naive-delta`.
prereq: materialized-view-incremental-refresh
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md, docs/incremental-maintenance.md
----

## What was implemented

Exactly the two edits the plan ticket called for — no new evaluation machinery.

### 1. Build-time gate (`planner/building/materialized-view.ts`)

`rejectUnsupportedIncrementalBody` no longer throws for `select.withClause?.recursive`.
The set-op branch (bag-distinguishing `union`/`intersect`/`except` at the top
level) is unchanged. Recursive eligibility now resolves in `compile()` at create
time; create stays all-or-nothing (a `compile()` throw still rolls the MV back).
The function's docstring was updated to explain the new routing.

### 2. `compile()` recursion short-circuit (`core/database-materialized-views.ts`)

Immediately after the empty-source guard and **before** the `findAggregate` /
join branches, `compile()` now detects recursion and short-circuits:

```ts
const agg = findAggregate(analyzed);
if (containsNodeType(analyzed, PlanNodeType.RecursiveCTE)) {
  for (const [relKey, ref] of tableRefByRelKey) {
    const base = `${ref.tableSchema.schemaName}.${ref.tableSchema.name}`.toLowerCase();
    perRelation.set(relKey, { kind: 'global' });
    relationToBase.set(relKey, base);
  }
} else if (agg) { /* unchanged aggregate path */ }
else { /* unchanged row-preserving / join path */ }
```

Every collected source ref becomes `{ kind: 'global' }`; the residual loop already
`continue`s on `'global'` bindings (no `injectKeyFilter`/scheduler built), and the
subscription `apply` already routes `globalRelations.size > 0` → `rebuildBacking` +
`markBackingRebuilt`. `containsNodeType` / `PlanNodeType.RecursiveCTE` were already
imported. The pre-existing `const agg = findAggregate(...)` is still computed once;
it is simply unused on the recursive branch.

### Why this is correct (verified against the live code, not assumed)

- **`CTEReferenceNode.getChildren()` returns `[this.source]`** (the
  `RecursiveCTENode`), so both `containsNodeType` and `collectTableRefs` walk into
  the recursive definition. `collectTableRefs` finds the real source `edges` in
  **both** the base case and the recursive case's `join edges e`; the
  self-reference is an `InternalRecursiveCTERefNode` (not a `TableReferenceNode`)
  and is correctly excluded — so the dependency set is exactly the real sources.
- **`optimizeForAnalysis` preserves the `RecursiveCTENode`.** It runs only up to
  `PassId.Structural`; **no** rule file under `planner/rules/` references
  `RecursiveCTE` / `InternalRecursiveCTERef` (grepped — zero hits), so nothing
  rewrites it before the analysis gate reads it.
- **The global branch is the manual-refresh path.** The recursive MV's `apply`
  global branch calls the *same* `rebuildBacking` → `collectBodyRows(astToString(
  mv.selectAst))` → `replaceBaseLayer` that manual `refresh materialized view`
  and the cost-fallback demotion use. There is no recursive-specific recompute
  path that could diverge from `collectBodyRows`.
- **Delta executor** puts a `{ kind: 'global' }` binding into `globalRelations`
  (`runOne`: `if (binding.kind === 'global') { globalRelations.add(relKey); … }`).

## Validation (the floor — treat as a starting point)

- `yarn workspace @quereus/quereus run build` — clean.
- Full quereus suite (`yarn workspace @quereus/quereus run test`): **3793 passing,
  9 pending, 0 failing.**
- `eslint` — clean (single-quoted globs).
- New / changed sqllogic in `52-materialized-views-incremental.sqllogic`:
  - **§7 (edited):** removed the old `-- error: recursive` rejection. `mv_union`
    (`union`) still `-- error: set-operation`. Added `mv_rec_nosrc` — a *sourceless*
    recursive body now `-- error: at least one source table` (empty-source guard,
    not "recursive").
  - **§23 — transitive-closure oracle.** `edges(id pk, src, dst)`; parallel
    `reach_inc` (`on-commit-incremental`) and `reach_manual` (`manual`) over the
    identical distinct-`union` closure body. Hand-computed closures asserted for:
    create-time fixpoint; INSERT extends (auto-maintained, **no** refresh); the
    `manual` MV is shown stale until an explicit `refresh` resyncs it (demonstrates
    the auto-maintenance difference); DELETE that disconnects a subgraph **shrinks**
    the closure; an endpoint UPDATE (non-PK column); a `begin…commit` **bulk**
    insert recomputed once. Then a `union all` **diamond** body (two paths 1→4)
    `-- error: must be a set` (create-time full-rebuild fill enforces the set
    contract).
  - **§24 — precedence check.** A recursive body whose **outer query is a
    whole-table aggregate** (`select count(*) … from r`) — which a *non-recursive*
    body is rejected for — now **creates and maintains** (rebuild on insert),
    proving the recursion short-circuit runs before `findAggregate`.
- Existing specs re-run green: `materialized-view-diagnostics.spec.ts` (7),
  `51-materialized-views.sqllogic`, `delta-executor.spec.ts` (within the suite).

## Known gaps / where to probe (honest)

- **Recursion-detection fragility.** Correctness rests on the `RecursiveCTENode`
  surviving `optimizeForAnalysis`. True today (no structural rule touches it). If a
  future *structural* rule ever inlines/lowers a recursive CTE before Structural
  completes, `containsNodeType` would miss it and the body would fall through to
  the aggregate/join branches — most likely a surprising *rejection* (e.g. a
  recursive transitive closure mis-read as a join and gated), not a wrong-data bug,
  but worth a guard. A targeted analyzed-plan-shape unit test (assert the analyzed
  body still contains a `RecursiveCTE` node, and that `compile()` yields an
  all-`'global'` `perRelation`) would harden this — I did not add one.
- **Late bag on a `union all` recursive body is untested.** The create-time bag is
  covered (§23 `reach_dup`). A `union all` body that is duplicate-free at create
  but becomes a bag after a source change (e.g. inserting an edge that forms a
  diamond) would, on the post-commit global rebuild, hit `replaceBaseLayer`'s "must
  be a set"; the Tier-1 recovery rebuild runs the *same* body and hits it again →
  **Tier-2 `diverged`** (reads error until refresh). That is loud/correct and
  *differs* from the per-binding path's silent-dedup limitation — but I did not
  add a test exercising it. (A `union`/distinct recursive body can never become a
  late bag.)
- **Performance foot-gun (documented, not fixed).** Every source commit re-derives
  the whole fixpoint; the cost-fallback ratio is bypassed entirely (a `'global'`
  binding never reaches `getChangedTuples`/`getRowCount`). Even a 1-row insert
  triggers a full recompute. Intended — the perf win is the deferred ticket.
- **Recursive MV in a cascade is untested for recursion specifically.** A recursive
  MV's rebuild marks `globallyChangedBacking` (forcing dependents to rebuild), and
  a recursive body could read another MV's backing table. The cascading machinery
  is source-agnostic (per the cascading-convergence review), so this is low-risk,
  but no test layers a dependent on a recursive MV nor a recursive MV on another MV.
- **Self-reference exclusion not asserted directly.** Verified by code-reading and
  indirectly (a source insert triggers maintenance ⇒ `edges` is in `dependencies`);
  no test inspects the binding/dependency map to confirm the
  `InternalRecursiveCTERef` is excluded.
- **`-- error:` substrings** chosen: `set-operation`, `at least one source table`,
  `must be a set`. If those messages are reworded, update the assertions.
- **Cycles.** A `union` (distinct) recursive body over a cyclic graph terminates at
  the fixpoint; a `union all` body over a cycle loops unboundedly — that is generic
  recursive-query behavior, not MV-specific, and is untested here.

## Out of scope (deferred, ticket exists)

True incremental delta evaluation for recursive bodies (semi-naïve insert + DRed
delete) — `materialized-view-recursive-semi-naive-delta` (already in `backlog/`).
Do not attempt it as part of this review.

## Docs updated

- `docs/materialized-views.md` — Eligibility now lists recursive CTEs as
  *accepted-but-global* (with the shrinking-delete correctness note and the
  no-source caveat), removed from the "Rejected up front" list, and the `union all`
  late-bag note added; the roadmap "Incremental refresh" bullet marks recursive
  bodies *delivered (global-rebuild)* pointing at the deferred ticket.
- `docs/incremental-maintenance.md` — the MaterializedViewManager "Bindings are
  derived" wrinkle now records recursive bodies as the deliberate whole-MV
  `'global'` exception.
