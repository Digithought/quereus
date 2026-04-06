description: Unit tests for plan-validator and determinism-validator covering untested validation paths
dependencies: none
files:
  - packages/quereus/src/planner/validation/plan-validator.ts
  - packages/quereus/src/planner/validation/determinism-validator.ts
  - packages/quereus/test/planner/validation.spec.ts (new)
----

## Motivation

`planner/validation/` has 46% line coverage and 29% function coverage — the lowest in the planner. Over half the validation logic is untested, meaning malformed plans could slip through to the emitter.

## What to test

### plan-validator.ts

- **Attribute ID uniqueness**: construct a plan tree with duplicate attribute IDs across nodes, verify validator catches it
- **Column reference validation**: create ColumnReference nodes pointing to nonexistent attribute IDs, verify rejection
- **Physical property presence**: build a node missing `deterministic`, `readonly`, `estimatedRows` flags — verify validator flags it
- **Logical-only node rejection**: feed an un-rewritten Aggregate or Retrieve node to the validator, confirm it rejects
- **Side effect consistency**: mark a node with side effects as constant, verify catch
- **DDL node special-casing**: verify CREATE TABLE, DROP TABLE, ALTER TABLE pass without attributes; verify an unknown DDL-like node does not get the special case
- **Ordering validation**: create ordering specs with out-of-range column indices, verify catch
- **Circular/DAG references**: construct a plan where a child node appears in two parents, verify no infinite loop or crash
- **Valid plans pass**: ensure a correctly-formed plan passes all checks cleanly

### determinism-validator.ts

- **Deterministic expression accepted**: expression with `physical.deterministic = true` passes
- **Non-deterministic expression rejected**: expression with `physical.deterministic = false` rejected (e.g. `random()`)
- **Nested non-determinism**: deterministic outer wrapping a non-deterministic inner — should propagate rejection
- **NULL literal**: deterministic
- **Function calls**: `abs(x)` deterministic, `random()` not

## Approach

Build plan/expression nodes directly in TypeScript (don't go through SQL parsing). This isolates the validator logic from the rest of the pipeline and lets you construct intentionally-malformed plans that the planner would never produce.
