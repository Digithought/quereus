description: `traverseAst` in `packages/quereus/src/parser/visitor.ts` does not descend into `stmt.compound` on a SelectStmt — it only walks the long-dead `stmt.union` field, which the parser never populates. Anything routed through this visitor silently skips every leg beyond the first in a compound SELECT.
prereq:
files:
  packages/quereus/src/parser/visitor.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/parser/ast.ts
----

## Background

While reviewing `fix-ast-stringify-check-ops-and-compound-select`, I confirmed
that the parser populates `SelectStmt.compound` (and never `SelectStmt.union` /
`SelectStmt.unionAll`) for `UNION / UNION ALL / INTERSECT / EXCEPT / DIFF`
chains — see `packages/quereus/src/parser/parser.ts:577-619`.

`rename-rewriter.ts` (lines 99 and 519) already handles both fields:

```ts
visitTableRename(stmt.union, oldName, newName, defaultSchemaName, ctx);
if (stmt.compound) visitTableRename(stmt.compound.select, oldName, newName, defaultSchemaName, ctx);
```

`visitor.ts` does NOT:

```ts
// packages/quereus/src/parser/visitor.ts:74
traverseAst(stmt.union, callbacks);   // dead — stmt.union is always undefined
// missing: traverseAst(stmt.compound?.select, callbacks);
```

## Impact

`traverseAst` is used by:

- `manager.ts:rejectIllegalReferences` (called from CHECK and DEFAULT
  validation) — fails to detect bind-parameter or column references hidden in a
  compound subquery's later legs. e.g. `check (X in (select 1 union all select
  :p))` would slip past the no-bind-parameter rule.
- `manager.ts:validateCheckConstraintDeterminism` — fails to detect
  non-deterministic functions in later legs of a compound subquery inside a
  CHECK expression.
- `table.ts:extractGeneratedColumnDependencies` — fails to pick up column refs
  from later legs of a compound subquery in a generated-column expression,
  which could silently mis-compute the topological sort of generated columns.

The cross-fix smoke test in `50-declarative-schema.sqllogic` already exercises
a CHECK whose expression is a compound subquery, but only verifies runtime
INSERT behavior. The validation gaps above are not currently covered.

## Required changes

- In `visitor.ts`'s `case 'select'` arm, replace the dead `traverseAst(stmt.union, …)` with `traverseAst(stmt.compound?.select, callbacks)`.
- Add a regression test that exercises each validator on a CHECK containing a
  compound subquery — e.g.
  - `check (X in (select 1 union all select :p))` must reject the bind parameter.
  - `check (X in (select 1 union all select random()))` must reject the non-deterministic function.
- Once the visitor is fixed, decide whether to delete the now-vestigial
  `union?` / `unionAll?` fields from `SelectStmt` in `parser/ast.ts` and the
  matching dead lines in `rename-rewriter.ts:99,519`. (Out of scope here if the
  removal cascades widely.)
