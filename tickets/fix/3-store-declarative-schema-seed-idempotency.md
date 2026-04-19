description: `apply schema main with seed;` fails with UNIQUE primary-key violation when re-applied against a store-backed database
dependencies: none
files:
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

Reproduced by `50-declarative-schema.sqllogic:332` under `QUEREUS_TEST_STORE=true`:

```
Error: Failed to apply seed data for table users.
SQL: DELETE FROM users;
     INSERT INTO users VALUES (1, 'Alice', ...);
     INSERT INTO users VALUES (2, 'Bob', ...);
     INSERT INTO users VALUES (3, 'Charlie', ...)
Error: UNIQUE constraint failed: primary key
```

The seed block is designed to be idempotent: `DELETE` first, then `INSERT`. Under store mode the DELETE doesn't seem to clear the existing rows before the INSERT runs, so the INSERTs collide with rows that are still present.

### Hypothesis

Most likely a downstream effect of `4-store-transaction-isolation-and-rollback`: seed execution runs in a single transaction; `DELETE` stages tombstones in the per-transaction overlay but the subsequent `INSERT` planner/executor reads committed state and sees the old rows. If that root cause is fixed, this may resolve too. Keep as a separate ticket because it also depends on the DELETE→INSERT sequence working within a single statement batch, which has its own planner path.

### TODO

- Confirm the seed block runs in one implicit transaction (read `packages/quereus/src/runtime/emit/alter-table.ts` apply-schema emit code)
- After the transaction-isolation ticket, retry; if still failing, narrow the failure to the apply-schema path specifically
- Ensure DELETE + INSERT in the same implicit transaction works against store
- Re-run `50-declarative-schema.sqllogic` in store mode
