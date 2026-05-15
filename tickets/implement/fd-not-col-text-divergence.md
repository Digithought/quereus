---
description: Fix unsound `NOT col → literalEqs(col, 0)` rewrite. The consumer in `fd-utils.ts` and the producer in `partial-unique-extraction.ts` both treat `NOT col` as semantically equivalent to `col = 0`. That equivalence holds only for numeric columns; for TEXT/BLOB/BOOLEAN/OBJECT columns it claims a discharge the runtime UC never enforced, yielding an unconditional FD that is observably false (e.g., a FILTER node asserting `c → {…}` over rows that actually share `c`). Gate both the producer and consumer rewrites on column-is-numeric to keep the §7j feature working for the INT/REAL case while making the TEXT/BLOB/BOOLEAN case sound.
files:
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/nodes/filter.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/test/optimizer/conditional-fds.spec.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  docs/optimizer.md
---

## Background

See the fix-stage notes that this ticket replaces — the analysis (root cause, reproducer, options) lives there and is not repeated in full. Summary of the chosen fix (option b in the source ticket):

- Consumer (`fd-utils.ts:963-975`, `buildPredicateFacts` UnaryOpNode `'NOT'` branch): keep `isNotNullCols.add(cIdx)` (sound regardless of type), but only call `literalEqs.set(cIdx, 0)` when `col`'s logical type is numeric. Else the rewrite would falsely discharge an `eq-literal{col, 0}` guard that the runtime never matches (TEXT `''` is not equal to INTEGER `0` under storage-class equality / `sqlValueEquals` is strict reference equality — `false !== 0`, `'' !== 0`).
- Producer (`partial-unique-extraction.ts:201-206`, `recognizeClause` UnaryExpr `'NOT'` branch): same gate. A partial UC predicate `WHERE NOT col` already required the column to be declared NOT NULL; extend the gate to also require numeric so the rewritten `eq-literal{col, 0}` is sound.
- `BOOLEAN_TYPE` deliberately has `isNumeric: undefined` (it's a boolean truth type; `compareSqlValuesFast(false, 0) !== 0`). It is *not* covered by this rewrite — `NOT bool_col` is `bool_col = false`, not `bool_col = 0`. Excluding it from the gate is the correct, conservative choice. If/when we want to handle BOOLEAN columns here, that's a follow-up that extends `literalEqs` to a per-column set of pinned values (so the consumer can pin `{0, 0n, false}` and the producer can recognize `WHERE col = false` symmetrically).

The gate is exactly `attr.type.logicalType?.isNumeric === true` (consumer) or `tableSchema.columns[col]?.logicalType?.isNumeric === true` (producer). INTEGER, REAL, NUMERIC all set `isNumeric: true`; TEXT, BLOB, BOOLEAN, OBJECT, JSON do not. See `packages/quereus/src/types/builtin-types.ts:22,68,240` and `packages/quereus/src/types/logical-type.ts:54`.

## Plumbing in `fd-utils.ts`

`buildPredicateFacts(predicate, attrIdToIndex)` does not currently take a callback. Two options:

1. Add a third parameter `isColumnNumeric?: (col: number) => boolean`. Optional so existing internal callers that don't have type info still work; the `'NOT'` branch only pins the literal when the callback returns true. If the callback is undefined, conservatively skip the pin (correctness wins over feature retention in test code).
2. Thread the callback all the way from `predicateImpliesGuard(..., isColumnNonNullable, isColumnNumeric)`. Required: every call site of `predicateImpliesGuard` must pass it.

Use approach (2) — `isColumnNonNullable` is already threaded the same way; mirror it. `predicateImpliesGuard` is the one external entry point that builds facts; the only production caller is `FilterNode.computePhysical` (`packages/quereus/src/planner/nodes/filter.ts:84-95`), which has `sourceAttrs` and can build the predicate trivially:

```ts
const isColumnNumeric = (col: number): boolean => {
  const attr = sourceAttrs[col];
  return attr?.type.logicalType?.isNumeric === true;
};
```

The test file `conditional-fds.spec.ts` calls `predicateImpliesGuard` directly in many specs — each needs a numeric-callback argument added. Build a `const allNumeric = (_: number) => true` and `const noneNumeric = (_: number) => false` next to the existing `allNullable` / `nonNullable` helpers, and pass `allNumeric` to existing specs (they all use INTEGER columns) so they keep passing.

## Producer gate

`partial-unique-extraction.ts:87-88` already builds an `isColumnNotNullDeclared` helper from `tableSchema.columns[col]?.notNull === true`. Add an analogous `isColumnNumericDeclared = (col) => tableSchema.columns[col]?.logicalType?.isNumeric === true` and thread it into `recognizeGuardClauses` / `recognizeClause` / `recognizeOr` alongside the existing not-null callback. In the `'NOT'` branch (line 201), require both: `if (!isColumnNotNullDeclared(col) || !isColumnNumericDeclared(col)) return undefined;`.

Update the file's header doc comment block (lines 24, 34-38, and 169 `Accepted shapes` docstring under `recognizeClause`) to note the type gate — the current comment justifies the NOT-NULL gate but not the numeric gate.

## Reproducer SQL (regression)

Already in the fix-stage ticket. The exact sequence:

```sql
create table t (id INTEGER PRIMARY KEY, c INTEGER NOT NULL, val TEXT NOT NULL) USING memory;
create unique index ix on t(c) WHERE val = 0;
insert into t values (1, 1, '');
insert into t values (2, 1, '');
-- Currently the planner believes WHERE NOT val activates the partial UC on c.
-- Add an assertion that `select c, count(*) from t WHERE NOT val group by c` returns (1, 2)
-- and that no DISTINCT/aggregate-elimination rule mis-fires on this shape.
```

Drop a `§7j-NOT-on-TEXT` case into `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic` after the existing INTEGER-column case. Use the simplest observable: count the filtered rows grouped by `c` and assert two rows with `c=1`. Also include the inverse — same shape but `val INTEGER NOT NULL` and `val = 0` — to confirm the INT path still produces one row per `c` (proving the fix didn't regress the feature).

## Unit test additions

In `conditional-fds.spec.ts`, in the `describe('predicateImpliesGuard')` block, alongside the existing `"NOT col predicate pins col=0 …"` tests (lines 378-388):

- `"NOT col on TEXT column does NOT discharge eq-literal{col, 0}"` — build the pred via the existing `notUnary(textColNode(...))` (a TEXT-column-typed `ColumnReferenceNode`), guard `eq-literal{col, 0}`. Expect `false`. Pass `noneNumeric` (or a callback that returns false for that col) as the new arg.
- `"WHERE col = 0 on TEXT column still discharges"` — pred = `eqNode(textColNode(...), litNode(0))`, same guard. Expect `true` (the consumer accepts `=` directly without re-checking type; only the `NOT` rewrite is gated). This documents that the asymmetric treatment is intentional.
- `"NOT col on INTEGER column still discharges (feature regression guard)"` — copy of the existing test, explicitly with `allNumeric`. Expect `true`.

Add a corresponding producer test if the partial-unique-extraction unit-test block isn't already covering this — search for `extractPartialUniqueGuardedFds` usage in `conditional-fds.spec.ts` and `partial-unique-extraction.spec.ts` (if it exists). If a producer test for `NOT col` already exists with INTEGER, add a TEXT-typed sibling that expects no FD to be produced (`extractPartialUniqueGuardedFds` returns `[]` for the UC with `WHERE NOT text_col`).

## Docs

Update `docs/optimizer.md` if it documents the `NOT col` rewrite in the partial-UC / FD section. Note the numeric-only gate and the BOOLEAN/TEXT exclusion. Skip if the doc doesn't mention this shape at all.

## TODOs

- Extend `predicateImpliesGuard` signature with `isColumnNumeric: (col: number) => boolean` and thread it through `buildPredicateFacts`. Update both internal callers and the test helpers.
- In the consumer `'NOT'` branch in `buildPredicateFacts`, gate `literalEqs.set(cIdx, 0)` on `isColumnNumeric(cIdx)`. Always keep `isNotNullCols.add(cIdx)`.
- In `FilterNode.computePhysical` (`packages/quereus/src/planner/nodes/filter.ts:84-95`), build `isColumnNumeric` from `sourceAttrs[col].type.logicalType?.isNumeric === true` and pass it to `activateGuardedFds` → `predicateImpliesGuard`.
- In `partial-unique-extraction.ts`, thread `isColumnNumericDeclared` alongside `isColumnNotNullDeclared`; gate the `'NOT'` branch on both.
- Update the doc-block comments in `partial-unique-extraction.ts` (header + `recognizeClause` JSDoc) to mention the numeric-only requirement for `NOT col`.
- Add the three unit tests in `conditional-fds.spec.ts` described above, plus a producer-side test if the existing coverage doesn't already cover the TEXT-column rejection path.
- Add the §7j sqllogic regression case (TEXT-column reproducer + INT-column feature-retained mirror).
- Run `yarn workspace @quereus/quereus run test` and confirm the existing §7j passes and the new §7j-NOT-on-TEXT case asserts the bug is fixed.
- Optionally: scan for any other producers/consumers of `eq-literal{col, 0}` guards (none expected, but a quick grep on `value: 0` and `eq-literal` confirms).
- Update `docs/optimizer.md` only if it currently documents `NOT col` rewriting.

## Out-of-scope follow-ups (do NOT do in this ticket)

- BOOLEAN column support for `NOT col` (would require `literalEqs` to accept a per-column set).
- Symmetric handling of `WHERE col` (truthy test) on the producer/consumer — currently only `NOT col` is recognized.
- Casts/function-wrapped column references in the `NOT` branch.
