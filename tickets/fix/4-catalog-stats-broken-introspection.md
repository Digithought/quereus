description: CatalogStatsProvider introspection helpers use wrong property names — all column-level selectivity estimation is dead code
dependencies: none
files:
  packages/quereus/src/planner/stats/catalog-stats.ts
  packages/quereus/src/planner/nodes/scalar.ts
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/test/optimizer/statistics.spec.ts
----
## Problem

The duck-typing introspection helpers at the bottom of `catalog-stats.ts` use property names
that don't exist on the actual plan node types. Every helper silently fails and returns `undefined`,
causing `CatalogStatsProvider.estimatePredicateSelectivity()` to always return `undefined` and
fall through to `NaiveStatsProvider` heuristics.

### Specific mismatches

| Helper | Line | Used | Actual property |
|---|---|---|---|
| `estimatePredicateSelectivity` | 202 | `(predicate as {op?}).op` | `expression.operator` (on `BinaryOpNode`) |
| `extractColumnFromPredicate` | 276 | `colRef.columnName ?? colRef.name` | `expression.name` (on `ColumnReferenceNode`) |
| `extractConstantValue` | 290 | `(child as any).value` | `expression.value` (on `LiteralNode`) |
| `extractBetweenBounds` | 306-307 | `node.low` / `node.high` | `lower` / `upper` (on `BetweenNode`) |
| `extractEquiJoinColumns` | 319 | `(condition as any).op` | `expression.operator` (on `BinaryOpNode`) |
| `extractEquiJoinColumns` | 329-330 | `columnName ?? name` | `expression.name` (on `ColumnReferenceNode`) |

### Impact

- Equality selectivity (1/NDV) never uses real statistics
- Range selectivity with histograms is never invoked
- Join selectivity via FK→PK path is dead
- IS NULL / IN / BETWEEN / LIKE column-level estimation all broken
- The system always falls through to naive heuristics (0.1, 0.2, 0.3, etc.)

## Fix

Replace duck-typed property access with correct property paths. Consider importing the concrete
node types (BinaryOpNode, ColumnReferenceNode, LiteralNode, BetweenNode) directly to avoid
future drift — the module already imports `selectivityFromHistogram`, so importing a few more
node types won't create problematic coupling.

Add unit tests that verify CatalogStatsProvider returns catalog-based selectivity (not fallback)
when real statistics are present.

## TODO

- Fix all 6 property-name mismatches in the introspection helpers
- Add tests: equality selectivity uses 1/NDV from catalog stats
- Add tests: range selectivity uses histogram when available
- Add tests: join selectivity uses FK→PK when metadata present
- Add tests: IS NULL uses nullCount from column stats
