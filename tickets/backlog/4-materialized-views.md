---
description: Materialized views with cached results and refresh strategies
prereq: View system (view.ts, create-view planner/emitter), MemoryTable module, schema management, DDL parser

---

## Overview

Materialized views are views whose results are cached in a backing table for fast reads. Unlike regular views (which re-execute the SELECT on each access), materialized views store their result set and must be explicitly refreshed.

This is lower priority than FK constraints, computed columns, and ALTER TABLE. The design below captures the key decisions; detailed planning should happen when this moves to implement stage.

## Design Sketch

### Syntax

```sql
create materialized view mv_name as select ...;
refresh materialized view mv_name;
drop materialized view mv_name;
```

### Storage Model

A materialized view is backed by an internal MemoryTable (or configurable module). On creation, the SELECT is executed and results stored. On refresh, the backing table is truncated and repopulated.

### Schema Representation

Extend `ViewSchema` or create a new `MaterializedViewSchema`:
- Stores the SELECT AST (like a regular view)
- References the backing table
- Tracks last refresh timestamp
- Optional: refresh strategy metadata (manual-only initially)

### Query Resolution

When a materialized view is referenced in a query, resolve to the backing table (not the SELECT). This provides fast reads without re-execution.

### Refresh Strategies

Phase 1: Manual refresh only (`REFRESH MATERIALIZED VIEW`).
Phase 2: Consider incremental refresh (only process changes since last refresh) using data change events.

### Interaction with Other Features

- Indexes can be created on materialized views (since they're backed by real tables)
- Declarative schema should support materialized views
- DROP MATERIALIZED VIEW should drop the backing table

## Open Questions

- Should `CREATE MATERIALIZED VIEW` use a specific module for the backing table, or always use MemoryTable?
- Should there be a `CONCURRENTLY` option for refresh (allowing reads during refresh)?
- How to handle schema changes in source tables — invalidate the materialized view?
