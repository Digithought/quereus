---
description: VTab-supplied or ANALYZE-based statistics for cost estimation
dependencies: VTab API, optimizer cost model, StatsProvider interface
---

## Summary

Implemented statistics infrastructure for cost-based optimization. The system supports two modes:

1. **VTab-supplied statistics**: Modules implement `getStatistics()` to report row counts, distinct values, min/max, and histograms. MemoryTable provides exact stats from its BTree metadata.

2. **ANALYZE command**: `ANALYZE [table]` triggers collection. If the module implements `getStatistics()`, those stats are used; otherwise a full scan collects per-column statistics with reservoir-sampled histograms.

Statistics are cached on `TableSchema.statistics` and consumed by `CatalogStatsProvider`, which wraps `NaiveStatsProvider` as fallback.

## Files Changed

### New Files
| File | Purpose |
|------|---------|
| `src/planner/stats/catalog-stats.ts` | `TableStatistics`, `ColumnStatistics`, `EquiHeightHistogram` types; `CatalogStatsProvider` |
| `src/planner/stats/histogram.ts` | Histogram building and selectivity estimation |
| `src/planner/stats/analyze.ts` | Scan-based statistics fallback collector |
| `src/planner/nodes/analyze-node.ts` | `AnalyzePlanNode` |
| `src/planner/building/analyze.ts` | Plan builder for ANALYZE |
| `src/runtime/emit/analyze.ts` | ANALYZE runtime emitter |
| `test/optimizer/statistics.spec.ts` | 25 tests covering histograms, CatalogStatsProvider, ANALYZE, and VTab stats |

### Modified Files
| File | Change |
|------|--------|
| `src/schema/table.ts` | Added `statistics?: TableStatistics` field |
| `src/vtab/table.ts` | Added optional `getStatistics()` method |
| `src/vtab/memory/table.ts` | Implemented `getStatistics()` with exact counts and histograms |
| `src/vtab/memory/layer/manager.ts` | Added `getBaseLayerStats()` and `sampleColumnValues()` reading from committed layer |
| `src/parser/lexer.ts` | Added `ANALYZE` token |
| `src/parser/ast.ts` | Added `AnalyzeStmt` AST node |
| `src/parser/parser.ts` | Added ANALYZE parsing |
| `src/planner/nodes/plan-node-type.ts` | Added `Analyze` to enum |
| `src/planner/building/block.ts` | Dispatch to `buildAnalyzeStmt` |
| `src/planner/optimizer.ts` | Default stats provider changed to `CatalogStatsProvider` |
| `src/runtime/register.ts` | Registered ANALYZE emitter |

## Testing

25 tests in `test/optimizer/statistics.spec.ts`:

- **Histogram unit tests** (6): buildHistogram edge cases, bucket structure, cumulative counts
- **Selectivity unit tests** (7): equality/range/complement selectivity, edge cases
- **CatalogStatsProvider unit tests** (4): catalog vs fallback behavior, distinct values
- **ANALYZE integration tests** (6): parsing, row count output, nonexistent tables, per-column collection
- **VTab statistics tests** (2): exact row counts from MemoryTable, stats update after data changes

## Validation

- `tsc --noEmit` passes cleanly
- All 435 project tests pass (1 pre-existing flaky property test excluded)
- All 25 new statistics tests pass
