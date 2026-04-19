description: Store module returns all rows for filtered scans on tables without an explicit PRIMARY KEY (predicate not applied)
dependencies: none
files:
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus/test/logic/pushdown-test.sqllogic
----

Reproduced by `pushdown-test.sqllogic:13` under `QUEREUS_TEST_STORE=true`:

```sql
CREATE TABLE users (id INTEGER, name TEXT, age INTEGER);  -- no explicit PK
INSERT INTO users VALUES (1, 'Alice', 30), (2, 'Bob', 25), (3, 'Carol', 35);

SELECT age, name FROM users WHERE age > 25;
-- expected: Alice(30), Carol(35)    — 2 rows
-- store:    Alice(30), Bob(25), Carol(35)  — 3 rows
```

Bob's row (age=25) is returned even though `age > 25` should exclude it. The predicate is either not being pushed to the store scan and not being applied above it either, or it's being pushed but ignored.

Memory mode passes this test. The `users` table declares no PRIMARY KEY, so Quereus treats all columns as the key (per project policy) — this may be the trigger for the divergent scan path.

### Hypothesis

Store's `getBestAccessPlan` or scan code path misses a residual-predicate evaluation step when the full-row key case kicks in, or signals to the planner that it handled a filter it didn't actually apply.

### TODO

- Trace the plan for the failing query under store mode (`yarn test:store --grep pushdown-test --show-plan`)
- Confirm whether store reports the predicate as `handled` in `getBestAccessPlan`
- Check residual-predicate application path in `StoreTable` scan
- Add a regression spec in `packages/quereus-store/test/` covering both PK-declared and no-PK tables with range predicates
