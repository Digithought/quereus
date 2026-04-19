description: Verify memory-only sqllogic files skip cleanly in store mode (code change already applied)
dependencies: none
files:
  packages/quereus/test/logic.spec.ts
----

The code change requested by the fix ticket is already present in `packages/quereus/test/logic.spec.ts:39-47`. The `MEMORY_ONLY_FILES` set already contains all three files with inline comments explaining why each is memory-only:

- `83-merge-join.sqllogic` — asserts planner picks MergeJoin for PK equi-join; store's cost model can validly prefer HashJoin
- `103-database-options-edge-cases.sqllogic` — asserts `default_vtab_module='memory'`; store-mode harness overrides to `'store'` (logic.spec.ts:508)
- `105-vtab-memory-mutation-kills.sqllogic` — white-box mutation tests targeting `src/vtab/memory/` internals

(Identical content was applied in commit `aaccde55` and reviewed in `complete/2-store-mode-test-harness-exclusions.md`.)

### Verification performed

`node test-runner.mjs --store --grep "83-merge-join|103-database-options-edge-cases|105-vtab-memory-mutation-kills"` → 0 passing, 3 pending (properly skipped), 0 failing.

### TODO

- No code change required
- Forward to review/ to confirm the existing state is correct and close out the duplicate
