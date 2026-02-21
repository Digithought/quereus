---
description: VTab-supplied or ANALYZE-based statistics for cost estimation
dependencies: VTab API (src/vtab/), optimizer cost model (src/planner/cost/), StatsProvider (src/planner/stats/), TableSchema (src/schema/table.ts)
---

## Architecture

Statistics infrastructure enabling accurate cardinality estimation. VTabs supply statistics through a new optional `getStatistics()` method, and `ANALYZE` collects them on demand. The optimizer consumes statistics through the existing `StatsProvider` interface, enhanced with column-level and histogram support.

### Design Principles

- **Module-agnostic**: Statistics API works with any VTab module; modules opt in by implementing `getStatistics?()`.
- **Lazy & cached**: Statistics are computed on demand (via ANALYZE or first optimizer request), then cached on `TableSchema`. No eager pre-computation.
- **Backward compatible**: `NaiveStatsProvider` remains the fallback. Enhanced stats compose as a decorator that falls through to naive heuristics when real stats are unavailable.
- **Characteristics-based**: Optimizer rules check for stats availability through the existing `StatsProvider` interface — no `instanceof` checks.
- **SPP/DRY**: Column statistics types are reused by both VTab reporting and ANALYZE collection. One `TableStatistics` structure serves all consumers.

### Statistics Model

```
TableSchema
  └── statistics?: TableStatistics        (cached, nullable)

TableStatistics
  ├── rowCount: number                    (exact or estimated)
  ├── columnStats: Map<string, ColumnStatistics>
  └── lastAnalyzed?: number               (epoch ms)

ColumnStatistics
  ├── distinctCount: number               (estimated NDV)
  ├── nullCount: number                   (count of NULLs)
  ├── minValue?: SqlValue                 (boundary for range estimation)
  ├── maxValue?: SqlValue                 (boundary for range estimation)
  └── histogram?: EquiHeightHistogram     (optional, for fine-grained selectivity)

EquiHeightHistogram
  ├── buckets: { upperBound: SqlValue; cumulativeCount: number; distinctCount: number }[]
  └── sampleSize: number                  (rows sampled to build histogram)
```

### VTab Statistics Protocol

```typescript
// Optional method on VirtualTable (src/vtab/table.ts)
getStatistics?(): Promise<TableStatistics> | TableStatistics;
```

Modules implement this to report what they know. MemoryTable can report exact `rowCount` from `primaryTree.getCount()`, exact distinct counts from secondary index sizes, and compute histograms by sampling the primary BTree. External/remote modules may report approximate counts.

### ANALYZE Command

`ANALYZE [schema.]table` triggers statistics collection:

1. Resolve the table through SchemaManager
2. Call `vtable.getStatistics()` if available — module provides its own stats
3. If module doesn't implement `getStatistics()`: scan the table via `query()`, compute row count, per-column distinct counts (HyperLogLog or exact for small tables), min/max, and optional histograms
4. Cache result on `TableSchema.statistics`

`ANALYZE` without a table name analyzes all tables in the current schema.

### Enhanced StatsProvider

`CatalogStatsProvider` wraps `NaiveStatsProvider` and checks `TableSchema.statistics` first:

```
CatalogStatsProvider
  ├── tableRows(table) → table.statistics?.rowCount ?? naive fallback
  ├── selectivity(table, pred) → histogram-based or predicate-heuristic
  ├── distinctValues(table, col) → table.statistics?.columnStats.get(col)?.distinctCount ?? naive
  └── joinSelectivity(left, right, cond) → 1/max(ndv_left, ndv_right) for equi-joins, else naive
```

### Selectivity Estimation

With column statistics available, selectivity improves:

- **Equality** (`col = val`): `1 / distinctCount`, or histogram bucket lookup
- **Range** (`col > val`): fraction of histogram above `val`, or `(max - val) / (max - min)`
- **IN list**: `listSize / distinctCount`
- **IS NULL**: `nullCount / rowCount`
- **BETWEEN**: histogram range or `(high - low) / (max - min)`
- **LIKE prefix** (`col LIKE 'abc%'`): estimated as range on prefix bounds

### Integration Points

- **OptContext.stats**: Optimizer instantiation switches from `NaiveStatsProvider` to `CatalogStatsProvider` when the database has analyzed tables. Constructed in `Optimizer` or `createOptContext`.
- **Cost model**: No changes needed — cost functions already take row counts as input; better row estimates from stats flow through naturally.
- **Access path selection**: `ruleSelectAccessPath` and `ruleGrowRetrieve` already call `context.stats.tableRows()`; they get better numbers automatically.
- **Join ordering**: `ruleJoinGreedyCommute` and QuickPick use `stats.joinSelectivity()` and `stats.tableRows()` — better estimates improve join order decisions.

