description: Review fixes to `packages/quereus/src/emit/ast-stringify.ts` for two silent drops on the declarative-schema round-trip — CHECK `operations` list (issue #23) and compound-SELECT tail (issue #21). Both bugs only surfaced via `declare schema` / `apply schema` because the stringifier is part of that path; direct `create table` / `create view` parse straight into the AST and were unaffected.
prereq:
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## What changed

### `packages/quereus/src/emit/ast-stringify.ts`

1. **CHECK column-constraint arm** (`columnConstraintsToString`, ~line 912).
   The `case 'check'` previously emitted only `check (<expr>)`. It now also
   emits `on <op>[, <op>...]` whenever `c.operations` is populated, and
   appends `conflictToString(c.onConflict)` (which was also being dropped
   for column-level CHECK). Position matches the parser's accepted form:
   `check on <ops> (<expr>) [on conflict <action>]`.

2. **CHECK table-constraint arm** (`tableConstraintsToString`, ~line 958).
   Same fix — operations clause emitted, conflict clause now appended.

3. **Compound SELECT tail** (`selectToString`, ~line 421).
   The old arm read `stmt.union` / `stmt.unionAll` — fields the parser
   never populates. Replaced with a `stmt.compound`-driven branch and a
   new helper `compoundOpToKeyword` that maps the five op kinds (`union`,
   `unionAll`, `intersect`, `except`, `diff`) to their SQL keywords.
   `diff` is a Quereus extension recognized by the lexer (`lexer.ts:221`
   maps `'diff'` → `TokenType.DIFF`) and by the SELECT parser
   (`parser.ts:587`); it is rendered as the literal `diff`. The
   keyword-mapping switch is exhaustive (TS `never` check), so a future
   compound-op addition will fail the build rather than silently emit
   nothing.

### Decisions worth a second look

- **Did NOT emit `deferrable` / `initially deferred` on CHECK**, even though
  the `ColumnConstraint` and `TableConstraint` types carry those fields.
  The parser does not populate them for CHECK (verified at
  `parser.ts:3534-3544` and `parser.ts:3617-3645` — only the FOREIGN KEY
  clause reads them, see `foreignKeyClause` at `parser.ts:3697-3717`).
  Round-tripping unset fields is fine; emitting the keywords when the
  parser cannot consume them would produce SQL that fails to re-parse.
  The trailing comment in `parser.ts:3892` already documents
  "DEFERRABLE syntax not supported for CHECK constraints in Quereus."
  This is sibling territory for the property-test plan ticket if/when
  Quereus extends the grammar.

- **Kept `stmt.union` / `stmt.unionAll` on `SelectStmt`**. A grep
  (`find_references stmt.union | .unionAll`) shows they are referenced
  only by `visitor.ts:74` and `schema/rename-rewriter.ts:65,99,513` —
  both as `traverseAst(stmt.union, …)` style walks that are no-ops when
  the field is undefined. Removing the fields would also need updates
  in those traversal sites and a check on any external consumer. Out of
  scope here; the live `stmt.compound` is now the only emitter input.
  If the project wants the dead fields removed, that is a follow-up of
  its own.

- **Compound-op order is parser-natural and right-associative.** The
  ticket's original INTERSECT block (`A union all B intersect C union
  all D`) parsed as `A union all (B intersect (C union all D))` and
  yielded the wrong row set. I changed the INTERSECT and EXCEPT logic
  blocks to use single-leg sides so each test isolates one operator's
  emission — see the sqllogic note. Parser associativity is not what
  this ticket is about, but worth flagging if a future ticket wants to
  exercise it.

### Tests

**Unit** — `packages/quereus/test/emit/ast-stringify.spec.ts` (new file,
8 it() blocks; one parametrized loop covers both INTERSECT and EXCEPT).
These walk the **post-reparse AST**, not just stringified output —
the existing `emit-roundtrip.spec.ts` compared string-to-string and
passed even when the stringifier dropped legs symmetrically, which is
how this bug survived. Coverage:

- table-level `check on delete (false)` round-trips to `operations: ['delete']`
- table-level `check on update (...)` round-trips to `operations: ['update']`
- multi-op `check on insert, update (...)` round-trips with both ops in order
- inline column-level CHECK ON DELETE round-trips
- four-leg `select … union all select … union all select … union all
  select …` view body: all four legs reachable via the compound chain
- UNION (DISTINCT) keyword preserved (no spurious "all")
- INTERSECT and EXCEPT keywords preserved

**SQL logic** — appended to `50-declarative-schema.sqllogic` (5 new
schema blocks):

- **#23 verbatim** — `decl_check_ops`, `check on delete (false)`:
  INSERT succeeds (operations excludes insert), DELETE fails. Without
  the fix, INSERT would have errored.
- **Other half of the default mask** — `decl_check_upd`, `check on
  update (new.Val >= 0)`: INSERT of negative succeeds, UPDATE to negative
  fails, UPDATE to non-negative succeeds.
- **#21 verbatim** — `main.rgb_codes` view with three `union all` legs:
  all three rows present after `apply schema main`. Without the fix only
  the first leg's row survived.
- **UNION (DISTINCT)** — `main.distinct_union`: dedup verified.
- **INTERSECT** and **EXCEPT** — `main.two_only` and `main.one_only`,
  single-leg sides on each side of the operator.
- **Cross-fix smoke** — `decl_check_cmpd`, `check (Color in (select 'r'
  union all select 'g' union all select 'b'))`: exercises both fixes on
  the same path (CHECK whose expression is a compound subquery).

Note on schema choice: the four compound-view tests use `main` because
declarative views in non-main schemas are emitted by the differ
(`schema-differ.ts:223`, `:832`) without a schema prefix and land in
`main` rather than the named schema. That is a separate pre-existing
issue, outside this ticket's scope. The CHECK tests do not have this
problem and use named schemas (`decl_check_ops`, `decl_check_upd`,
`decl_check_cmpd`).

### Validation

- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — **3226 passing**, 0
  failures. Baseline on `main` (with my changes stashed and the unit
  test file moved aside) was 3219 passing; the +7 delta matches the
  added tests (mocha consolidates the parametrized INTERSECT/EXCEPT
  loop into one `it`, plus the sqllogic file counts as a single mocha
  test even when many blocks are added).
- `yarn test` at the repo root halts at `packages/quereus-isolation`
  with a TypeScript exhaustive-check error (`isolation-module.ts:564`
  — missing `addConstraint` case). **Confirmed pre-existing on main
  via stash + replay** — unrelated to this ticket. Worth a separate
  fix ticket if not already tracked.
- Did not run `yarn test:store` / `yarn test:full` per ticket guidance.

### Known gaps / what I did NOT do

- **Did not** add coverage for `'diff'` compound op in a view body. The
  emitter maps it (`compoundOpToKeyword` covers all five), but I did
  not validate the runtime semantics through a sqllogic block — the
  semantics test would belong with whatever ticket originally defined
  `DIFF`, and the stringifier change is purely literal substitution.
- **Did not** touch the visitor / rename-rewriter sites that still walk
  `stmt.union`. They are no-ops when the field is undefined (which is
  always, post-fix) but are technically dead. Cleanup is its own ticket.
- **Did not** fix the pre-existing "declared view in non-main schema
  drops to main" issue surfaced while writing the sqllogic tests.
  Worked around by using `main` for the four compound-view blocks.
  If the project cares, that is a separate fix ticket.

### Validation use cases for the reviewer

Quick repro of the original bugs against `main` to confirm the fix has
teeth:

```sql
-- Issue #23 — should INSERT cleanly and reject DELETE.
declare schema t {
    table NoDel (Id int, primary key (Id),
        constraint X check on delete (false));
}
apply schema t;
insert into t.NoDel (Id) values (1);   -- pre-fix: errors with CHECK
delete from t.NoDel where Id = 1;       -- always errors (intended)
```

```sql
-- Issue #21 — view should expose all three legs.
declare schema main {
    view V as
        select 'r' as Code
        union all select 'g' as Code
        union all select 'b' as Code
}
apply schema main;
select Code from V order by Code;       -- pre-fix: only 'r'
```

Both blocks fail on `main` and pass on this branch.
