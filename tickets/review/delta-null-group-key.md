---
description: Review NULL-safe group-key equality in AssertionEvaluator's per-group residual. Code now emits `(col IS NULL AND :gk_i IS NULL) OR col = :gk_i` per column when `paramPrefix === 'gk'`, so NULL groups are re-evaluated. New sqllogic cases cover INSERT, UPDATE (NULL ↔ non-NULL membership transitions), cross-group isolation, and a multi-column GROUP BY with mixed NULLs.
files:
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/test/logic/95-assertions.sqllogic
  - docs/incremental-maintenance.md
---

## What changed

### `packages/quereus/src/core/database-assertions.ts`

`tryWrapTableReference` previously built each per-column equality conjunct
as `col = :gk_i`. SQL three-valued logic makes `col = NULL` UNKNOWN, so
the residual scan filtered out rows in the NULL group and silently missed
violations whenever a group-key column was NULL.

Implemented Option 1 from the plan ticket: for `paramPrefix === 'gk'`,
each conjunct is now

```
(col IS NULL AND :gk_i IS NULL) OR col = :gk_i
```

`paramPrefix === 'row'` is unchanged — PK columns are NOT NULL by
definition, so the row path keeps the simpler `col = :pk_i` and avoids any
optimizer-rule regression in the much-more-common row case.

Implementation detail: I create two separate `ColumnReferenceNode` and
`ParameterReferenceNode` operand instances — one pair for the
`IS NULL` legs, one pair for the `=` leg. The existing `=` path already
builds fresh operands per conjunct; the `IS NULL` legs do the same. This
keeps each `PlanNode`'s child set unique and consistent with how
predicate-normalizer handles UnaryOpNode siblings. No tree-sharing
assumptions were broken (verified against `predicate-normalizer.ts`'s
clone-on-change pattern).

The `UnaryExpr` AST literal is `{ type: 'unary', operator: 'IS NULL', expr }`
(field name `expr`, not `operand`) per `src/parser/ast.ts:63-67` and the
parser's emission at `src/parser/parser.ts:1206-1207`.

### `packages/quereus/test/logic/95-assertions.sqllogic`

Four new test blocks appended after the existing `orders_nonneg` block
(line ~386):

1. **`onn_nonneg` — repro for the bug.** Single-column nullable group key,
   NULL group seeded with positive sum, then an explicit transaction
   pushes the NULL group negative — must throw
   `Integrity assertion failed: onn_nonneg` and roll back. Pre-fix this
   commit silently.
2. **`oiso_nonneg` — cross-group isolation.** Both NULL group and
   non-NULL group present, then drive each into violation independently;
   ensures the NULL-safe predicate doesn't mask other groups, and
   ensures other groups don't mask the NULL group.
3. **`omv_nonneg` — UPDATE moves rows across NULL boundary.** UPDATE
   shifts a row from NULL group → non-NULL group with a value that
   pushes the destination group negative; then the reverse direction
   (non-NULL → NULL) drives the NULL group negative. Exercises the
   OLD/NEW projection retention path under `recordUpdate` with one side
   NULL.
4. **`omc_nonneg` — multi-column GROUP BY with mixed NULLs.** Two
   nullable group-key columns. Drives violations into `(NULL, 1)` and
   `(1, NULL)` independently; finishes with a passing insert into a
   `(NULL, NULL)` group to confirm the AND-of-conjuncts composes
   correctly across columns and doesn't spuriously flag unrelated
   groups.

All four tests use `CREATE TABLE ... (id INTEGER PRIMARY KEY, col INTEGER NULL, ...)`
— Quereus columns are NOT NULL by default, so the `NULL` qualifier is
required to make nullable group keys.

### `docs/incremental-maintenance.md`

Added a sentence to the "First consumer: AssertionEvaluator" section
documenting that `'group'` residuals are NULL-safe (so NULL groups are
re-evaluated as distinct groups, matching SQL `GROUP BY` semantics),
while `'row'` keeps the plain equality form because PK columns are
NOT NULL.

