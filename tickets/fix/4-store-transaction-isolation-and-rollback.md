description: Store module does not make in-transaction writes visible to subsequent reads, and does not roll back mutations when COMMIT fails (e.g. assertion violation)
dependencies: none
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus/src/runtime/deferred-constraint-queue.ts
  packages/quereus/src/core/database-transaction.ts
  packages/quereus/test/logic/42-committed-snapshot.sqllogic
  packages/quereus/test/logic/95-assertions.sqllogic
  packages/quereus/test/logic/101-transaction-edge-cases.sqllogic
  packages/quereus/test/logic/43-transition-constraints.sqllogic
  packages/quereus/test/logic/10.1-ddl-lifecycle.sqllogic
  packages/quereus/test/logic.spec.ts
----

Observed when running the logic suite with `QUEREUS_TEST_STORE=true`. Two related failure modes, likely sharing the store's buffered-write mechanism as root cause:

### A. Reads inside a transaction don't see the transaction's own writes

Reproduced by `42-committed-snapshot.sqllogic:16`:

```sql
CREATE TABLE accounts (id INTEGER PRIMARY KEY, balance INTEGER);
INSERT INTO accounts VALUES (1, 100);
COMMIT;

BEGIN;
UPDATE accounts SET balance = 50 WHERE id = 1;
SELECT balance FROM accounts WHERE id = 1;   -- expected 50, store returns 100
```

Same pattern fails `10.1-ddl-lifecycle.sqllogic:116` (count after insert-within-begin), `101-transaction-edge-cases.sqllogic:109` (savepoint-nested inserts), `43-transition-constraints.sqllogic:118`.

This is exactly the reason `04-transactions.sqllogic` is already in `MEMORY_ONLY_FILES` — but the exclusion was over-narrow; the same semantic gap breaks any logic test that does write-then-read inside a BEGIN/COMMIT.

### B. Failed COMMIT leaves mutations applied

Reproduced by `95-assertions.sqllogic:80`:

```sql
CREATE ASSERTION positive_balance CHECK (NOT EXISTS (SELECT 1 FROM accounts WHERE balance < 0));

BEGIN;
UPDATE accounts SET balance = -10 WHERE id = 1;
COMMIT;   -- correctly errors: "Integrity assertion failed: positive_balance"

SELECT balance FROM accounts WHERE id = 1;   -- expected 50 (rolled back), store returns -10
```

The assertion queue correctly rejects the commit, but store-backed rows retain the rejected update. This is a correctness/safety issue — a CHECK/ASSERTION that the engine rejects still has its effects visible to subsequent queries.

### Hypothesis

Store writes are staged in an overlay that is (a) not read by in-session queries, and (b) applied to the backing KV store before the assertion queue's final go/no-go decision — or applied eagerly and never reverted on rejection. The fix likely lives in how `StoreTable.update`/`StoreModule` interact with `TransactionManager.commitTransaction` / `runDeferredRowConstraints`.

### TODO

- Reproduce A and B in dedicated specs under `packages/quereus-store/test/` (don't rely solely on sqllogic suite)
- Decide the overlay model: per-transaction write buffer that queries read through, flushed to KV only after deferred constraints + assertions pass
- Verify savepoint semantics still work (101-transaction-edge-cases exercises nested savepoints)
- Re-run `yarn test:store` and confirm files 10.1, 42, 43, 95, 101 pass