### Key Files

| File | Role |
|------|------|
| `src/planner/stats/index.ts` | `StatsProvider` interface, `NaiveStatsProvider` |
| `src/planner/stats/basic-estimates.ts` | `BasicRowEstimator` heuristics |
| `src/planner/stats/catalog-stats.ts` | **NEW**: `CatalogStatsProvider`, `TableStatistics`, `ColumnStatistics` types |
| `src/planner/stats/histogram.ts` | **NEW**: `EquiHeightHistogram`, histogram-based selectivity |
| `src/planner/stats/analyze.ts` | **NEW**: Statistics collection logic (scan-based and VTab-delegated) |
| `src/vtab/table.ts` | `VirtualTable` base — add optional `getStatistics?()` |
| `src/vtab/memory/table.ts` | MemoryTable — implement `getStatistics()` using BTree metadata |
| `src/schema/table.ts` | `TableSchema` — add `statistics?: TableStatistics` field |
| `src/planner/building/analyze.ts` | **NEW**: Plan builder for ANALYZE statement |
| `src/planner/nodes/analyze-node.ts` | **NEW**: `AnalyzeNode` plan node |
| `src/runtime/emit/analyze.ts` | **NEW**: ANALYZE emitter/executor |
| `src/parser/parser.ts` | Parse `ANALYZE` statement |
| `src/parser/ast.ts` | `AnalyzeStmt` AST node |
| `src/planner/optimizer.ts` | Wire `CatalogStatsProvider` into context |

## TODO

### Phase 1: Statistics Types & Storage

- [ ] Define `TableStatistics`, `ColumnStatistics`, `EquiHeightHistogram` types in `src/planner/stats/catalog-stats.ts`
- [ ] Add `statistics?: TableStatistics` to `TableSchema` in `src/schema/table.ts`
- [ ] Implement `CatalogStatsProvider` that reads `TableSchema.statistics` and falls back to `NaiveStatsProvider`
- [ ] Implement histogram-based selectivity estimation in `src/planner/stats/histogram.ts`
- [ ] Wire `CatalogStatsProvider` into optimizer context creation (check `TableSchema.statistics` presence)

### Phase 2: VTab Statistics Protocol

- [ ] Add optional `getStatistics?(): Promise<TableStatistics> | TableStatistics` to `VirtualTable` base class
- [ ] Implement `getStatistics()` on MemoryTable: exact rowCount from `primaryTree.getCount()`, distinct counts from secondary indexes, min/max by scanning first/last BTree entries
- [ ] Add histogram computation for MemoryTable (sample-based for tables > 1000 rows, exact for smaller)

### Phase 3: ANALYZE Command

- [ ] Add `AnalyzeStmt` AST node to `src/parser/ast.ts` — `{ type: 'analyze', tableName?: string, schemaName?: string }`
- [ ] Parse `ANALYZE [schema.]table` in parser — check if it already parses as a PRAGMA, or add as a new statement type
- [ ] Create `AnalyzeNode` plan node
- [ ] Create plan builder for ANALYZE that resolves table references
- [ ] Create emitter that calls `vtable.getStatistics()` or performs scan-based collection
- [ ] Cache results on `TableSchema.statistics`

### Phase 4: Scan-Based Collection Fallback

- [ ] Implement scan-based statistics collector for modules that don't implement `getStatistics()`: open a `query()` cursor and compute rowCount, per-column distinct counts (exact up to threshold, then approximate), min/max, optional histogram
- [ ] Use sampling for histogram construction on large tables (reservoir sampling or systematic)

### Phase 5: Tests

- [ ] Unit tests for `CatalogStatsProvider` — verifies fallback to naive when no stats, uses real stats when available
- [ ] Unit tests for histogram selectivity estimation — equality, range, IN, NULL
- [ ] Integration test: `ANALYZE` on a MemoryTable populates `TableSchema.statistics` with correct values
- [ ] Integration test: After ANALYZE, optimizer produces better cardinality estimates (verify via `query_plan()` estimated rows)
- [ ] Logic test: `ANALYZE` round-trip — create table, insert data, ANALYZE, verify stats visible (possibly via a `table_stats()` TVF or PRAGMA)
- [ ] Test that statistics survive schema operations that don't invalidate them, and are cleared on operations that do (e.g., bulk insert, DDL changes)
