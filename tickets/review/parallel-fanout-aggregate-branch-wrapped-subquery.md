description: Review — fan-out subquery-branch recognition now reaches correlated scalar aggregates wrapped in a scalar expression (coalesce/arithmetic/json/cast), not just bare ScalarSubqueryNode projections.
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, docs/optimizer.md
----

## What changed

`ruleFanOutLookupJoin` previously recognized a correlated scalar-aggregate
subquery branch **only** when a projection node *was* a `ScalarSubqueryNode`.
It now walks each projection's scalar expression tree and recognizes a
`ScalarSubqueryNode` reached anywhere inside a wrapping scalar expression
(`coalesce((subq), 0)`, `json((subq))`, `(subq) + (subq)`, cast, etc.), rewriting
only the **inner** subquery node to a `ColumnReferenceNode` into the fan-out
wide row while leaving the wrapping expression intact.

Two small helpers were added to `rule-fanout-lookup-join.ts`:

- `collectScalarSubqueries(expr, out)` — pre-order walk of a projection's scalar
  tree collecting every `ScalarSubqueryNode`. It treats a subquery as a leaf
  (pushes it, does **not** descend into the subquery's own relational body), so a
  subquery nested inside another subquery's correlation predicate stays part of
  its enclosing branch child rather than clustering separately.
- `substituteSubqueries(expr, replacements)` — rebuilds a scalar tree via
  `getChildren`/`withChildren`, replacing only matched inner `ScalarSubqueryNode`s
  with their column refs (mirrors the `replaceAllDuplicates` pattern in
  `rule-scalar-cse.ts`). A bare-subquery projection is returned wholesale from the
  map; a wrapped one keeps its wrapper. This replaced the old
  `p.node instanceof ScalarSubqueryNode` substitution in `rebuildProject`.

The recognition loop now collects candidates per projection (deduping by node
identity across projections via a `Set`) and gates each with the **unchanged**
`recognizeSubqueryBranch` — same correlation/aggregate-shape/no-GROUP-BY/
single-column gates. No new `FanOutBranchMode`; same cost gate, `minBranches`,
and wide-row layout. Each recognized subquery still contributes exactly one
wide-row column (the single-column `ProjectNode` wrap is reused unchanged).

Doc comments in the rule header and `docs/optimizer.md` §"Subquery branches"
updated to describe wrapped recognition.

## Validation done

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn lint` (quereus package) — clean (EXIT 0).
- `parallel-fanout.spec.ts` — 34 passing (6 new tests added).
- All fanout-tagged tests (`--grep "FanOut|fanout|fan-out"`) — 90 passing, 2 pending
  (the documented strict-fork exec skips).
- Full quereus suite via `test-runner.mjs` — EXIT 0 (run with `--bail`).

## Test use cases covered (new)

Plan-shape (`it`):
- two `coalesce`-wrapped subqueries → 2 `atMostOne-left` branches;
- mix of one wrapped + one bare subquery → 2 branches;
- **two subqueries inside a single projection expression** (`coalesce(...) +
  coalesce(...)`) → both cluster as 2 branches (exercises the per-projection
  multi-find path);
- GROUP BY subquery wrapped in `coalesce` is still rejected (drops below
  minBranches → no fan-out).

Execution equivalence (`forkExecTest`, skipped under strict-fork):
- wrapped result correctness enabled-vs-disabled, including the wrapper applying
  on the empty-children case (`sum→null ⇒ coalesce→0`; `coalesce(0,-1)=0`);
- two-subqueries-in-one-projection result correctness.

## Review focus / known gaps

- **Strict-fork execution coverage.** The new wrapped-execution tests use
  `forkExecTest`, which **skips under `QUEREUS_FORK_STRICT=1`** (same documented
  Sort-above-fan-out strict-fork false-positive as the pre-existing subquery exec
  tests). So wrapped-subquery runtime equivalence is only validated in the
  non-strict run. This matches the existing pattern but is worth a conscious nod —
  the rewrite touches the projection expression structure, not the fork harness,
  so the risk is low, but reviewer may want to confirm no strict-only path differs.
- **Type widening on the wrapper.** The inner subquery's value column is rewritten
  to a nullable column ref (atMostOne-left can null-fill), and the wrapping
  function's `withChildren` preserves its cached `_inferredType`. For `coalesce`
  this is benign (it already declares `nullable: true`). A reviewer might probe a
  wrapper whose result type is *narrower* than the inner subquery's nullable column
  (e.g. an arithmetic op feeding a NOT-NULL context) to confirm no type-soundness
  regression — none surfaced in tests, but the gates don't explicitly reason about
  the wrapper's nullability contract.
- **Single-subquery-per-branch only by aggregate gate, not by count.** The walk
  will happily cluster *many* wrapped subqueries; there's no artificial v1 cap.
  The ticket said "single, for v1" for the find, but allowing multiple is within
  the stated scope ("Multiple wrapped subqueries per projection ... may all
  cluster") and is tested. Flagging in case the reviewer expected a 1-per-projection
  guard — there intentionally is none.
- **No new runtime test in `test/runtime/fanout-lookup-join.spec.ts`.** Wrapped
  execution correctness is validated through the optimizer spec's enabled-vs-disabled
  comparison rather than a dedicated runtime spec. Sufficient as a floor; a reviewer
  may want a runtime-spec mirror.

## Out of scope (unchanged from ticket)

- GROUP BY / multi-row subqueries (still rejected).
- Subqueries in cardinality-changing positions (N/A for scalar context).
