---
description: Infrastructure for exposing pre-transaction (committed) state during deferred constraint/assertion evaluation
dependencies: MVCC layer system (vtab/memory/layer/), database-assertions.ts, database-transaction.ts

---

## Motivation

Constraints and assertions currently evaluate against the current (post-mutation) state only. To support "before/after" validation — e.g., "assert a row was removed," "total quantity must not decrease," "no status went backwards" — deferred evaluators need read access to the committed (pre-transaction) state alongside the current state.

## Current Architecture

The MVCC layer system already maintains this state:

```
BaseLayer (committed data — the "before" snapshot)
  ↓ parentLayer
TransactionLayer (pending changes — the "after" state)
```

- `TransactionLayer.parentLayer` points to the committed BaseLayer
- At deferred-evaluation time (pre-COMMIT), the transaction layer has all pending changes while the parent layer reflects pre-transaction state
- The `MemoryTableConnection` holds both `readLayer` (current) and knows the committed layer

## Design Space

### Option A: Pseudo-Schema for Committed State

Expose committed state through a synthetic schema qualifier, e.g., `committed.tablename`:

```sql
CREATE ASSERTION no_balance_decrease CHECK NOT EXISTS (
  SELECT 1 FROM accounts a
  JOIN committed.accounts ca ON a.id = ca.id
  WHERE a.balance < ca.balance
);
```

**Pros**: Clean SQL syntax, composable with JOINs and subqueries, works with existing assertion infrastructure.
**Cons**: Requires schema resolution changes; committed tables are read-only and must be clearly so.

### Option B: Transition Tables (SQL:2003 Concept)

Provide `OLD TABLE` and `NEW TABLE` pseudo-tables within constraint scope:

```sql
CREATE ASSERTION ... REFERENCING OLD TABLE AS old_accts NEW TABLE AS new_accts
CHECK NOT EXISTS (SELECT 1 FROM old_accts o JOIN new_accts n ON o.id = n.id WHERE n.balance < o.balance);
```

**Pros**: Closer to SQL standard transition tables.
**Cons**: Heavier syntax burden; transition tables are typically per-statement, not per-transaction; would need to be adapted for transaction-level semantics.

### Option C: Layer-Level Read API

Expose a `readCommittedRow(pk)` API on the store/connection, used internally by the assertion evaluator to fetch old values for changed keys:

**Pros**: Simplest implementation; no SQL syntax changes needed.
**Cons**: Not composable from SQL; assertions can't reference it; only usable by internal constraint evaluators.

### Recommended Direction

**Option A** (pseudo-schema) is likely the best balance of power and implementation effort. It leverages the existing assertion infrastructure (which already runs arbitrary SQL at commit time) and just needs a way to route table references to the committed layer instead of the transaction layer.

## Key Implementation Considerations

1. **Layer routing**: During deferred evaluation, table references qualified with `committed.` should read from the parent (committed) BaseLayer instead of the active TransactionLayer. The `MemoryTableConnection` or a wrapper must support this routing.

2. **Read-only enforcement**: Committed-state tables must be strictly read-only. Any attempt to INSERT/UPDATE/DELETE against `committed.*` should error.

3. **Scope**: This should work for both `CREATE ASSERTION` (transaction-level) and deferred `CHECK` constraints. For CHECK constraints, the committed-state reference is useful in subqueries (e.g., `CHECK ON UPDATE (NEW.balance >= (SELECT balance FROM committed.accounts WHERE id = NEW.id))`).

4. **Savepoint interaction**: If a savepoint is active, "committed" should still mean the transaction-start state (BaseLayer), not the savepoint-start state. This keeps the semantics clean and consistent.

5. **Non-memory stores**: The store-level API must be abstract enough to work with stores beyond the in-memory MVCC implementation. A `readCommittedSnapshot(table)` virtual table connection mode or similar.

6. **Performance**: Committed-state reads should go directly to the BaseLayer without scanning the transaction layer. This is naturally efficient since we're reading the parent layer.

## Key Files

- `packages/quereus/src/vtab/memory/layer/interface.ts` — Layer interface
- `packages/quereus/src/vtab/memory/layer/transaction.ts` — TransactionLayer with parentLayer
- `packages/quereus/src/vtab/memory/layer/base.ts` — BaseLayer (committed state)
- `packages/quereus/src/vtab/memory/layer/connection.ts` — MemoryTableConnection
- `packages/quereus/src/core/database-assertions.ts` — AssertionEvaluator
- `packages/quereus/src/core/database-transaction.ts` — TransactionManager
- `packages/quereus/src/schema/schema.ts` — SchemaManager (schema resolution)
