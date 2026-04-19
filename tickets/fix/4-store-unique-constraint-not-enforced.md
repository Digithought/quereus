description: UNIQUE constraint violations silently accepted by the store module
dependencies: none
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/test/logic/102-unique-constraints.sqllogic
----

Reproduced by `102-unique-constraints.sqllogic:19` under `QUEREUS_TEST_STORE=true`:

```
Actual:   {"cnt": 3}
Expected: {"cnt": 2}
```

A UNIQUE-violating insert that memory mode rejects is being accepted by the store backend, leaving an extra row. See the full block in `102-unique-constraints.sqllogic` — the test counts rows after attempting a duplicate insert that should have failed.

### Hypothesis

Store's secondary-index / unique-constraint check is missing or not wired to the DML executor. Memory mode relies on index structure (`digitree`) to reject duplicates at insert time; store's index store path may not perform the equivalent check.

### TODO

- Reproduce with a minimal spec in `packages/quereus-store/test/`
- Inspect `StoreTable.update`/insert path for unique-key validation against secondary index stores
- Confirm the check runs before commit and participates in rollback semantics (tie into the transaction-isolation ticket if shared)
- Re-run `102-unique-constraints.sqllogic` in store mode
