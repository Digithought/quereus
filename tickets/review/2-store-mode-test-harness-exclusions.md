description: Mark memory-specific sqllogic files as excluded from store mode
dependencies: none
files:
  packages/quereus/test/logic.spec.ts
----

Added three files to `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts`:

- `83-merge-join.sqllogic` — plan-shape assertion (MergeJoin vs HashJoin); store's cost model can validly pick HashJoin
- `103-database-options-edge-cases.sqllogic` — asserts `default_vtab_module='memory'`, which the store harness overrides to `store` at line 505
- `105-vtab-memory-mutation-kills.sqllogic` — white-box mutation tests targeting `src/vtab/memory/` internals

Each entry has a short inline comment explaining the memory-only reason.

### Verification

`yarn test:store` run confirms all three files now skip cleanly. The remaining failure (`03.6-type-system.sqllogic:235` JSON round-trip) is unrelated and owned by a separate open ticket.

### Use cases / validation

- Run `yarn test` — memory mode still executes the three files.
- Run `QUEREUS_TEST_STORE=true yarn test` — the three files are skipped, no assertion errors from them.
- No production code was changed; only the store-mode exclusion list in the test harness.
