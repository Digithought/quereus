---
description: Fix DeltaExecutor 'group' bindings silently missing violations when a group-key column is NULL. Replace the `col = :gk{i}` residual conjuncts in `injectKeyFilter` with NULL-safe equality so that NULL groups are re-evaluated correctly.
prereq:
files:
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/test/logic/95-assertions.sqllogic
---

## Background

See `tickets/fix/delta-null-group-key.md` (the source) and the review
findings in `tickets/complete/4-fd-view-maintenance-binding-keys.md` for
the full diagnosis. Summary:

`AssertionEvaluator.injectKeyFilter` rewrites the residual to filter the
target `TableReferenceNode` with `col_i = :gk{i}` per group-key column.
When a tuple's group-key value is NULL, `col_i = NULL` evaluates UNKNOWN
and the residual matches zero rows — the NULL group is never re-checked
and a real violation is silently committed.

PK columns are NOT NULL by definition, so `'row'` bindings are unaffected
in practice. `'group'` bindings on nullable columns are the breakage.

## Approach (Option 1 from the source ticket)

Make each per-column key-equality conjunct NULL-safe at the AST level:

```
old:  col = :gk_i
new:  (col IS NULL AND :gk_i IS NULL) OR col = :gk_i
```

This is the simplest correctness fix: one compiled residual handles every
NULL mask, no per-mask cache, and `executeResidualPerTuple` is untouched.
The cost penalty is small — assertion group sizes are typically small,
and the predicate is only used inside the residual scan (not as the
target table's primary access path in any current consumer). If a future
optimizer regression on `'group'` bindings shows up (no index pushdown on
nullable group keys), the source ticket's Option 2 (per-NULL-mask compiled
variants) is a clean drop-in replacement on top of this change.

### Implementation site

Only one site changes: `tryWrapTableReference` in
`packages/quereus/src/core/database-assertions.ts` (the per-column
predicate construction loop, currently around lines 499–516).

Construct each conjunct as a `BinaryOpNode` representing the disjunction:

```
predicate_i =
  OR(
    AND(
      UnaryOp('IS NULL', ColumnReference(col_i)),
      UnaryOp('IS NULL', ParameterReference(:gk_i))
    ),
    BinaryOp('=', ColumnReference(col_i), ParameterReference(:gk_i))
  )
```

Then AND all `predicate_i` together as today.

`UnaryOpNode` already supports the `'IS NULL'` operator (see
`packages/quereus/src/planner/nodes/scalar.ts:38-42`). `BinaryOpNode`
already handles `'OR'` and `'AND'` (already used a few lines below).

The AST literal for the unary expression is:

```ts
{ type: 'unary', operator: 'IS NULL', operand: <expr> } as AST.UnaryExpr
```

(Match how the parser emits these — verify against `parser/parser.ts` /
lexer keyword for `IS NULL` if the literal differs.)

Scope this fix to `paramPrefix === 'gk'` if you want to avoid touching
the `'row'` path that's PK-only-in-practice — it's safe to apply
unconditionally, but PK columns will never bind NULL so the extra
disjunction is wasted work for `'row'`. **Recommendation:** apply only
for `paramPrefix === 'gk'` to keep `'row'` plans byte-for-byte identical
and avoid any risk of regression in the much-more-common path.

### Why not Option 2 or 3

- **Option 2 (NULL-track variant per observed mask)** is cleaner for the
  optimizer but doubles the compile/cache code path and is overkill for
  the current group-binding consumer set (assertions only). Worth
  revisiting when MV consumers land if cost shows up.
- **Option 3 (sentinel + post-filter)** bypasses index lookups
  altogether and is the least correct (sentinel collisions on the value
  domain are a real hazard).

## Tests to add

Append to `packages/quereus/test/logic/95-assertions.sqllogic` (right
after the existing `orders_nonneg` block at line 386, before
`DROP TABLE orders`):

1. **Repro: NULL group key violates → assertion fires.**
   ```sql
   CREATE TABLE orders_nullable (id INTEGER PRIMARY KEY, customer_id INTEGER, qty INTEGER);
   CREATE ASSERTION onn_nonneg CHECK (NOT EXISTS (
     SELECT 1 FROM (SELECT customer_id, SUM(qty) AS s FROM orders_nullable GROUP BY customer_id) WHERE s < 0
   ));
   INSERT INTO orders_nullable VALUES (1, NULL, 5);
   COMMIT;  -- ok: NULL group has sum 5, no violation
   BEGIN;
   INSERT INTO orders_nullable VALUES (2, NULL, -100);
   COMMIT;
   -- error: Integrity assertion failed: onn_nonneg
   ```

2. **Passing case: NULL group with non-negative sum commits cleanly,
   and a separate non-NULL group with a violation still fires
   (cross-group isolation).**

3. **UPDATE moves a row out of the NULL group into a non-NULL group
   (and vice versa)** — exercises OLD/NEW projection both being NULL on
   one side. Verify both directions correctly re-evaluate both groups.

4. (Optional, if straightforward) Mixed-NULL multi-column group key:
   `GROUP BY a, b` where one of `a`/`b` is NULL and the other isn't.
   Verifies the per-conjunct NULL handling composes correctly across
   columns.

After each test, follow the established cleanup pattern (`DROP ASSERTION`
+ `DROP TABLE` + `-- run`).

## Not in scope

- No planner work on `IS NOT DISTINCT FROM` as a first-class operator.
- No optimizer-rule additions to recognize the disjunction as an
  index-friendly NULL-safe equality. If the predicate regresses an
  existing benchmark (`'row'` bindings are not affected; only `'group'`
  bindings on nullable columns), file a follow-up.
- No `'row'` binding changes. PKs are NOT NULL; covered non-PK unique
  keys may have nullable columns in principle but `'row'` selection
  prefers PK and the optimization is bounded — leave for a separate
  ticket if it surfaces.

## TODO

- Modify `tryWrapTableReference` in `database-assertions.ts` to emit the
  NULL-safe per-column predicate when `paramPrefix === 'gk'`. Keep the
  `paramPrefix === 'row'` path on the current `col = :pk_i` form.
- Sanity-check the `AST.UnaryExpr` literal for `IS NULL` matches what
  the parser/AST consumers expect (grep parser.ts for `'IS NULL'`).
- Add the four sqllogic cases above to `test/logic/95-assertions.sqllogic`.
- Run `yarn test` from the repo root and confirm 95-assertions passes
  and no regressions elsewhere. Stream output via `tee` per AGENTS.md.
- Run `yarn lint` for `packages/quereus`.
- Update `docs/incremental-maintenance.md` with a short note in the
  binding-keys section that `'group'` residuals are NULL-safe, so NULL
  groups are re-evaluated as distinct groups (matching SQL `GROUP BY`
  semantics).
- If implementation diverges from this plan (e.g. you choose Option 2),
  document the rationale in the review handoff.
