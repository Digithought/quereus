---
description: Review FD-closure-aware row/group/global classification for assertion delta execution
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/func/builtins/explain.ts
  - packages/quereus/test/optimizer/row-specific-fd.spec.ts
  - docs/architecture.md
  - docs/optimizer.md
---

## What was implemented

Extended `analyzeRowSpecific` from a two-way `'row'/'global'` classification to a three-way `'row'/'group'/'global'` result. Closure of equality-covered columns under the table reference's physical FDs + EC-derived FDs is now the covered-key test; aggregates can promote `'global' → 'group'` when GROUP BY's closure (at the aggregate's source) covers a unique key of the table reference. Window nodes no longer demote `'row'`.

### Surface area changes

- `analyzeRowSpecific` now returns `RowSpecificResult { classifications: Map<relKey, 'row' | 'group' | 'global'>, groupKeys: Map<relKey, number[]> }` (was `Map<relKey, 'row' | 'global'>`). Existing callers destructure `classifications`.
- `RowClassification` type and `RowSpecificResult` interface exported from `constraint-extractor.ts`.
- `computeCoveredKeysForConstraints(constraints, uniqueKeys, fds?, equivClasses?)` — new optional params; without them, behavior is identical to before.
- `TableInfo` gained optional `fds` / `equivClasses`, populated from the node's `physical` properties inside `createTableInfoFromNode`.

### Consumer wiring

- `database-assertions.ts`: destructures `{ classifications }`; treats `'group'` like `'global'` (full violation query) with a `TODO(fd-view-maintenance-binding-keys)` comment marking the deferred runtime work.
- `explain.ts`: emits the classification verbatim. For `'group'`, the `prepared_pk_params` column now lists the minimal group-key **column names** on the underlying table (instead of `pk0`, `pk1`, ...).

### Algorithm details

- **Covered-key closure.** `expandEcsToFds(equivClasses, fds)` + `computeClosure(eqCols, ...)` from `fd-utils.ts`. Any unique key whose columns lie in the closure counts as covered.
- **Aggregate classification.** Uses the aggregate's *source's* physical FDs/ECs (so a Filter's predicate-inferred ECs above the table reference flow into the closure). Source-column indices are mapped back to the table reference's own column indices via attribute IDs — table cols carry stable IDs through Filter (preserved attributes). Greedy minimization drops GROUP BY columns one at a time and keeps the removal iff the closure still covers a unique key.
- **Window.** Removed the unconditional `demoteAllBeneath` — Window preserves input row count.
- **SetOperation.** Unchanged: still demotes everything beneath to `'global'`.

## Test plan / use cases to verify

`packages/quereus/test/optimizer/row-specific-fd.spec.ts` covers 13 cases:

- **Row classification.** Equality on PK → `'row'`. Equality on a UNIQUE column → `'row'` via local UNIQUE→other-cols FD closure. Equality on a non-key column → `'global'`.
- **Group classification on aggregate.** `GROUP BY pk` → `'group'` with `groupKeys = [pk_idx]`. `GROUP BY unique_col` → `'group'` with `groupKeys = [unique_col_idx]`. `GROUP BY non_key` → `'global'`. `GROUP BY id, v` minimizes to `[id]`. EC test: `WHERE a = b GROUP BY a, b` over `(a, b)` PK minimizes to a single-column group key via EC-derived FDs from the Filter.
- **Row dominates group.** `WHERE id = 1 GROUP BY v` keeps the reference at `'row'` (equality coverage is stronger than group coverage).
- **Aggregate without GROUP BY.** Existing `'row'` (via equality cover at Filter) survives; otherwise `'global'`.
- **Window non-demotion.** `WHERE id = 1` beneath a Window → `'row'`.
- **End-to-end.** `explain_assertion` returns `classification = 'group'` and `prepared_pk_params = '["id"]'` for an assertion that runs `SELECT id FROM t GROUP BY id` inside the violation query.

### Validation already run

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0, no output).
- `yarn workspace @quereus/quereus run test` — 2877 passing, 2 pending. New spec contributes 13 of these.
- `yarn test` — same as above plus other packages; 2 pre-existing failures in `@quereus/sample-plugins` (`key_value_store` virtual table delete/update) confirmed to exist on `fd` HEAD without these changes — **unrelated, not introduced by this ticket**.

## Known gaps the reviewer should look at

- **Runtime wiring for `'group'` is deferred.** The classification is emitted and surfaced through `explain_assertion`, but `database-assertions.ts` still falls through to the full violation query when `'group'` references see changes. This is intentional (per ticket scope) — see `TODO(fd-view-maintenance-binding-keys)` in `database-assertions.ts`. Reviewer should confirm the TODO is in place and visible, but should not expect parameterized per-group execution yet.
- **Cross-relation FD propagation through projections** is not handled. If a `ProjectNode` between the aggregate and the table reference drops columns, the table reference's unique key columns may not be expressible at the aggregate-source level and the reference falls to `'global'`. Acceptable per ticket: "for chains with reprojection, fall back to identifying covered keys at the table-reference level". A follow-up could thread through column mappings if real-world plans hit this.
- **Per-branch SetOperation refinement** is explicitly out of scope. SetOperation still demotes everything beneath. If individual branches could be classified independently, that's future work.
- **GROUP BY closure at source vs. table-reference level.** My implementation reads `aggNode.source.physical.{fds,equivClasses}` rather than just the table reference's local FDs. This is more powerful (it picks up EC contributions from intervening Filters), but the ticket's "Implementation note" suggested starting with the table reference's own FDs only. I went one step further because the EC-derived test case (`WHERE a = b GROUP BY a, b`) would not pass under the strict reading. Reviewer should sanity-check this choice — if the source-side closure leaks columns that don't actually exist on the table (e.g. through a join), the source→table column mapping defended via attribute ID lookup handles the discrepancy by dropping unmapped cols.
- **Greedy minimization is order-dependent.** The minimal subset depends on iteration order over the initial group-by columns. The result has the right cardinality (smallest set whose closure covers the key) but may not be unique when multiple equivalent minimal subsets exist. For `WHERE a = b GROUP BY a, b` the test asserts only `length === 1`, not which specific column is kept. If the runtime cares about identity, this would need a deterministic tiebreak.

## Reviewer checklist

- Confirm `analyzeRowSpecific` callers still work after the result-shape change (only two: `database-assertions.ts` and `explain.ts`).
- Spot-check that the FD-closure expansion (`expandEcsToFds` + `computeClosure`) returns identical results to the prior pure-equality logic when FDs/ECs are empty.
- Verify the `'group'` TODO in `database-assertions.ts` clearly names the follow-up ticket so the runtime work isn't forgotten.
- Read through new tests for coverage of error paths (e.g., aggregate over a join with no key on one side — does the reference correctly land at `'global'`?). The test suite focuses on canonical cases; edge cases with joins beneath aggregates aren't covered.
- Sanity-check the docs updates in `docs/optimizer.md` (~lines 1280–1380 area) and `docs/architecture.md` (~line 131).
