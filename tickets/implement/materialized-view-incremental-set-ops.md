description: Accept set-operation `on-commit-incremental` MV bodies (`union`/`intersect`/`except`, and `union all`) by classifying the whole MV as `'global'` so any source mutation triggers a full `rebuildBacking` at COMMIT (correctness-first whole-MV recompute — the proven manual-refresh path). Removes the create-time set-op rejections (build gate + `compile()`). True count-based incremental delta evaluation (multiplicity counters; per-binding `union all` fast path) stays deferred to `materialized-view-incremental-set-ops-delta`.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md
----

## Approach

This is the **exact same delivery shape** as the landed
`materialized-view-incremental-recursive-cte` ticket (commit `df1d3f6c`): a body
whose shape has no bounded per-binding residual is classified whole-MV
`'global'`, and any source mutation re-derives the entire body at COMMIT via
`rebuildBacking` (the same recompute manual `refresh` runs). Always correct
(insert/update/delete on either branch's sources, including rows that should
*vanish* because the other branch's multiplicity changed); not algorithmically
incremental.

Set operations are bag-distinguishing across branches: whether a recomputed row
belongs in the MV depends on the *full* state of both branches, not just the
changed tuples — precisely the property the per-binding residual cannot see. The
recursive-CTE path already solved the structurally identical "no bounded
residual" problem the cheap, correct way. We reuse it verbatim.

### Why globalize `union all` too (slightly beyond the named scope)

The plan ticket scoped this at bag-distinguishing ops only, noting `union all` is
"already eligible" via per-binding composition. In the **current** code `union
all` is *not* eligible — it survives the build gate but is rejected in `compile()`
by the op-agnostic `containsNodeType(analyzed, PlanNodeType.SetOperation)` throw
(see `database-materialized-views.ts:451`). So all four set ops error at create
today.

Globalizing the whole set-op family (the `compile()` check is already op-agnostic)
is the minimal, coherent move: it is a strict improvement for `union all`
(rejected → correct-but-global) and avoids the bizarre user-facing split where the
"harder" bag-distinguishing ops work but the "simpler" bag-additive one errors. A
genuine per-binding `union all` fast path (bag-additive branch composition) is a
real optimization but non-trivial (cross-branch backing-PK mapping over distinct
per-branch sources); it is deferred alongside the count-based delta work to
`materialized-view-incremental-set-ops-delta`.

### Correctness notes (verified against live code)

- **The walk reaches both branches and the real sources.**
  `SetOperationNode.getChildren()` → `[left, right]`
  (`set-operation-node.ts:58`), so `containsNodeType` and `collectTableRefs`
  descend into both legs. Dependencies become the union of both branches' source
  tables; a mutation to either triggers the rebuild.
- **The `SetOperation` node survives the analysis pass.** `optimizeForAnalysis`
  runs `executeUpTo(PassId.Structural)`; the only SetOperation rewrite
  (`async-gather-union-all`) is registered in `PassId.PostOptimization`, after the
  cutoff — so the node is intact when the gate reads it.
- **`diff` is covered.** `select-compound.ts` expands `diff` into nested
  `SetOperationNode`s (`(A except B) union (B except A)`), which the
  `containsNodeType` check catches.
- **Set-ness / "must be a set".** `union`/`intersect`/`except` produce sets
  (`SetOperationNode.getType().isSet` is true for all but `unionAll`), so the
  all-columns backing key holds and `rebuildBacking` → `replaceBaseLayer` never
  trips the duplicate-PK guard. A `union all` body that emits a genuine duplicate
  row is a **bag** → the create-time fill raises the existing "must be a set"
  diagnostic (same enforcement manual create/refresh use); a `union all` body that
  is duplicate-free at create but becomes a bag after a source edit diverges at
  COMMIT exactly like the recursive late-bag §25 case (Tier-1 rebuild re-hits the
  bag → Tier-2 `diverged`). No new machinery — this is the bag-body contract.
- **Empty-source set-op bodies still reject.** `values(1) union values(2)` reads
  no table → the size-0 guard fires before the set-op branch (nothing to trigger a
  rebuild from), consistent with recursive.
- **Global routing is capture-independent.** A `'global'` binding routes through
  `input.globalRelations.size > 0 → rebuildBacking + markBackingRebuilt` in the
  subscription `apply`; the trigger is `changedBases.has(base)` (driven by the
  subscription `dependencies`), not captured per-row tuples — so the residual loop
  and capture specs are bypassed, just like recursive.

## TODO

### Relax the build-time gate (`planner/building/materialized-view.ts`)
- `rejectUnsupportedIncrementalBody` currently throws only for `select.compound &&
  select.compound.op !== 'unionAll'` (recursive was removed by the prior ticket).
  Removing the set-op throw leaves the function with **no remaining checks** — it
  becomes a no-op. **Delete the function and its single call site** in
  `buildCreateMaterializedView` (no dead code; all surviving rejections —
  outer/anti/semi join, aggregate-over-join, DISTINCT-over-join, whole-table
  aggregate, no-PK source — live in `compile()` against the analyzed plan, where
  the comprehensive gate already is). Verify there are no other callers first.

### Add the `compile()` set-op short-circuit (`core/database-materialized-views.ts`)
- Add `else if (containsNodeType(analyzed, PlanNodeType.SetOperation))` **between**
  the recursive-CTE `if` and the `else if (agg)` — ordering matters: a set-op body
  whose branches aggregate (e.g. `select count(*) from a group by x union select
  count(*) from b group by y`) must classify global, not misroute into the
  single-source aggregate rejection. The branch routes every collected source ref
  to `{ kind: 'global' }` and sets `relationToBase` (copy the recursive branch's
  loop verbatim, swapping the comment).
- **Remove** the now-dead `SetOperation` rejection currently in the row-preserving
  `else` branch (`database-materialized-views.ts:451-458`) and the stale `union
  all` comment block above it (lines ~447-450 referencing the
  "now-relaxed single-source throw").
- (Minor, mirrors the recursive branch: `agg = findAggregate(analyzed)` stays
  computed-then-unused on the set-op branch. Left as-is — the review already
  blessed this for recursion; reordering would tangle the else-if chain.)

### Tests (`test/logic/52-materialized-views-incremental.sqllogic`, append §26+)
Each section: create an `on-commit-incremental` MV plus a parallel `manual` MV
over the identical body (to show the auto-maintain difference, mirroring §23);
hand-computed set is the oracle; exercise insert/update/delete on **both**
branches' sources, including the multiplicity edge each operator hinges on.

- **§26 `union` (distinct).** `a(id pk, v)`, `b(id pk, v)`; body `select v from a
  union select v from b`. `a={(1,10),(2,20)}`, `b={(3,20),(4,30)}` ⇒ create-time
  `{10,20,30}`. Then:
  - `insert into a values (5,40)` ⇒ `{10,20,30,40}`.
  - `insert into b values (6,10)` ⇒ still `{10,20,30,40}` (union dedups).
  - `delete from a where id=1` (v=10) ⇒ still `{10,20,30,40}` — **the edge**: 10
    survives because `b` row (6,10) keeps it; a per-binding delete would wrongly
    drop it, the global rebuild does not.
  - `delete from b where id=6` ⇒ `{20,30,40}` (10 now gone from both).
  - `manual` MV stays at `{10,20,30}` until `refresh`.
- **§27 `intersect`.** Body `select v from a intersect select v from b`.
  `a={(1,10),(2,20),(3,30)}`, `b={(4,20),(5,30),(6,40)}` ⇒ `{20,30}`. Then:
  - `insert into b values (7,10)` ⇒ `{10,20,30}` (10 now in both).
  - `delete from a where id=2` (v=20) ⇒ `{10,30}` (gone from the left branch ⇒
    out of the intersection — the cross-branch dependency a residual can't model).
- **§28 `except`.** Body `select v from a except select v from b`.
  `a={(1,10),(2,20),(3,30)}`, `b={(4,20)}` ⇒ `{10,30}`. Then:
  - `insert into b values (5,30)` ⇒ `{10}` (right branch now subtracts 30).
  - `delete from b where id=5` ⇒ `{10,30}` (30 reappears — right-branch deletion
    *adds* to an `except` result).
  - `insert into a values (6,40)` ⇒ `{10,30,40}`.
- **§29 `union all` accepted-but-global + bag contract.**
  - Duplicate-free `union all` over disjoint sources maintains at COMMIT (insert
    into either branch shows up).
  - A `union all` body that is a bag at create (e.g. a value present in both
    branches) ⇒ create-time fill raises `-- error: must be a set` (assert the
    diagnostic). Optionally a late-bag variant ⇒ `-- error: diverged` at COMMIT,
    mirroring §25 but non-recursive.
- **§30 (optional) nested set-op in a subquery / `diff`.** Confirm a set op that
  is *not* a top-level compound (e.g. `select v from (select v from a union select
  v from b) t`, or a `diff`) is still classified global by the `compile()`
  `containsNodeType` walk (proves the gate is plan-based, not AST-top-level-only).

### Docs (`docs/materialized-views.md`)
- In **Eligibility (checked at create time)** add a bullet listing set operations
  as *accepted-but-global* (parallel to the recursive-CTE bullet at lines
  ~220-232): any `union`/`intersect`/`except`/`union all` body classifies whole-MV
  `'global'` and rebuilds the full result on any source commit — correct, not
  algorithmically incremental; the count-based delta path (and the `union all`
  per-binding fast path) is deferred to `materialized-view-incremental-set-ops-delta`.
- Remove "set operations — bag-distinguishing ones … at build time, `union all` in
  `compile()`" from the **Rejected up front** paragraph (lines ~234-243); note the
  `union all` late-bag → "must be a set"/`diverged` behavior alongside the
  recursive one.
- Update the **Out of scope / roadmap → Incremental refresh** bullet (lines
  ~571-582): mark set-ops *delivered (global-rebuild)*; drop
  `materialized-view-incremental-set-ops` from "Remaining work"; add the new
  `materialized-view-incremental-set-ops-delta` backlog reference.

### Validate
- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/mv-setops.log; tail -n 80 /tmp/mv-setops.log`
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows)
