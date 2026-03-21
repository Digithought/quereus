description: Fixed CatalogStatsProvider introspection helpers — column-level selectivity estimation now uses correct property paths
dependencies: none
files:
  packages/quereus/src/planner/stats/catalog-stats.ts
  packages/quereus/test/optimizer/statistics.spec.ts
----
## Summary

The duck-typing introspection helpers at the bottom of `catalog-stats.ts` used property names
that didn't exist on the actual plan node types. Every helper silently returned `undefined`,
causing `CatalogStatsProvider.estimatePredicateSelectivity()` to always fall through to
`NaiveStatsProvider` heuristics.

## Changes

### Property-name fixes (6 mismatches)

| Helper | Was | Fixed to |
|---|---|---|
| `estimatePredicateSelectivity` | `(predicate as {op?}).op` | `(predicate as BinaryOpNode).expression.operator` |
| `extractColumnFromPredicate` | `colRef.columnName ?? colRef.name` | `(child as ColumnReferenceNode).expression.name` |
| `extractConstantValue` | `(child as any).value` | `(child as LiteralNode).expression.value` |
| `extractBetweenBounds` | `node.low` / `node.high` | `node.lower` / `node.upper` (BetweenNode props) |
| `extractEquiJoinColumns` op | `(condition as any).op` | `(condition as BinaryOpNode).expression.operator` |
| `extractEquiJoinColumns` cols | `columnName ?? name` | `(child as ColumnReferenceNode).expression.name` |

### Dead switch-case fixes

- `case 'IsNull'` / `case 'IsNotNull'` / `case 'Like'` were unreachable — no node classes produce these nodeTypes
- IS NULL / IS NOT NULL are `UnaryOpNode` (nodeType `'UnaryOp'`, `expression.operator === 'IS NULL'`)
- LIKE is `BinaryOpNode` (nodeType `'BinaryOp'`, `expression.operator === 'LIKE'`)
- Added `case 'UnaryOp'` to handle IS NULL / IS NOT NULL
- Moved LIKE handling into the `case 'BinaryOp'` branch
- Removed dead `IsNull`, `IsNotNull`, `Like` cases

### Type safety improvements

- Replaced duck-typed `as any` casts with typed imports (`BinaryOpNode`, `LiteralNode`, `BetweenNode`, `UnaryOpNode`, `ColumnReferenceNode`)
- Added `instanceof Promise` guards for `MaybePromise<SqlValue>` literal values

## Testing

10 new tests in `CatalogStatsProvider selectivity` suite (all passing):

- **Equality**: `=` selectivity returns `1/NDV` (not fallback 0.1)
- **Not-equal**: `!=` selectivity returns `1 - 1/NDV`
- **Range + histogram**: `>` with histogram returns histogram-derived selectivity
- **Range without histogram**: `<` without histogram returns 1/3 heuristic
- **IS NULL**: returns `nullCount / rowCount`
- **IS NOT NULL**: returns `1 - nullCount / rowCount`
- **BETWEEN + histogram**: uses histogram for lower/upper bounds
- **LIKE**: returns 1/3 heuristic
- **Join FK→PK**: returns `1/ndv_pk` when FK metadata present
- **Join without FK**: returns `1/max(ndv_left, ndv_right)`

Full test suite: 913 passing, 3 pending (unchanged).
