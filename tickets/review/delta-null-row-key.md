---
description: Review the per-column NULL-safe residual fix in AssertionEvaluator. Row residuals now wrap the equality conjunct with `(col IS NULL AND :pk_i IS NULL) OR col = :pk_i` only when the key column itself is nullable; group residuals follow the same rule. The fix is a correctness backstop for the case where `chooseRowKey` lands on a nullable UNIQUE column.
files:
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/test/logic/95-assertions.sqllogic
  - docs/incremental-maintenance.md
---

## What changed

### `packages/quereus/src/core/database-assertions.ts` — `tryWrapTableReference`

The per-key-column residual builder is now NULL-safe per-column rather than per-binding-kind. The `nullSafe = paramPrefix === 'gk'` flag is gone; each iteration computes `colNullable = attributes[colIdx].type.nullable === true` and wraps with the IS-NULL OR form only for nullable columns. NOT NULL columns (the typical PK case on the row path) keep the simpler `col = :prefix_i` form. `paramPrefix` is still used for parameter-name construction.

The block comment above the loop was rewritten to describe the per-column-nullable rule and why we avoid unconditional disjunctive equality.

### `docs/incremental-maintenance.md` — "First consumer: AssertionEvaluator"

Step 4 now describes the unified per-column-nullable rule rather than the row-vs-group asymmetry.

### `packages/quereus/test/logic/95-assertions.sqllogic` — new `rnn_balance` block

Appended one block exercising a row-classified assertion on a table with a nullable UNIQUE column. The block:
1. Verifies via `explain_assertion(...).prepared_pk_params` that the binding lands on PK (regression guard for `chooseRowKey`'s PK-preferred behaviour).
2. Seeds a row with NULL in the nullable UNIQUE column (allowed by SQL-standard UNIQUE semantics).
3. Updates that row to violate the assertion and confirms the residual catches the violation and rolls back.

## Why this is a correctness backstop, not a behaviour change on the hot path

The dominant path through `tryWrapTableReference` is:
- Row binding → PK (NOT NULL) → predicate is `col = :pk_i` (textually identical to before).
- Group binding → group-by columns (typically nullable) → predicate is the NULL-safe OR form (textually identical to before).

The path that gets newly fixed:
- Row binding → nullable UNIQUE column (because FD closure didn't propagate UNIQUE → PK and PK is not in `coveredKeys`) → previously emitted `col = :pk_i` (silent skip on NULL); now emits the NULL-safe OR form.

A nice symmetric side-effect: if a future schema declares a NOT NULL group-by column, its conjunct becomes the simpler `=` form rather than the disjunctive one — strictly an optimizer-friendliness win.

## Known gaps for the reviewer to verify

- **No test demonstrates `chooseRowKey` landing on the nullable UNIQUE column.** Per the ticket, FD/EC closure typically expands equality on a UNIQUE column to equality on the PK, making the PK covered and `chooseRowKey` pick it. I did not find a SQL shape that forces the binding onto the nullable UNIQUE column. The `rnn_balance` test confirms the picker lands on PK (asserting `prepared_pk_params = ["pk0"]`); the residual-builder fix is the contractual correctness guarantee for the picker's fallback case but is not directly observable via current sqllogic infrastructure when the picker chooses PK. A reviewer wanting deeper coverage could:
  - Construct a `FilterNode` shape with an intervening node that breaks FD propagation (Project that drops PK, SetOp branch, derived table whose outer plan can't see PK). I tried mentally but did not exhaust the planner's FD/EC analysis — there may be a derivable shape.
  - Add a unit-level test that exercises `tryWrapTableReference` with a synthetic `keyColumns` referencing a nullable column and asserts the residual structure. The current test infra is sqllogic; adding a TypeScript-level test would be a new pattern in this area.

- **`chooseRowKey` itself is unchanged.** The ticket calls this out as out-of-scope. The defensive bonus (have `chooseRowKey` actively prefer PK-via-FD-closure when a nullable UNIQUE is in `coveredKeys`) is not done.

- **No reproduction of the bug under the original shape.** The fix is forward-looking — the residual builder is now contractually NULL-safe per column type. Whether the buggy path is reachable today depends on the planner's FD/EC behaviour, which I did not exhaustively verify.

## Test-plan checklist for the reviewer

- [x] `yarn workspace @quereus/quereus run lint` — PASS (exit 0, no output).
- [x] `yarn workspace @quereus/quereus run test` — 2940 passing, 2 pending (incl. new `rnn_balance` block in `95-assertions.sqllogic`).
- [x] `yarn test` (full workspace) — quereus 2940 passing; the only failures are the two pre-existing `@quereus/sample-plugins` `key_value_store` tests (`supports delete`, `supports update`) flagged as not-blocking in the ticket. No new failures.
- [ ] **Not run:** `yarn test:store`. The change is in the planner-rewrite layer (`database-assertions.ts`) and does not touch store-specific code. A release should re-run this.
- [ ] **Worth a second look:** the rewritten block comment above the predicate-build loop in `tryWrapTableReference` — confirm wording matches the surrounding house style.
- [ ] **Worth a second look:** the new `rnn_balance` block in `95-assertions.sqllogic` — confirm the explanatory header captures the intent correctly and that the `prepared_pk_params` assertion is the right regression guard.

## Use cases worth exercising manually if a reviewer wants belt-and-braces confidence

1. Run any existing row-classified assertion test (e.g. `a_row` in the Explain Assertion Diagnostics section) and confirm `prepared_pk_params` still reports `["pk0"]` and the assertion behaviour is unchanged. The text of the residual is identical to pre-fix on this path (PK columns are NOT NULL).
2. Run any existing group-classified assertion test (e.g. `onn_nonneg`, `omc_nonneg`) and confirm group residuals still NULL-safe correctly on nullable group-by columns. The text of the residual is identical to pre-fix on this path (group-by columns are typically nullable, so `colNullable === true` and the OR form is emitted).
3. (Manual / exploratory) Construct a query where `chooseRowKey` lands on a nullable UNIQUE column and verify the NULL-keyed-tuple path: this is the path the fix specifically enables. The ticket gives candidate shapes (Project that drops PK, SetOp branch) but I did not find one that classifies as `'row'` with a non-PK binding within the implement time-box.
