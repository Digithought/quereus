---
description: Pre-resolved comparators to eliminate runtime type detection in hot paths
dependencies: Logical type system, Memory VTable, Sort/Join nodes
priority: 5
---

## Architecture

*Details to be filled out during planning phase.*

Eliminate runtime type detection by pre-resolving comparators at creation time:
- Memory VTable primary keys: use pkColumn.logicalType.compare
- Secondary indexes: pre-create comparator array per index column
- Sort node: pre-resolve comparators for sort keys
- Join node: pre-resolve for join keys
- Distinct/Group By: pre-resolve for grouping keys

Target: 2-3x speedup for index operations, joins, sorts.

Files: primary-key.ts, index.ts, sort.ts, join.ts, distinct.ts, aggregate.ts

**Principles:** SPP, DRY, modular architecture. Type-specific fast paths.

## TODO

### Phase 1: Planning
- [ ] Review current comparison code paths
- [ ] Design comparator resolution interface

### Phase 2: Implementation
- [ ] Update Memory VTable primary keys
- [ ] Update secondary indexes
- [ ] Update Sort node
- [ ] Update Join node
- [ ] Update Distinct/Group By

### Phase 3: Review & Test
- [ ] Review implementation correctness
- [ ] Benchmark performance improvements

