description: Composite (ASC, DESC) index isn't consumed for `equality on leading + ORDER BY DESC on trailing` — equality-bound prefix columns must be skipped when matching index ordering against required ordering.
prereq:
files:
  packages/quereus/src/vtab/memory/module.ts (indexSatisfiesOrdering, adjustPlanForOrdering, handleNonRangeNonOR)
  packages/quereus/src/vtab/best-access-plan.ts (BestAccessPlanRequest, OrderingSpec, PredicateConstraint)
  packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  packages/quereus/test/optimizer/desc-index-ordering.spec.ts
----

## Problem

`indexSatisfiesOrdering` at `packages/quereus/src/vtab/memory/module.ts:442-461` requires the required-ordering keys to align positionally with the index's leading columns. For

  `index ix_m on m(category ASC, score DESC)` + `WHERE category = 'a' ORDER BY score DESC`

the required ordering is `[score DESC]` (a single key) but the index's leading column is `category ASC`. The function compares `requiredOrdering[0]` against `indexCol[0]` (`score` vs `category`) and returns false, so the access-path picker emits an explicit SORT instead of a forward range scan over the matching `category = 'a'` slice.

The reference test `it.skip('uses composite (ASC, DESC) index for matching ORDER BY without SORT', …)` at `packages/quereus/test/optimizer/desc-index-ordering.spec.ts:58` is currently skipped. Reproduction confirms the plan still includes a `SORT` op:

```
plan ops: ["BLOCK","SORT","PROJECT","FILTER","INDEXSCAN", …]
```

## Expected behavior

When checking whether an index can satisfy the required ordering, **leading index columns that are bound by equality in the same access-plan request** are effectively constants for that scan and contribute no ordering information. They must be skipped before aligning the remaining index columns against the required ordering keys (per-column direction comparison still applies to the unbound suffix).

This matches SQLite's index-usage rules and is the standard "equality prefix + sort suffix" optimization.

## Design

`adjustPlanForOrdering` (`packages/quereus/src/vtab/memory/module.ts:414`) is called from `handleNonRangeNonOR` and friends with a `BestAccessPlanRequest` (`packages/quereus/src/vtab/best-access-plan.ts:71`) that already contains both the required ordering and the predicate filters. Compute the set of column indices that are bound by equality (`PredicateConstraint.usable` and `op === '='`, plus single-value `IN`) and pass it into `indexSatisfiesOrdering`.

Update `indexSatisfiesOrdering(index, requiredOrdering, equalityCols)` (`module.ts:442`) to:

```
let i = 0;            // pointer into index.columns
let j = 0;            // pointer into requiredOrdering

// Skip leading index columns that are equality-bound; they contribute
// no ordering on their own and don't break ordering on later columns.
while (i < index.columns.length && equalityCols.has(index.columns[i].index)) i++;

while (j < requiredOrdering.length) {
  if (i >= index.columns.length) return false;
  const required = requiredOrdering[j];
  const indexCol = index.columns[i];
  if (required.columnIndex === indexCol.index &&
      required.desc === (indexCol.desc ?? false)) {
    i++; j++;
    continue;
  }
  // Allow equality-bound columns to also appear interleaved in the index after
  // the matched prefix (rare, but consistent): if indexCol is equality-bound
  // and not the next required key, advance i.
  if (equalityCols.has(indexCol.index)) { i++; continue; }
  return false;
}
return true;
```

The "interleaved equality" branch is optional but cheap and matches SQLite. Without it the basic fixture still passes.

`adjustPlanForOrdering` should also be called for the equality-only / non-range path. Look at `handleNonRangeNonOR` (`module.ts:180`) — it currently bails out of ordering work when no range filters are present. The condition

```
&& !(request.requiredOrdering && request.requiredOrdering.length > 0)
```

near `module.ts:189` looks like the gate that suppresses the call; ensure the new equality-prefix path still reaches `adjustPlanForOrdering` when an equality filter could expose ordering on the trailing keys.

### Where to compute `equalityCols`

`PredicateConstraint` (in `packages/quereus/src/vtab/best-access-plan.ts`) already exposes `op`, `columnIndex`, and `usable`. Build the set from `request.filters` once at the top of `adjustPlanForOrdering` (or pre-compute and pass through). Treat `op === '='` and single-value `IN` as equality. `IS NULL` could also count, but skip for now to keep scope tight unless the existing tests demand it.

## Out of scope

- DESC-only or partial-prefix ordering for ranges where the leading column is itself in the required ordering — already handled by the existing direction comparison.
- Reverse scan to consume an index in the opposite direction (e.g. ASC index for ORDER BY DESC). Tracked separately if needed.
- Non-memory vtabs.

## Tests / validation

- Drop `.skip` from `packages/quereus/test/optimizer/desc-index-ordering.spec.ts:58`. The test:
  - asserts the `query_plan(?)` has zero `SORT` ops, and
  - asserts result rows are `[30, 20, 10]` (already-sorted output from a forward scan over `category = 'a'`).
- The existing two passing cases (`uses DESC index for ORDER BY DESC`, `uses DESC index for range filter combined with ORDER BY DESC`) must continue to pass — they exercise the no-prefix-skip path.
- Run the full optimizer suite plus `yarn test` to catch any plan-shape regressions.

## TODO

- Add `equalityCols: ReadonlySet<number>` (or compute internally) to `indexSatisfiesOrdering` and update `adjustPlanForOrdering` to derive it from `request.filters`.
- Implement the prefix-skip loop above. Keep the per-column direction check on the matched suffix.
- Verify `adjustPlanForOrdering` is reached on the equality-only path; adjust the gating in `handleNonRangeNonOR` if needed so an equality filter combined with `requiredOrdering` is considered.
- Drop `.skip` from the composite-index test and run it.
- Run `yarn test` and `yarn lint` for `packages/quereus`.
