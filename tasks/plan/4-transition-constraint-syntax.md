---
description: SQL syntax and semantics for constraints that reference both pre-transaction and post-transaction state
dependencies: 4-committed-state-snapshot-access (committed-state read infrastructure)

---

## Motivation

With committed-state snapshot access available (see sibling task), this task defines the user-facing syntax and semantics for constraints that compare before/after state.

## Use Cases

1. **Monotonicity**: "Account balance must not decrease" — compare old and new aggregate/row values
2. **Deletion verification**: "Assert row was removed" — check that a specific row no longer exists that previously did
3. **Cardinality preservation**: "Row count must not drop below threshold" — compare counts
4. **Transition rules**: "Status can only move forward in lifecycle" — compare old vs new column values across statements

## Design Space

### For CREATE ASSERTION (Transaction-Level)

Assertions already run arbitrary SQL at commit time. With committed-state access, they can simply reference `committed.tablename`:

```sql
-- Balance must not decrease for any account
CREATE ASSERTION no_balance_decrease CHECK NOT EXISTS (
  SELECT 1 FROM accounts a
  JOIN committed.accounts ca ON a.id = ca.id
  WHERE a.balance < ca.balance
);

-- Row count must not decrease
CREATE ASSERTION count_preserved CHECK (
  (SELECT count(*) FROM items) >= (SELECT count(*) FROM committed.items)
);
```

No new syntax needed beyond the `committed.` schema qualifier.

### For CHECK Constraints (Row-Level with Subqueries)

CHECK constraints with subqueries are already auto-deferred. They could reference committed state in subqueries:

```sql
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  balance INTEGER,
  CONSTRAINT no_decrease CHECK ON UPDATE (
    NEW.balance >= (SELECT balance FROM committed.accounts WHERE id = NEW.id)
  )
) USING memory;
```

This also requires no new syntax — just support for `committed.*` in the constraint expression.

### Optional: REFERENCING Clause (Future)

For closer SQL standard alignment, a `REFERENCING` clause could alias the committed schema:

```sql
CREATE ASSERTION ...
REFERENCING OLD TABLE committed.accounts AS old_accts
CHECK NOT EXISTS (...);
```

This is syntactic sugar and can be deferred to a future enhancement.

## Semantics

1. **Evaluation timing**: All before/after constraints are inherently deferred to COMMIT time (or RELEASE SAVEPOINT for savepoint-scoped assertions, if we add those later).

2. **Consistency**: `committed.*` always reflects the state at transaction BEGIN, regardless of how many statements have executed within the transaction.

3. **NULL handling for new rows**: A row that didn't exist in committed state won't appear in `committed.*` queries. Constraints should handle this (e.g., `LEFT JOIN committed.t` for rows that may be new).

4. **Deleted rows**: A row that exists in `committed.*` but not in the current state was deleted. This is the "assert row was removed" pattern.

5. **Auto-deferral**: Any CHECK constraint containing a `committed.*` reference must be deferred (similar to how subquery-containing constraints are auto-deferred today).

## Constraint Builder Changes

In `planner/building/constraint-builder.ts`, the constraint builder needs to:

1. Detect `committed.*` references in constraint expressions
2. Force-defer any constraint with committed-state references
3. Ensure the committed-state routing is active during deferred evaluation context

## Assertion Evaluator Changes

In `core/database-assertions.ts`, the evaluator needs to:

1. Set up the committed-state schema routing before evaluating assertion SQL
2. Tear down routing after evaluation
3. Impact analysis: assertions referencing `committed.X` are impacted when table `X` has changes (already handled by table dependency tracking)

## Key Files

- `packages/quereus/src/parser/parser.ts` — No syntax changes needed (committed is just a schema qualifier)
- `packages/quereus/src/planner/building/constraint-builder.ts` — Auto-defer committed-ref constraints
- `packages/quereus/src/core/database-assertions.ts` — Set up committed routing during evaluation
- `packages/quereus/src/runtime/emit/constraint-check.ts` — Deferred constraint evaluation context
- `packages/quereus/src/runtime/deferred-constraint-queue.ts` — Deferred queue execution context
