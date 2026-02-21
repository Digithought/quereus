---
description: Review semi/anti join infrastructure and correlated subquery decorrelation
dependencies: none
---

## Summary

Implemented transformation of correlated EXISTS and IN subqueries in WHERE clauses into semi/anti joins, enabling hash join selection and eliminating per-row re-execution of inner queries.

### Changes Made

**JoinType extension** (`src/planner/nodes/join-node.ts`):
- Added `'semi' | 'anti'` to the `JoinType` union
- `buildAttributes()` / `getType()` return left-only output for semi/anti
- `estimatedRows` uses 50% selectivity heuristic for semi/anti
- `computePhysical()` preserves left-side unique keys for semi/anti

**JoinCapable interface** (`src/planner/framework/characteristics.ts`):
- Extended `getJoinType()` return type to include `'semi' | 'anti'`

**Key utilities** (`src/planner/util/key-utils.ts`):
- Relaxed `combineJoinKeys` joinType parameter from explicit union to `string`

**BloomJoinNode** (`src/planner/nodes/bloom-join-node.ts`):
- Semi/anti support in `buildAttributes()`, `getType()`, `estimatedRows`, `computePhysical()`

**Nested-loop emission** (`src/runtime/emit/join.ts`):
- Semi: yields left row on first match, breaks inner loop
- Anti: yields left row only when no right match found

**Hash join emission** (`src/runtime/emit/bloom-join.ts`):
- Semi: first-match probe, emits left row only
- Anti: no-match probe, emits left row only

**Physical selection** (`src/planner/rules/join/rule-join-physical-selection.ts`):
- Accepts `semi` and `anti` join types
- Left must remain probe side (no swap) for semi/anti, same as LEFT JOIN

**Decorrelation rule** (`src/planner/rules/subquery/rule-subquery-decorrelation.ts`) — **NEW**:
- Registered in Structural pass at priority 25 (after predicate pushdown at 20)
- Handles: correlated EXISTS → semi join, NOT EXISTS → anti join, correlated IN → semi join
- Extracts equi-join correlation predicates from inner filter
- Preserves inner-only predicates as residual FilterNode on the join's right side
- Skips uncorrelated subqueries (left for materialization advisory)
- Skips scalar subqueries (not in scope)
- NOT IN deferred (NULL semantics complexity)

**QuickPick enumeration** — no changes needed (already bails on non-inner/cross joins).

### Testing

- All 666 existing tests continue to pass
- New test file: `test/logic/08.1-semi-anti-join.sqllogic` with comprehensive coverage:
  - Correlated EXISTS → semi join (basic, with inner filter, empty result)
  - NOT EXISTS → anti join (basic, with inner filter)
  - Correlated IN subquery → semi join
  - Multi-column correlation predicates
  - NULL handling edge cases (NULL correlation columns, NULL dept_id)
  - Mixed predicates (EXISTS AND other_condition)
  - Uncorrelated subqueries NOT decorrelated (verified unchanged)
  - Scalar subqueries NOT affected
  - `query_plan()` introspection verifying semi/anti join node types

### Validation

- `query_plan()` confirms decorrelated queries produce `HashJoin` nodes with `joinType: "semi"` or `"anti"`
- Correctness verified against original correlated execution results
