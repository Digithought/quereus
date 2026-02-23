---
description: Covering indexes and index-only scans for MemoryTable
dependencies: 2-composite-index-advanced-seeks
---

## Problem

All index lookups currently require a follow-up fetch from the primary data BTree to retrieve non-indexed columns. When a query only references columns present in the index, the primary BTree lookup is unnecessary overhead.

Documented in `docs/memory-table.md` under "Future Enhancements" (medium-term).

## TODO

### Phase 1: Planning
- [ ] Design INCLUDE columns for secondary indexes
- [ ] Design index-only scan detection in the planner (all projected + filtered columns present in index)
- [ ] Determine cost model adjustments for index-only vs index+fetch

### Phase 2: Implementation
- [ ] Support INCLUDE clause in CREATE INDEX
- [ ] Store included columns in secondary index entries
- [ ] Add index-only scan path in access plan selection
- [ ] Skip primary BTree fetch when index-only scan is selected

### Phase 3: Review & Test
- [ ] Test index-only scan with covering index
- [ ] Test fallback to index+fetch when non-covered columns needed
- [ ] Benchmark index-only vs index+fetch performance
