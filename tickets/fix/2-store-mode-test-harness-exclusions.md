description: Mark sqllogic files that are inherently memory-specific (plan-shape assertions, config-default assertions, memory vtab internals) as excluded from store mode
dependencies: none
files:
  packages/quereus/test/logic.spec.ts
  packages/quereus/test/logic/83-merge-join.sqllogic
  packages/quereus/test/logic/103-database-options-edge-cases.sqllogic
  packages/quereus/test/logic/105-vtab-memory-mutation-kills.sqllogic
----

Three files fail under `QUEREUS_TEST_STORE=true` for reasons that aren't engine bugs — they test properties that are module-scoped by design:

### 83-merge-join.sqllogic:106

```
Actual:   {"node_type": "HashJoin"}
Expected: {"node_type": "MergeJoin"}
```

Asserts the planner picks `MergeJoin` for an equi-join on declared PKs. Store's cost model and access-plan characteristics can validly prefer `HashJoin`. This is a plan-shape test that belongs to memory-mode coverage.

### 103-database-options-edge-cases.sqllogic:9

```
Actual:   {"name": "default_vtab_module", "value": "store"}
Expected: {"name": "default_vtab_module", "value": "memory"}
```

The test harness itself sets `default_vtab_module = 'store'` in store mode (logic.spec.ts:508). The test asserts the built-in default of `memory`, so the expectation is valid under unconfigured runs only.

### 105-vtab-memory-mutation-kills.sqllogic:77

File's opening comment:

> Mutation-killing tests targeting packages/quereus/src/vtab/memory/ (module.ts, table.ts, connection.ts)

Explicitly a memory-module white-box test. Always memory-only.

### Resolution

Add all three to `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts`, with a short comment explaining each. No engine change.

### TODO

- Extend `MEMORY_ONLY_FILES` with the three files plus comments
- Re-run `yarn test:store`; the three should skip cleanly
- Not a blocker for the other 10 store-mode fix tickets — this one can land independently
