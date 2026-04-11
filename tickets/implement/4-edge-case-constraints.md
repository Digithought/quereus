description: Add edge-case sqllogic tests for constraints, FK cascades, and assertions
dependencies: none
files:
  packages/quereus/test/logic/40-constraints.sqllogic
  packages/quereus/test/logic/95-assertions.sqllogic
  packages/quereus/test/logic/41-foreign-keys.sqllogic
  packages/quereus/test/logic/43-transition-constraints.sqllogic
  packages/quereus/test/logic/41-fk-cross-schema.sqllogic
  packages/quereus/src/runtime/emit/add-constraint.ts
  packages/quereus/src/runtime/emit/create-assertion.ts
----
Focused sqllogic tests targeting constraint edge cases. The existing tests cover basic deferred
CHECK constraints, FK cascades (single and multi-column), assertions at COMMIT, savepoint
rollback with constraints, and transition constraints via `committed.*`. This ticket fills the
remaining gaps in complex interaction scenarios.

**Gaps to cover:**

- **Multi-row DELETE with cascading FKs**: delete multiple parent rows in a single statement
  where each parent has children — verify all children are cascaded correctly and no orphans
  remain
- **CASCADE across three levels**: grandparent → parent → child FK chain with CASCADE DELETE —
  delete grandparent and verify entire chain is removed
- **SET NULL cascade on multi-row delete**: delete multiple parents with SET NULL children —
  verify all affected children have NULLed FK columns
- **Multiple assertions in same transaction**: two independent assertions, one passes and one
  fails — verify the failing one prevents COMMIT and the error identifies which assertion
- **Deferred CHECK + assertion in same transaction**: a deferred row-level CHECK and a global
  assertion both evaluated at COMMIT — verify both are checked and the first failure is
  reported
- **Cross-schema FK with CASCADE**: FK referencing a table in another schema with ON DELETE
  CASCADE — verify cascade crosses the schema boundary
- **Savepoint interaction with deferred constraints**: insert violating row, create savepoint,
  fix the violation, rollback savepoint (restoring violation), then attempt COMMIT — should
  fail
- **Constraint violation in multi-statement transaction**: first statement valid, second
  violates a deferred constraint, third fixes it — COMMIT should succeed since end-state is
  valid
- **FK cascade triggering a CHECK violation**: parent delete cascades to child, but the cascade
  result violates a CHECK on the child table — verify the error is caught
- **Assertion referencing multiple tables**: `CREATE ASSERTION CHECK (select count(*) from a)
  = (select count(*) from b)` — verify evaluation across tables at commit

Target test file: `test/logic/29-constraint-edge-cases.sqllogic`

TODO:
- Create `test/logic/29-constraint-edge-cases.sqllogic`
- Cover each gap bullet above with at least one test case
- Run tests and verify all pass (or document any bugs found as new fix/ tickets)
