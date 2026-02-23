---
description: Wire committed.* pseudo-schema into constraint and assertion evaluation for transition constraints
dependencies: 4-committed-state-snapshot-access (must be implemented first — provides schema resolution, readCommitted flag, and snapshot connections)

---

## Overview

With committed-state snapshot access providing the infrastructure to read pre-transaction state via `committed.tablename`, this task wires that capability into the constraint and assertion systems so users can write transition constraints that compare before/after state.

### Use Cases

- **Monotonicity**: `CREATE ASSERTION ... CHECK NOT EXISTS (SELECT 1 FROM t JOIN committed.t ON ... WHERE t.val < committed.t.val)`
- **Cardinality preservation**: `(SELECT count(*) FROM t) >= (SELECT count(*) FROM committed.t)`
- **Transition rules**: CHECK constraints that verify column values only move forward in a lifecycle
- **Deletion verification**: Assert that a specific row was removed

### Syntax

No new SQL syntax. Users reference `committed.tablename` in:
1. **CREATE ASSERTION** CHECK expressions (arbitrary SQL at commit time)
2. **CHECK constraint** subquery expressions (auto-deferred to commit time)

Examples:
```sql
-- Assertion: balance must not decrease
CREATE ASSERTION no_balance_decrease CHECK NOT EXISTS (
  SELECT 1 FROM accounts a
  JOIN committed.accounts ca ON a.id = ca.id
  WHERE a.balance < ca.balance
);

-- CHECK with committed ref (auto-deferred)
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  balance INTEGER,
  CONSTRAINT no_decrease CHECK (
    balance >= coalesce((SELECT balance FROM committed.accounts WHERE id = accounts.id), 0)
  )
) USING memory;
```

## Analysis: What Needs to Change

Most of the work is done by the committed-state snapshot access task. The infrastructure handles:
- Schema resolution: `committed.accounts` → real `TableSchema` with `readCommitted=true` on the `TableReferenceNode`
- Runtime: `_readCommitted` option on module connections → snapshot-mode connections reading from `currentCommittedLayer`

### What this task adds

#### 1. Constraint Builder: Defensive `containsCommittedRef()` check

**File:** `packages/quereus/src/planner/building/constraint-builder.ts`

CHECK constraints referencing `committed.*` necessarily contain subqueries, so `containsSubquery()` already triggers auto-deferral. However, add a defensive `containsCommittedRef()` check to ensure committed-ref constraints are always deferred, even if the subquery detection logic changes.

Walk the plan tree looking for `TableReferenceNode` with `readCommitted === true`. If found, force-defer. Combine with existing subquery check:

```typescript
const needsDeferred = containsSubquery(expression) || containsCommittedRef(expression);
```

The `containsCommittedRef()` function should walk the full expression tree (not just scalar nodes — it needs to descend into subquery plan children to find `TableReferenceNode` nodes).

#### 2. Assertion Evaluator: Impact analysis for committed refs

**File:** `packages/quereus/src/core/database-assertions.ts`

The existing `collectTables()` method already works correctly. When an assertion references `committed.accounts`, the schema resolution resolves it to `main.accounts` (with `readCommitted=true` on the node). So `collectTables()` records `main.accounts` as a base table dependency, and impact analysis correctly triggers re-evaluation when `accounts` changes.

**No code changes needed** — just verify with tests.

#### 3. Deferred Constraint Queue: No changes needed

Deferred constraints store compiled evaluator functions from plan time. The evaluators already have committed-snapshot routing baked in (via the `readCommitted` flag on `TableReferenceNode` → `_readCommitted` option on module connections). At commit-time evaluation, the evaluators create fresh committed-snapshot connections as needed.

#### 4. Tests

**File:** `packages/quereus/test/logic/43-transition-constraints.sqllogic`

Comprehensive tests for transition constraints:

- Assertion with `committed.*` JOIN: balance must not decrease
- Assertion passes when constraint holds
- Assertion catches violations on UPDATE
- Assertion with count preservation: `count(*) >= committed count`
- CHECK constraint with committed subquery: auto-deferred, catches violations
- CHECK constraint with committed subquery: passes when valid
- New rows (no committed counterpart): LEFT JOIN / COALESCE patterns
- Deleted rows: exist in committed but not current
- Multiple committed refs in same assertion
- Committed ref in assertion is read-only (cannot INSERT/UPDATE/DELETE committed.*)

## Key Files

- `packages/quereus/src/planner/building/constraint-builder.ts` — add `containsCommittedRef()` defensive check
- `packages/quereus/src/core/database-assertions.ts` — verify (no changes expected)
- `packages/quereus/test/logic/43-transition-constraints.sqllogic` — tests

## TODO

- Add `containsCommittedRef()` function to constraint-builder.ts that walks expression tree for `TableReferenceNode.readCommitted`
- Update auto-deferral logic: `needsDeferred = containsSubquery(expression) || containsCommittedRef(expression)`
- Create `43-transition-constraints.sqllogic` with transition constraint test cases
- Verify assertion evaluator impact analysis works correctly with committed refs (via tests)
- Verify deferred constraint evaluation works correctly with committed refs (via tests)
