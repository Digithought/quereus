---
description: Multi-column range scans and composite index IN seeks for MemoryTable
dependencies: 4-vtab-extended-constraint-pushdown (complete), 5-titan-access-path-selection (complete)
---

## Problem

The MemoryTable query planner has two composite-index limitations documented in `docs/memory-table.md`:

1. **Range scans only consider the first column of composite indexes** — a composite index on `(a, b)` can seek on `a = ?` then range-scan `b`, but this prefix+trailing-range pattern is not yet supported at the physical scan level.
2. **Composite index IN is not yet implemented** — multi-value `IN` currently works for single-column indexes only. An `IN` on a composite index prefix (e.g., `WHERE a IN (1,2) AND b = 5`) should generate multiple seeks but doesn't.

Both gaps are noted as future work in `tasks/complete/4-vtab-extended-constraint-pushdown.md` and `tasks/complete/5-titan-access-path-selection.md`.

## TODO

### Phase 1: Planning
- [ ] Design composite prefix+trailing-range scan plan (extends existing plan types in `scan-plan.ts`)
- [ ] Design composite IN multi-seek (extends plan type 5 to support multi-column key tuples)
- [ ] Determine cost model adjustments for composite seeks

### Phase 2: Implementation
- [ ] Implement multi-column range scan in `findEqualityMatches` / `evaluateIndexAccess`
- [ ] Implement composite IN seek generation (key tuple product) in scan dispatch
- [ ] Update `rule-select-access-path.ts` to construct composite IndexSeekNode with trailing range
- [ ] Update cursor scan logic in `base-cursor.ts` and `transaction-cursor.ts`

### Phase 3: Review & Test
- [ ] Add tests for composite prefix+trailing-range scans
- [ ] Add tests for composite IN multi-seek
- [ ] Update `docs/memory-table.md` limitations section
- [ ] Benchmark cost model accuracy for composite access patterns
