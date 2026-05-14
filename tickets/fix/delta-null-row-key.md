---
description: AssertionEvaluator's `'row'` binding silently misses NULL-keyed rows when the row-binding column is a nullable unique key (not the PK). Same root cause as delta-null-group-key but on the `'row'` path.
files:
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/planner/analysis/binding-extractor.ts
  - packages/quereus/test/logic/95-assertions.sqllogic
prereq: delta-null-group-key
---

## Problem

`tryWrapTableReference` in `database-assertions.ts` builds the residual
key-equality predicate. After delta-null-group-key landed, the `'group'`
path is NULL-safe per column:

```
(col IS NULL AND :gk_i IS NULL) OR col = :gk_i
```

The `'row'` path was intentionally **not** updated and still emits the
plain form:

```
col = :pk_i
```

The justification was that PK columns are NOT NULL. That is true when the
row binding lands on the PK — but `chooseRowKey`
(`binding-extractor.ts:106`) falls back to the **lex-min covered unique
key** when the PK is not among the covered keys:

```ts
function chooseRowKey(pkIndices: number[], coveredKeys: readonly number[][]): number[] {
  if (coveredKeys.length > 0 && pkIndices.length > 0) {
    // pick PK if it's covered
  }
  // else: lex-min covered key
}
```

Quereus follows the SQL standard for UNIQUE: multiple NULLs are allowed
(`store-table.ts:checkUniqueConstraints` skips the check when any covered
column is NULL). So a nullable column can be part of a UNIQUE key, and
that UNIQUE key can be chosen as the `'row'` binding when the plan's
equality only covers that key (and not the PK).

In that case the residual is `col = :pk_i` where `col` may be NULL on the
changed tuple — same silent-miss as the group-key case the prior ticket
fixed. The dispatched tuple is computed from change projection (so
`:pk_i` is set to NULL), and `NULL = NULL` is UNKNOWN, so the residual's
inner scan returns nothing and the violation is missed.

## Expected behavior

When a `'row'` binding's chosen key includes any nullable column, the
residual must use NULL-safe equality on at least those columns (and is
safe to use unconditionally on all 'row' columns — it only adds two
`IS NULL` checks + an OR per column).

## Reproduction sketch

```sql
CREATE TABLE t (id INTEGER PRIMARY KEY, code INTEGER NULL UNIQUE, val INTEGER);
-- Assertion that hits row-shape via code (not PK):
CREATE ASSERTION t_code_nonneg CHECK (NOT EXISTS (
  SELECT 1 FROM t WHERE code = (SELECT MIN(code) FROM t) AND val < 0
));
-- Or any shape that drives extractBindings to classify the table reference
-- as 'row' with the UNIQUE key (code) as its chosen key, via a query whose
-- equality lands on `code` rather than `id`.
INSERT INTO t VALUES (1, NULL, 5);
COMMIT;
BEGIN;
INSERT INTO t VALUES (2, NULL, -100);
COMMIT;  -- expected: violation; actually: silent pass when binding lands on `code`
```

The exact SQL shape that forces the planner/binding-extractor to pick a
nullable unique key over the PK should be derived during fix-stage
investigation. The bug is contingent on the binding pick; the residual
itself is the same code path.

## Suggested fix

Either:

1. **Easier / belt-and-suspenders**: make `paramPrefix === 'pk'` use the
   same NULL-safe per-column form unconditionally. Cost: one extra
   per-column `IS NULL AND IS NULL OR` per row residual. There is a
   theoretical concern about optimizer-rule regressions on the row path
   (raised in delta-null-group-key's review); investigate whether
   index-driven access on `FilterNode(TableReferenceNode, ...)` still
   fires with the disjunctive predicate. If yes, this is the clean
   answer.

2. **Targeted**: detect at residual-build time whether any chosen
   `keyColumns[i]` is nullable (use `attributes[colIdx].type.nullable`)
   and switch that column's conjunct to the NULL-safe form. Leave
   guaranteed-NOT-NULL columns on the plain `=` path so existing
   optimizer behavior is preserved.

   Today the residual builder already has `attributes[colIdx].type` in
   hand for the param-ref's type — the nullable bit is right there.

Either approach should also extend the regression sqllogic in
`95-assertions.sqllogic` with the row-binding analog of the group cases
(`onn_nonneg`, `oiso_nonneg`, `omv_nonneg`).

## Notes

- This was called out as a known follow-up in delta-null-group-key's
  review-stage ticket but deliberately scoped out to keep that ticket
  focused.
- The `'row'` path is far more common than `'group'`, so the optimizer
  regression risk (if any) should be the dominant factor in choosing
  between (1) and (2).
- If approach (2) is taken, `analyzeRowSpecific`/`chooseRowKey` should
  probably also be inspected: there may be value in *not* picking a
  nullable unique key when an equivalent PK-covering plan is reachable.
  That is out-of-scope for the bug fix but worth a note.