## Validation

- `yarn test` — passes (2940 tests, 2 pending, same pending count as
  pre-change). Streamed via tee; assertions logic block now includes
  the four new sub-blocks.
- `yarn lint` — clean (exit 0).
- Did **not** run `yarn test:store` (LevelDB path); the change is at the
  planner-rewrite layer in the AssertionEvaluator and is storage-agnostic.
  Worth a spot-check on a release but unlikely to surface anything new
  for a residual-predicate change.

## Known gaps / risks for the reviewer

These are areas where my coverage is intentionally a floor, not a ceiling:

- **No direct optimizer-plan inspection.** The added tests are
  black-box correctness checks. I did not add a planner test verifying
  the rewritten residual's plan shape (e.g., that the per-conjunct
  disjunction lands inside a `FilterNode` over the target
  `TableReferenceNode` without being demoted to a SeqScan elsewhere).
  If a reviewer wants belt-and-suspenders, an `explain_assertion`-style
  check on the `'group'` residual would catch a regression where the
  predicate accidentally short-circuits a planner rule.
- **No cost-benchmark.** The disjunction adds two `IS NULL` checks and
  an `OR` per group-key column on the residual scan. For assertions on
  small groups this is negligible. There's currently no consumer of
  `'group'` bindings beyond assertions, so I judged a microbench
  unnecessary; if a reviewer disagrees, the source ticket calls out
  Option 2 (per-NULL-mask compiled variants) as the clean drop-in for
  a future regression.
- **`'row'` path explicitly untouched.** I scoped the NULL-safe form to
  `paramPrefix === 'gk'`. A reviewer should confirm the call sites that
  pick `'row'` truly bind only on PK columns (NOT NULL). I traced
  through `getOrCompilePlan` and `extractBindings.perRelation`: `'row'`
  selects via `pickRowKey` which prefers PK; non-PK unique keys are
  also considered. If a future change made `'row'` pick a nullable
  unique key, the silent-miss bug would regress on `'row'` too. There's
  a TODO-worthy follow-up to either (a) verify the row-key picker
  excludes nullable covered keys, or (b) extend the NULL-safe form to
  `'row'` unconditionally. I did not address that here because the
  source ticket explicitly scoped it out and the row-binding path is
  PK-only in practice today.
- **AST literal `loc` field.** The new `BinaryExpr` and `UnaryExpr`
  literals I create inside `tryWrapTableReference` follow the existing
  per-conjunct construction pattern in the same function — they don't
  set `loc`. That matches the surrounding code; if a downstream pass
  expects `loc` everywhere it would have broken before this change too.
- **Multi-column composition not parenthesized.** Within one conjunct
  the disjunction `(both-NULL) OR (=)` is constructed as a `BinaryOpNode`,
  which is a separate AST node — there is no precedence ambiguity at the
  plan-node level. The AST `expression` field on the outer `AND` carries
  `BinaryExpr` references to the conjuncts, so a future round-trip
  emitter would need to render parentheses. The runtime evaluator walks
  the plan nodes directly, so this is a non-issue at execution time, but
  it's worth knowing if anyone is stringifying the residual.

## How to validate manually

```sql
-- Repro the original bug under autocommit-style test harness.
CREATE TABLE orders_nullable (id INTEGER PRIMARY KEY, customer_id INTEGER NULL, qty INTEGER);
CREATE ASSERTION onn CHECK (NOT EXISTS (
  SELECT 1 FROM (SELECT customer_id, SUM(qty) AS s FROM orders_nullable GROUP BY customer_id) WHERE s < 0
));
INSERT INTO orders_nullable VALUES (1, NULL, 5);
COMMIT;
BEGIN;
INSERT INTO orders_nullable VALUES (2, NULL, -100);
COMMIT;  -- expected: error "Integrity assertion failed: onn"
```

Without this commit applied, the COMMIT silently succeeds and the
table ends up with a NULL-group sum of -95.
