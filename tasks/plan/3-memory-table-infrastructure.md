---
description: Medium/long-term MemoryTable infrastructure — compression, monitoring, persistence, partitioning, custom index types
dependencies: core engine maturity
---

## Problem

Several medium-to-long-term infrastructure improvements for MemoryTable are documented in `docs/memory-table.md` but don't have dedicated tasks. These are lower-priority items that depend on core engine maturity.

## Items

### Medium-Term
- **Page-level compression**: Compress inherited BTree pages for reduced memory usage in read-heavy layers
- **Memory monitoring**: Track and report memory usage across layers (page counts, shared vs copied pages, per-connection overhead)

### Long-Term
- **Persistent storage integration**: Optional backing store for memory table durability (write-ahead log or snapshot-based)
- **Advanced MVCC**: Read-committed isolation levels within memory table transactions (currently only snapshot isolation)
- **Horizontal partitioning**: Partition large memory tables by key range or hash for parallel access
- **Custom index types**: Hash indexes (O(1) equality), bitmap indexes (low-cardinality columns), etc.

## TODO

### Phase 1: Planning
- [ ] Prioritize based on actual usage patterns and profiling data
- [ ] Design each feature independently (split into separate tasks when ready)

*Individual items should be broken out into dedicated tasks when they move from wishlist to active planning.*
