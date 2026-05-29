description: Accept multi-source **inner/cross-join** row-preserving bodies for `on-commit-incremental` materialized views. `MaterializedViewManager.compile()` now synthesizes a per-source `'row'` binding (each on that source's PK); a change to any participating source maintains the MV — the source(s) whose PK cleanly covers the backing physical PK maintain incrementally, the rest fall back to full rebuild (the existing always-correct escape). Outer/semi/anti joins, aggregate-over-join, set-ops, and multi-source DISTINCT are rejected at create and deferred.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md
----

## What was implemented

The single change is in `MaterializedViewManager.compile()`
(`packages/quereus/src/core/database-materialized-views.ts`). The ticket's core
insight held: **the entire maintenance pipeline below `compile()` is already
per-relation and needed no change.** `key-filter.ts`, `delta-executor.ts`,
`join-node.ts`, and `plan-node-type.ts` were **not** touched.

### `compile()` restructure

The old `tableRefByRelKey.size !== 1` throw is gone. The binding derivation is now:

- **No source** (`size === 0`) → reject (`requires the body to read at least one
  source table`).
- **Aggregate path** (`findAggregate` returns a node): guarded with a new
  `size > 1` → reject (`aggregate-over-join`, filed
  `materialized-view-incremental-aggregate-join`). The existing single-source
  group/whole-table-aggregate logic is otherwise byte-for-byte unchanged.
- **Row-preserving path** (no aggregate, 1..N sources):
  - reject `containsNodeType(SetOperation)` (catches `union all`, which clears the
    build-time gate; filed `materialized-view-incremental-set-ops`);
  - reject `size > 1 && containsNodeType(Distinct)` (DISTINCT over a join);
  - reject `size > 1 && hasNonInnerJoin(...)` (outer/semi/anti; filed
    `materialized-view-incremental-outer-joins`);
  - then loop **all** table refs, binding each on `{ kind: 'row', keyColumns: <that
    source's PK> }`, rejecting any source with no PK.

For `size === 1` this reduces exactly to the previous single-source behavior.

### New helpers (next to `findAggregate`)

- `containsNodeType(node, type)` — recursive `getChildren()` walk, first-match.
- `hasNonInnerJoin(node)` — duck-types a `joinType` property over a
  `JOIN_NODE_TYPES` set (logical `Join` + physical `NestedLoopJoin`/`HashJoin`/
  `MergeJoin`/`FanOutLookupJoin`/`AsofScan`); any join whose type is not
  `inner`/`cross`, **or whose type is unreadable**, is treated as non-inner
  (conservative → reject).

### Why the eligibility gate is sound here

`optimizeForAnalysis` runs only up to `PassId.Structural`. I confirmed
join-physical-selection (`async-gather-union-all` too) runs in
`PassId.PostOptimization`, **after** Structural — so the analyzed plan retains the
**logical `JoinNode`** (exposes `.joinType`) and the **`SetOperationNode`** for
`union all`. The gate reads exactly those. (Flagged below as a fragility if a
future *structural* rule ever lowers these earlier.)

## Validation (the floor — treat as a starting point)

- `packages/quereus` full suite: **3793 passing, 9 pending, 0 failing**.
- `tsc --noEmit` clean; `eslint` clean.
- New sqllogic sections in `52-materialized-views-incremental.sqllogic`:
  - **§19 parent/child inner join** (`mv_oc`: `orders o join customers c on
    o.cust_id = c.id`, backing PK `{oid}`): create-time contents; child UPDATE /
    INSERT / DELETE reflected; child moved to a non-existent customer ⇒ inner join
    drops the MV row (residual yields zero ⇒ delete stands); parent rename ⇒
    rebuild path shows new name on all that customer's rows; parent DELETE ⇒
    rebuild drops the matching rows; manual `refresh` resyncs; **both sides
    changed in one explicit `begin…commit`** ⇒ converges correctly.
  - **§20 both-clean 1:1 join** (`on ta.id = tb.id`): update on either side
    reflects.
  - **§21 eligibility rejections**: `left join` (`-- error: inner/cross`),
    `group by` over a join (`-- error: aggregate-over-join`), `union all`
    (`-- error: set-operation`).

### Verified out-of-band (scratch script, removed)

The canonical `mv_oc` infers backing physical PK = **`{oid}`** (single column),
so `computeDeleteKeyOrder` for the **orders/child** side returns a clean order and
that side **genuinely exercises the incremental (non-rebuild) branch**;
**customers/parent** resolves to `orders.id` (not a customers attr) ⇒ `null` ⇒
rebuild. So both code paths are live in §19, not just the always-correct rebuild.

## Known gaps / where to probe (honest)

- **Per-source no-PK gate is effectively unreachable, hence untested.** Quereus
  gives a PK-less `create table` an **all-columns** PK (`schema/table.ts`), so
  `pkCols.length === 0` never fires for a DDL table. The gate is defensive (mirrors
  the single-source rule); I did **not** add a sqllogic case for it because it
  can't be triggered via SQL. A reviewer wanting coverage would need a non-DDL
  keyless relation (none readily available).
- **"Both-clean 1:1 join" is aspirational, not literally achieved.**
  `computeDeleteKeyOrder` resolves provenance via direct attr-id / producing-expr
  only — it does **not** follow join equivalence classes. So for `on ta.id =
  tb.id` only the side the output `id` column came from maps cleanly; the other
  side resolves to `null` and rebuilds. §20 asserts **correctness only** (not
  which path fired), which holds either way. If exercising a true both-incremental
  path matters, that needs equivalence-class-aware provenance — not in scope.
- **Self-join not tested.** Two relKeys, same base; each gated independently,
  typically both `null` ⇒ rebuild-heavy but correct. Noted in the ticket; left
  untested (optional).
- **Eligibility-gate fragility.** The gate's correctness depends on
  `SetOperationNode` / logical `JoinNode` surviving `optimizeForAnalysis`. Verified
  today (both lowering rules are in `PostOptimization`). If a future *structural*
  rule rewrites `union all` → gather or a join → physical before Structural
  completes, `union all` could be silently accepted as a "2-source join" (a
  correctness bug) or an inner join mis-gated. Worth an assertion or a guard if
  that pass placement ever changes. A targeted unit test on the analyzed-plan
  shape would harden this.
- **Cost-fallback / cascading interplay with joins is untested here.** It relies
  entirely on the existing per-relation machinery (`isGloballyChanged`, overlay,
  topo order) being source-agnostic. The cascading-convergence review already
  noted the topo machinery is general and "stays correct when join bodies land."
  No join-over-MV or bulk-insert-on-a-join-source scenario was added.
- **Diagnostic substrings** chosen for the `-- error:` assertions: `inner/cross`,
  `aggregate-over-join`, `set-operation`. If the messages are reworded, update the
  tests.

## Out of scope (deferred, tickets exist)

Outer/semi/anti joins (`materialized-view-incremental-outer-joins`),
aggregate-over-join (`materialized-view-incremental-aggregate-join`), set-ops
(`materialized-view-incremental-set-ops`), recursive CTEs
(`materialized-view-incremental-recursive-cte`). Docs
(`docs/materialized-views.md` — Eligibility, Apply contract, roadmap) updated
accordingly.
