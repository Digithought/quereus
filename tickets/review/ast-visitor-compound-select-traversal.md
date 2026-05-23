description: Review the visitor fix that swaps the dead `stmt.union` traversal for the live `stmt.compound?.select` field, plus the new compound-CHECK regression tests in `40.2-check-extras.sqllogic`.
prereq:
files:
  packages/quereus/src/parser/visitor.ts
  packages/quereus/test/logic/40.2-check-extras.sqllogic
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/planner/analysis/assertion-classifier.ts
  packages/quereus/src/schema/rename-rewriter.ts
----

## Summary

`packages/quereus/src/parser/visitor.ts:74` previously descended into
`stmt.union`, a `SelectStmt` field the parser never populates. The parser
emits compound chains (`UNION / UNION ALL / INTERSECT / EXCEPT / DIFF`)
through `stmt.compound = { op, select }` instead (see
`packages/quereus/src/parser/parser.ts:577-622`). The line is now
`traverseAst(stmt.compound?.select, callbacks);` so every leg of a compound
SELECT is visited.

## Why it matters

`traverseAst` is the AST pre-walk used by several DDL-time validators:

- `schema/manager.ts:rejectIllegalReferences` (bind-parameter rejection in
  CHECK and DEFAULT, plus column-reference rejection in DEFAULT)
- `schema/manager.ts:validateCheckConstraintDeterminism`
  (non-deterministic function rejection in CHECK)
- `schema/table.ts:extractGeneratedColumnDependencies`
  (column dependency extraction for generated-column topo sort)

Before the fix, anything hidden in legs 2..N of a compound subquery
embedded in those expressions slipped past validation silently. The new
regression tests in section 7 of
`packages/quereus/test/logic/40.2-check-extras.sqllogic` lock down the two
CHECK-side validators:

- `check (x in (select 1 union all select :p))` must error with
  `bind parameters` (covers `rejectIllegalReferences` via
  `validateCheckConstraintDeterminism`).
- `check (x in (select 1 union all select random()))` must error with
  `Non-deterministic expression not allowed in CHECK` (covers the
  function-walker leg in `validateCheckConstraintDeterminism`).

Both pass with the visitor fix.

## Validation done

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test --grep '40.2-check-extras'`
  passes (the file is registered as a single Mocha test that runs all
  sections).
- `yarn workspace @quereus/quereus run test` — full quereus suite,
  3412 passing / 9 pending, no failures.

## Other readers of `SelectStmt.union` / `unionAll` (intentionally left)

Per the ticket, the dead AST fields remain in place to keep this fix
narrowly scoped. Current readers in the tree:

- `packages/quereus/src/parser/ast.ts:183-184` — the field declarations.
- `packages/quereus/src/schema/rename-rewriter.ts:99` and `:519` — both
  walk `stmt.union` AND `stmt.compound.select`, so they were already correct
  by virtue of the second branch.
- `packages/quereus/src/planner/analysis/assertion-classifier.ts:69` — a
  shape gate `if (sel.union) return undefined;` that sits immediately
  below the live `if (sel.compound) return undefined;` gate. Since the
  parser never populates `.union`, this is a dead-but-harmless line; the
  `.compound` gate above is the one that actually rejects compound shapes.
  Not changed here — flagged for a possible follow-up that either deletes
  the dead AST fields outright or removes this dead read.

The ticket explicitly says "leave the AST fields in place... do NOT delete
them unless the removal stays contained" — so the cleanup is left as a
distinct, optional fix-stage candidate.

## Suggested review attention

- Confirm `stmt.compound?.select` is the only field needed (the parser
  represents the rest of the chain by recursively nesting `compound` on the
  right-hand `select`, so the visitor recurses into the whole chain via the
  `case 'select'` arm of `traverseAst` — no additional bookkeeping needed).
- Sanity-check that no other `traverseAst` callers rely on `stmt.union`
  being undefined as a side signal (a quick grep for `traverseAst` callers
  shows only the validators listed above, plus the assertion classifier's
  own predicate-scan which uses its own walker).
- The new error-substring assertions in section 7 use the same
  `-- error: <substring>` convention as sections 5/6; the `bind parameters`
  and `Non-deterministic expression not allowed in CHECK` substrings come
  directly from `QuereusError` strings in `schema/manager.ts:1158-1183`.

## Known gaps / honest flags

- Generated-column dependency extraction
  (`schema/table.ts:extractGeneratedColumnDependencies`) is also affected
  by the visitor fix but has no regression test added here — the ticket
  scoped tests to the two CHECK validators. A pathological case would be a
  generated-column expression that references column `c` only in the
  second leg of a compound subquery; before the fix that dependency was
  invisible to the topo sort. The fix should resolve it, but the test
  matrix doesn't include this scenario. Worth adding if the reviewer
  wants stronger coverage.
- DEFAULT-side bind-parameter / column-rejection has the same code path
  but is also untested for the compound case. Same rationale —
  symmetric coverage was outside the ticket's explicit asks.
