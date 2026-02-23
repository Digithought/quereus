---
description: Transition constraints using committed.* pseudo-schema in CHECK constraints and assertions
dependencies: committed-state-snapshot-access (provides schema resolution and snapshot connections)
---

## Summary

Wired the committed.* pseudo-schema into constraint evaluation so users can write transition constraints comparing before/after state.

### Changes

1. **constraint-builder.ts**: Added `containsCommittedRef()` function that walks the full expression tree (descending into subquery plan children) to find `TableReferenceNode` nodes with `readCommitted === true`. Updated auto-deferral logic to defensively check for committed refs: `needsDeferred = containsSubquery(expression) || containsCommittedRef(expression)`.

2. **database-assertions.ts**: No changes needed — `collectTables()` already resolves `committed.tablename` to the base table name (`main.tablename`) via schema resolution, so impact analysis correctly triggers re-evaluation when the underlying table changes.

3. **Deferred constraint queue**: No changes needed — evaluators have committed-snapshot routing baked in via the `readCommitted` flag on `TableReferenceNode` → `_readCommitted` option on module connections.

### Testing

Test file: `packages/quereus/test/logic/43-transition-constraints.sqllogic`

Covers:
- CHECK constraint with committed subquery (auto-deferred, catches violations on UPDATE)
- CHECK constraint passes when constraint holds (increase/equal allowed)
- New rows with no committed counterpart use COALESCE default
- Assertion with count preservation (cardinality can only grow)
- Multiple committed refs in same assertion (two tables)
- Deleted rows detection (exist in committed but not current)
- CHECK constraint + assertion together with committed refs
- All tests verify rollback on violation (state unchanged)

### Usage

```sql
-- CHECK constraint: balance can only increase
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  balance INTEGER,
  CONSTRAINT no_decrease CHECK (
    balance >= coalesce((SELECT balance FROM committed.accounts ca WHERE ca.id = new.id), 0)
  )
) USING memory;

-- Assertion: no rows may be deleted
CREATE ASSERTION no_deletes CHECK (NOT EXISTS (
  SELECT 1 FROM committed.protected cp
  WHERE NOT EXISTS (SELECT 1 FROM protected p WHERE p.id = cp.id)
));
```

Note: In CHECK constraints, use `new.column` for correlated subquery references to the current row (not `tablename.column`, which isn't in the constraint scope).

### Validation

- Build passes
- All 725 tests pass (including 43-transition-constraints.sqllogic)
