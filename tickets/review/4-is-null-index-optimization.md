description: Index-level IS NULL / IS NOT NULL optimization instead of residual filters
dependencies: 4-vtab-extended-constraint-pushdown (complete)
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/vtab/memory/module.ts
  - packages/quereus/src/planner/nodes/plan-node-type.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts
  - packages/quereus/src/runtime/emit/empty-result.ts
  - packages/quereus/src/runtime/register.ts
  - packages/quereus/test/optimizer/extended-constraint-pushdown.spec.ts
  - docs/memory-table.md
----

## Summary

IS NULL and IS NOT NULL predicates are now extracted as `PredicateConstraint` entries (instead of falling through as residual filters) and optimized at the access-planning level:

1. **IS NULL on NOT NULL column** → `EmptyResult` physical node (zero cost, zero rows, no table access)
2. **IS NOT NULL on NOT NULL column** → marked as handled (tautology eliminated)
3. **IS NULL / IS NOT NULL on nullable columns** → extracted as constraints but left unhandled (residual filter), ready for future index-based null filtering

## Key Changes

- **Constraint Extractor**: Added `extractNullConstraint()` for `UnaryOpNode` with `IS NULL` / `IS NOT NULL` operators. These are extracted alongside BETWEEN, IN, and binary comparison constraints.
- **EmptyResultNode**: New physical plan node (`PlanNodeType.EmptyResult`) extending `TableAccessNode` that yields zero rows. Emitter registered at `emitEmptyResult`.
- **MemoryTable Module**: Pre-pass detects IS NULL on NOT NULL columns and returns empty result plan. Post-pass marks IS NOT NULL on NOT NULL columns as handled (tautology).
- **Physical Node Selection**: `selectPhysicalNode()` detects `rows === 0` with all filters handled and produces `EmptyResultNode`.

## Testing

- 5 new plan-level tests verify `EmptyResult` node is used for IS NULL on NOT NULL columns and NOT used for nullable columns or IS NOT NULL
- All 12 existing correctness tests continue to pass
- Full test suite: 736 passing, 0 failing

## Use Cases for Validation

- `SELECT * FROM t WHERE pk_col IS NULL` → should produce EmptyResult (verify via `query_plan()`)
- `SELECT * FROM t WHERE not_null_col IS NULL` → should produce EmptyResult
- `SELECT * FROM t WHERE nullable_col IS NULL` → should NOT produce EmptyResult (residual filter)
- `SELECT * FROM t WHERE not_null_col IS NOT NULL` → should not produce EmptyResult; IS NOT NULL handled as tautology
- `SELECT * FROM t WHERE not_null_col IS NULL AND other_col = 1` → entire AND short-circuits to EmptyResult
- `SELECT * FROM t WHERE pk IS NOT NULL AND pk IN (1, 2)` → IS NOT NULL eliminated, IN still uses index seek
