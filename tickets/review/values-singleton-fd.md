description: Review the ValuesNode singleton FD propagation: a ≤1-row VALUES source now advertises the `∅ → all_cols` FD via `computePhysical`, enabling whole-Sort elimination, DISTINCT elimination, GROUP BY simplification, and singleton-FD join propagation downstream.
files: packages/quereus/src/planner/nodes/values-node.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts
----

## What changed

`ValuesNode` (`packages/quereus/src/planner/nodes/values-node.ts:104-118`) now has a `computePhysical` override that, when `rows.length <= 1`, emits the canonical singleton `∅ → all_cols` FD via `singletonFd(colCount)`. For `rows.length > 1` it returns only `estimatedRows` (no FDs — VALUES remains a bag). `estimatedRows` is set in both branches so the row estimate and the singleton fact agree (matches the `LimitOffsetNode` pattern).

Imports added: `PhysicalProperties` from `./plan-node.js`, `singletonFd` from `../util/fd-utils.js`.

No change to `TableLiteralNode` — per ticket design.

## Use cases / what to test

Single-row VALUES (parameterized so const-folding does not collapse it):
- `SELECT * FROM (VALUES (?, ?)) AS v(a, b)` → physical `VALUES` op carries an FD with empty determinants covering both columns (the singleton).
- `SELECT * FROM (VALUES (?, ?)) AS v(a, b) ORDER BY a` → whole-Sort is eliminated.
- `SELECT DISTINCT * FROM (VALUES (?, ?)) AS v(a, b)` → DISTINCT is eliminated.
- Result-set parity: dropping Sort/DISTINCT does not change rows (compared values).

Multi-row VALUES (negative controls):
- `SELECT * FROM (VALUES (?, ?), (?, ?)) AS v(a, b)` → no singleton FD.
- `ORDER BY` and `DISTINCT` over multi-row VALUES are retained.

Zero-row VALUES is safe: `singletonFd(0)` returns undefined, so no FD is emitted, only `estimatedRows: 0`.

## Test coverage added

Five new cases under `describe('Empty-key (≤1-row) join coverage', …)` in `packages/quereus/test/optimizer/keys-propagation.spec.ts`:

1. `single-row VALUES emits the singleton ∅→all FD on the Values physical`
2. `multi-row VALUES does NOT emit the singleton FD` (negative control)
3. `ORDER BY whole-Sort eliminated over a single-row VALUES` (+ multi-row negative control)
4. `DISTINCT eliminated over a single-row VALUES` (+ multi-row negative control)
5. `eliminated ORDER BY / DISTINCT over single-row VALUES still returns the right rows` (behavioral soundness guard)

A `valuesPhysical` helper locates the `VALUES` physical row by case-insensitive substring match, mirroring `joinPhysicalAny`.

## Validation

- `yarn workspace @quereus/quereus test` — 3647 passing, 9 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` — exit 0.

## Honest gaps the reviewer should consider

- **Foldable VALUES is not exercised by the SQL surface.** All-literal VALUES (`VALUES (1, 2)`) is rewritten to a `TableLiteralNode` by the const-folding pass before the physical pass runs. The new tests deliberately use parameterized VALUES (`VALUES (?, ?)`) so the node survives as a `Values` in the plan and `computePhysical` actually fires. The ticket explicitly scoped out `TableLiteralNode` ("separate node, separate ticket if ever needed"), but the user-visible benefits described in the ticket (whole-Sort / DISTINCT elimination over `SELECT … FROM (VALUES (1, 2))`) will **not** trigger today because the const-folder eats the `ValuesNode` first. The reviewer should decide whether `TableLiteralNode` warrants a parallel `computePhysical` (`rowCount <= 1` ⇒ singleton FD) as a follow-up ticket; if so, the call sites in `const-evaluator.ts:176` already pass `rowCount` through.
- **Column-alias quirk surfaced by the behavioral test.** `SELECT * FROM (VALUES (?, ?)) AS v(a, b)` emits column names `column_0, column_1` rather than `a, b`. The behavioral guard compares row values (`Object.values(row)`) to dodge this, but the aliasing defect itself is pre-existing and unrelated to this ticket. Worth flagging only because someone reading the test might wonder why we don't deep-equal `{ a, b }`.
- **Estimated-rows interaction with FDs.** `computePhysical` returns `estimatedRows: this.rows.length` in both branches. For zero-row VALUES this advertises `estimatedRows: 0` alongside no FD; downstream consumers should be fine (anything keying off `guaranteesUniqueRows` short-circuits on `colCount === 0` via `estimatedRows === 1`, which is false here — meaning a 0-row VALUES does NOT advertise the singleton claim, which is sound: a 0-row relation is ≤1-row but the consumers care about the FD encoding). Reviewer should confirm there is no consumer that would mishandle `estimatedRows: 0 && no fds` differently from the prior behavior (which had no `estimatedRows` override at all on `ValuesNode`).
- **No consumer changes were made.** The ticket asserts the unified read surface (`keysOf` / `isUnique` / `hasSingletonFd`) and existing rules (`rule-orderby-fd-pruning`, DISTINCT elimination, join propagation) pick this up automatically. The Sort and DISTINCT elimination tests confirm the wiring works end-to-end through the optimizer, but the reviewer should sanity-check that no rule explicitly excluded `Values` from FD consultation (a grep for `nodeType === PlanNodeType.Values` or `Values` in the rule files would catch any such gate).
