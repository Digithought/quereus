description: Fix two DDL stringifier drops in `packages/quereus/src/emit/ast-stringify.ts` that surface on the `declare schema` / `apply schema` (and `diff schema`) path — (a) CHECK `on insert|update|delete` operations list lost from column- and table-level constraints (issue #23: `check on delete (false)` fires on INSERT); and (b) compound-select tails lost from any SELECT (issue #21: `view V as A union all B union all C` becomes `view V as A`). Direct `create table`/`alter table` paths are unaffected because they wire the parsed AST straight into the schema; the bug only manifests when DDL is re-emitted and re-parsed.
prereq:
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/common/types.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## Background

Both bugs root-cause in `packages/quereus/src/emit/ast-stringify.ts`. The
declarative schema runtime (`runtime/emit/schema-declarative.ts:emitApplySchema`)
re-executes stringified DDL, so any field the stringifier drops is silently
lost after `apply schema`. The direct `create table` / `alter table` paths
bypass the stringifier entirely (parsed AST → schema), which is why
`40-constraints.sqllogic` and `08.1-view-edge-cases.sqllogic` pass today.

See `tickets/fix/1-fix-check-on-delete-lost-in-declarative-apply.md` (this
ticket's predecessor) for the full root-cause walk and issue links.

## Fix A — CHECK `operations` list

`AST.ColumnConstraint` and `AST.TableConstraint` both carry
`operations?: RowOp[]` where `RowOp = 'insert' | 'update' | 'delete'`
(`parser/ast.ts:423`, `:443`; `common/types.ts:161`). The stringifier drops
them at two sites:

- `columnConstraintsToString` — `ast-stringify.ts:903-905`
- `tableConstraintsToString` — `ast-stringify.ts:949-951`

Both currently emit only `check (<expr>)`. They must additionally emit
`on <op>[, <op>...]` whenever `c.operations?.length` is non-zero.

Notes:

- The parser populates `operations` for both column-level and table-level
  CHECK; verified by reading `parser/ast.ts` (the fields exist on both
  interfaces) and by the test added in §Tests below failing on `main`.
- Emit the clause whenever `operations` is present and non-empty, regardless
  of contents — round-tripping `check on insert, update (...)` back to the
  same literal is information-preserving even though it equals the default
  mask. Don't try to be clever about omitting "default" lists.
- Order: emit `on <ops>` between the expression and any `on conflict` /
  `deferrable` follow-ons. The parser accepts `check on <ops> (<expr>)` —
  match that surface form (operations precede the expression).
  Verify by re-parsing the emitted DDL in the unit test; if the parser
  only accepts one order, follow that order.
- Take the same pass to also emit `deferrable` / `initially deferred` /
  `on conflict <action>` on CHECK if the parser captures them (it does —
  fields are on both interfaces). Out-of-scope for the original bug but
  cheap and aligned. Verify by adding minimal unit-test coverage; if the
  parser doesn't round-trip cleanly, leave those drops to the broader
  property-test plan ticket and document the deferral here.

Don't touch the constraint-evaluation path. `opsToMask`
(`schema/table.ts:322-335`) and `shouldCheckConstraint`
(`planner/building/constraint-builder.ts:19-22`) are correct — the bug is
that they receive an empty `operations` array because the stringifier
dropped it.

## Fix B — compound SELECT tail

`selectToString` at `ast-stringify.ts:414-417` reads `stmt.union` /
`stmt.unionAll`. These fields exist on the AST (`parser/ast.ts:183-184`)
but the parser writes to `stmt.compound` instead (`parser/ast.ts:185`):

```ts
compound?: { op: 'union' | 'unionAll' | 'intersect' | 'except' | 'diff'; select: SelectStmt };
```

So the existing arm is dead code; every compound tail (union/unionAll/
intersect/except/diff) is silently dropped at every `selectToString`
call site (view bodies, CHECK subqueries, default-expr subqueries, any
future SQL export).

Replace the dead arm with one driven by `stmt.compound`:

- Recurse via `selectToString(stmt.compound.select)`.
- Map `stmt.compound.op` → keyword:
  - `'union' → 'union'`
  - `'unionAll' → 'union all'`
  - `'intersect' → 'intersect'`
  - `'except' → 'except'`
  - `'diff' → ?` — verify what the parser accepts as the literal SQL
    keyword for `'diff'` (it may be a Quereus extension). If unsure,
    throw `quereusError('unsupported compound op: ' + op)` rather than
    silently emit nothing — that surfaces the gap loudly instead of
    repeating the same class of bug.

Leave the unused `stmt.union` / `stmt.unionAll` fields alone in `ast.ts`
unless you're confident nothing else reads them (search the codebase
first — `find_references` `stmt.union` and `.unionAll`). If unused
elsewhere, drop them to prevent re-introducing the same dead arm;
otherwise leave a one-line comment that they are non-canonical and
`compound` is the source of truth.

## Tests

Add to `packages/quereus/test/logic/50-declarative-schema.sqllogic` (the
declarative-schema sqllogic file is where these regressions surface):

### CHECK on delete (issue #23 verbatim)

```sql
declare schema main
{
    table NoDelete (
        Id INTEGER,
        primary key (Id),
        constraint NoDeleteEver check on delete (false)
    );
}
apply schema main;
insert into NoDelete (Id) values (1);          -- must succeed
select Id from NoDelete;
→ [{"Id":1}]
delete from NoDelete where Id = 1;             -- must fail
-- error: CHECK constraint failed: NoDeleteEver
drop table NoDelete;
```

### CHECK on update only (isolates the other half of the default mask)

```sql
declare schema main
{
    table OnUpdOnly (
        Id INTEGER,
        Val INTEGER,
        primary key (Id),
        constraint NoNegOnUpdate check on update (new.Val >= 0)
    );
}
apply schema main;
insert into OnUpdOnly (Id, Val) values (1, -5);  -- must succeed
update OnUpdOnly set Val = -1 where Id = 1;       -- must fail
-- error: CHECK constraint failed: NoNegOnUpdate
drop table OnUpdOnly;
```

### View with compound select (issue #21 verbatim)

```sql
declare schema main {
    view V as
        select 'r' as Code, 'Red' as Name
        union all select 'g' as Code, 'Green' as Name
        union all select 'b' as Code, 'Blue' as Name;
}
apply schema main;
select Code from V order by Code;
→ [{"Code":"b"},{"Code":"g"},{"Code":"r"}]
drop view V;
```

### Compound operator coverage

One block each for `union` (DISTINCT), `intersect`, `except` in a view
body via `apply schema`. Pick small literal-row selects so the expected
output is obvious.

### CHECK subquery with compound select (cross-fix smoke)

```sql
declare schema main {
    table Palette (
        Color TEXT,
        primary key (Color),
        constraint InPalette check (Color in (
            select 'r' as c union all
            select 'g'      union all
            select 'b'
        ))
    );
}
apply schema main;
insert into Palette values ('g');   -- must succeed
insert into Palette values ('z');   -- must fail
-- error: CHECK constraint failed: InPalette
drop table Palette;
```

### Direct stringifier unit tests

Add `packages/quereus/test/emit/ast-stringify.spec.ts` (new file) with at
least two cases. These pin the round-trip at the unit level so a future
regression cannot quietly slip past sqllogic again:

- Parse a `create table T (Id INTEGER, primary key (Id), constraint X
  check on delete (false))`, pass through `createTableToString`, reparse,
  walk to `tableConstraints[0].operations` and assert it equals
  `['delete']`.
- Parse a four-leg `create view V as A union all B union all C union
  all D`, pass through `createViewToString`, reparse, walk
  `select.compound.select.compound.select.compound.select` (or whatever
  the nesting shape is — verify against the parser before encoding) and
  assert all four legs are reachable.

All five sqllogic blocks and both unit tests fail on `main` and pass with
the two arm fixes.

## Validation

- `yarn workspace @quereus/quereus run lint`
- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus run test` — stream with `tee`; ensure
  both new sqllogic blocks and the new unit spec are green, and that
  no existing test regresses (especially `40-constraints.sqllogic` —
  CHECK semantics on the direct-CREATE path must stay identical).

Do **not** run `yarn test:store` or `yarn test:full` for this ticket —
the fix is in the stringifier, not the storage layer, and `yarn test`
covers it.

## TODO

Phase 1 — verify surface details (don't skip; informs the code)

- [ ] Read `packages/quereus/src/parser/parser.ts` (or generated `.js`)
      around CHECK-constraint and SELECT-compound production to confirm
      (a) operations clause position relative to `(<expr>)` and
      (b) the exact `compound.op` string for every operator including
      whether `'diff'` has a SQL surface form.
- [ ] `find_references` for `.union` / `.unionAll` / `stmt.compound`
      across the codebase to confirm `stmt.union` is dead and nothing
      else relies on it.

Phase 2 — fix

- [ ] Edit `columnConstraintsToString` CHECK arm (`ast-stringify.ts:903-905`)
      to emit `check [on <ops>] (<expr>)` and append `deferrable` /
      `initially deferred` / `on conflict` if the parser round-trips them.
- [ ] Same fix in `tableConstraintsToString` CHECK arm
      (`ast-stringify.ts:949-951`).
- [ ] Replace `stmt.union` arm in `selectToString` (`ast-stringify.ts:414-417`)
      with `stmt.compound`-driven recursion; cover all parser-emitted ops;
      throw on unknown op rather than silently drop.

Phase 3 — tests

- [ ] Append the five sqllogic blocks above to
      `packages/quereus/test/logic/50-declarative-schema.sqllogic` in a
      new section with comment headers tying each to its GitHub issue
      (#23, #21).
- [ ] Create `packages/quereus/test/emit/ast-stringify.spec.ts` with the
      two unit tests described above. Use Mocha (match the rest of
      `packages/quereus/test/`).

Phase 4 — validate

- [ ] Run lint + build + `yarn test` from repo root (stream with `tee`).
- [ ] Confirm `40-constraints.sqllogic` and `08.1-view-edge-cases.sqllogic`
      still pass — the direct-DDL paths must not change behaviour.

Phase 5 — handoff

- [ ] Write the review ticket. Be explicit about (a) any drops you chose
      not to fix and why (e.g. `deferrable` on FOREIGN KEY if you skipped
      it — that's the sibling property-test ticket's territory) and
      (b) the `'diff'` compound-op decision (kept, errored, or punted).
