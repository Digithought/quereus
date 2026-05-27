description: A Sort/ORDER BY over a provably ≤1-row source is a no-op but is not eliminated. `rule-orderby-fd-pruning` only prunes *trailing* sort keys (requires ≥2 keys and never drops the first), so a single-key ORDER BY over a ≤1-row relation keeps the whole Sort node. Add a rule (or extend the existing one) to drop a Sort entirely when its source is provably ≤1-row.
files: packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/util/fd-utils.ts (isUnique/keysOf)
----

## Opportunity

Found during the `empty-key-join-coverage` review sweep. The empty-key/singleton-FD
fact now propagates onto joins (and, once `limit-one-singleton-fd` lands, onto `LIMIT 1`
sources and scalar aggregates already carry it). Downstream:

- DISTINCT elimination (`rule-distinct-elimination`) — fires over a ≤1-row source ✓
- GROUP BY simplification (`rule-groupby-fd-simplification`) — collapses redundant
  group columns over a ≤1-row source (for ≥2 group cols) ✓
- ORDER BY trailing-key pruning (`rule-orderby-fd-pruning`) — prunes the *tail* of a
  multi-key ORDER BY once the leading keys form a superkey (the empty key makes the
  first key already a superkey, so keys 2..n drop) ✓ **but the first/only key is never
  dropped, and the rule requires `sortKeys.length >= 2`.**

So `SELECT * FROM (<≤1-row source>) ORDER BY a` (single key) retains a useless Sort
node. A relation with ≤1 row is trivially totally ordered; the entire ORDER BY is a
no-op.

## Proposed

Add a small rule (or a guard at the top of `rule-orderby-fd-pruning`): if
`isUnique([], source)` (the source is ≤1-row — empty key present via `keysOf`), replace
the `SortNode` with its source (drop the sort entirely), regardless of `sortKeys.length`.

This generalizes to the existing "leading keys form a superkey ⇒ tail is redundant"
logic — the empty-key case is just the degenerate "0 leading keys already form a
superkey", which the current loop cannot express because it always retains the first
key before checking `isUnique`.

## Notes / scope

- Pure optimization; correctness is unaffected today (the Sort just does redundant work
  over ≤1 row).
- Confirm interaction with downstream consumers that may rely on the Sort node's
  presence for `ordering` physical property — dropping the Sort should still leave the
  ≤1-row source trivially ordered (a ≤1-row relation satisfies any ordering), but verify
  `monotonicOn`/`ordering` propagation does not regress a plan that needed the declared
  ordering.
- Backlog (not active): a general ≤1-row "trivially ordered" treatment touches the
  ordering model more broadly than the join key-coverage work; size before promoting.
