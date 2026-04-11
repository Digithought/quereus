description: Review edge-case sqllogic tests for constraints, FK cascades, and assertions
dependencies: none
files:
  packages/quereus/test/logic/29-constraint-edge-cases.sqllogic
----
Added `29-constraint-edge-cases.sqllogic` covering 10 edge-case scenarios for constraint
interactions. All 1694 tests pass.

**Test cases implemented:**

- **Multi-row DELETE with cascading FKs**: deletes two parents in one statement, verifies all
  children cascade-deleted, no orphans
- **CASCADE across three levels**: grandparent → parent → child chain, delete grandparent
  removes entire lineage
- **SET NULL cascade on multi-row delete**: deletes two parents, verifies all affected children
  have NULLed FK columns
- **Multiple assertions in same transaction**: two independent assertions, verifies failing one
  is correctly identified by name and prevents COMMIT
- **Deferred CHECK + assertion in same transaction**: deferred row-level CHECK and global
  assertion both evaluated at COMMIT, each tested independently
- **Multiple child tables with different cascade actions**: same parent referenced by CASCADE
  and SET NULL children — both actions fire correctly on parent delete
- **Savepoint interaction with deferred constraints**: insert violation, savepoint, fix it,
  rollback savepoint (restoring violation), COMMIT fails
- **Constraint violation in multi-statement transaction**: violate then fix within transaction,
  COMMIT succeeds since end-state is valid
- **FK cascade triggering NOT NULL violation**: SET NULL cascade conflicts with NOT NULL column
  constraint, DELETE correctly rejected
- **Assertion referencing multiple tables**: `count(*) from a = count(*) from b` checked at
  COMMIT across two tables

**Note:** Cross-schema FK with CASCADE was originally planned but the `declare schema` parser
does not support schema-qualified table references in REFERENCES clauses. Replaced with
"multiple child tables with different cascade actions" which covers a similarly untested
interaction pattern.
