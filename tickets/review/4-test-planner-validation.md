description: Unit tests for plan-validator and determinism-validator covering untested validation paths
dependencies: none
files:
  - packages/quereus/src/planner/validation/plan-validator.ts
  - packages/quereus/src/planner/validation/determinism-validator.ts
  - packages/quereus/test/planner/validation.spec.ts (new)
----

## Summary

Added 48 unit tests covering the previously-untested validation logic in `planner/validation/`.

### plan-validator.ts (33 tests)

Tests construct mock PlanNodes directly in TypeScript (no SQL parsing) to isolate validator logic and test intentionally-malformed plans.

- **Attribute ID uniqueness**: unique IDs accepted; duplicates across nodes and within a single node rejected
- **Column reference validation**: ColumnReference to unknown attribute ID rejected; valid reference accepted
- **Physical property presence**: non-boolean `deterministic`/`readonly`/`idempotent` rejected; negative `estimatedRows` rejected; valid properties accepted; `requirePhysical: false` option skips checks
- **Logical-only node rejection**: `Aggregate` and `Retrieve` in physical tree rejected; physical types accepted
- **Side effect consistency**: node with `readonly: false` + `constant: true` rejected; valid side-effect config accepted
- **DDL node special-casing**: `CreateTable`, `DropTable`, `AlterTable`, `Transaction`, `Pragma` all pass without attributes
- **Ordering validation**: out-of-range and negative column indices rejected; valid ordering accepted; `validateOrdering: false` skips
- **Attribute validation**: non-number ID, empty name, empty sourceRelation all rejected; `validateAttributes: false` skips
- **DAG references**: shared child node does not cause infinite loop (detected as duplicate attribute)
- **Valid plans pass**: well-formed multi-level plan accepted; `quickValidate` returns correct boolean

### determinism-validator.ts (15 tests)

- **checkDeterministic**: deterministic expression returns `{ valid: true }`; non-deterministic returns expression string
- **validateDeterministicExpression**: does not throw for deterministic; throws with context, expression, and mutation-context suggestion
- **validateDeterministicConstraint**: error includes constraint name and table name
- **validateDeterministicDefault**: error includes column name and table name
- **validateDeterministicGenerated**: error includes column name and table name
- **NULL literal**: deterministic
- **Function determinism**: `abs(x)` deterministic, `random()` not

## Test plan

- [x] All 48 new tests pass (`yarn test:single packages/quereus/test/planner/validation.spec.ts`)
- [x] Full test suite passes (1392 passing)
- [x] Typecheck passes
- [ ] Review: test coverage of validation paths is thorough and tests are not tightly coupled to implementation
