description: Review parser fix that hoists TEMP/TEMPORARY detection out of `createTableStatement` / `createViewStatement` and into the top-level `createStatement` dispatcher so `create temp table` / `create temp view` now parse and round-trip through the stringifier.
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
  packages/quereus/test/logic/08.1-view-edge-cases.sqllogic
----

## What changed

### `packages/quereus/src/parser/parser.ts`

- `createStatement` (around line 2144) now peeks for `TEMP`/`TEMPORARY` **before** dispatching on TABLE/INDEX/VIEW/ASSERTION/UNIQUE. If present, it consumes the token and routes only to `createTableStatement` or `createViewStatement`, threading the resulting `isTemporary` flag in as a parameter. If `TEMP`/`TEMPORARY` is followed by anything other than TABLE/VIEW, a parser error is raised (`"Expected TABLE or VIEW after CREATE TEMP/TEMPORARY."`). This deliberately rejects `CREATE TEMP INDEX`, `CREATE TEMP UNIQUE INDEX`, and `CREATE TEMP ASSERTION` — none are valid in SQLite.
- `createTableStatement` now takes `isTemporary: boolean` as a parameter. The dead peek block that used to live at the top of the method (and was unreachable because the dispatcher rejected `TEMP` before reaching it) has been removed.
- `createViewStatement` got the same treatment.

The only callers of `createTableStatement` / `createViewStatement` are the dispatcher in `createStatement` — verified by `grep`. No other code paths needed updating.

### `packages/quereus/test/emit-roundtrip-property.spec.ts`

`createTableArb` and `createViewArb` now generate `isTemporary` via `fc.boolean()` instead of pinning it to `false`. The `Note:` paragraphs explaining the previous known-broken state were removed. Property tests now exercise both branches.

### `packages/quereus/test/emit/ast-stringify.spec.ts`

Added a `CREATE TEMP TABLE / VIEW dispatch` describe block with three unit tests that parse → stringify → re-parse:

- `create temp table T (...)` — asserts `isTemporary === true` on both the initial parse and the post-stringify reparse.
- `create temporary table T (...)` — same assertion, exercises the alternate keyword.
- `create temp view V as select 1 as N` — same shape but for views.

These walk the AST (consistent with the file's style) rather than asserting on the emitted SQL string.

### `packages/quereus/test/logic/08.1-view-edge-cases.sqllogic`

Two sections were marked `-- Quereus parser doesn't support CREATE TEMP VIEW` with `-- error:` expectations. Since the parser now does support it, both have been updated:

- Section 3 (TEMP VIEW lifecycle): now creates `tv_t` as a temp view, selects from it (asserting the filter `val > 10` returned the expected row), and drops it before tearing down the base table.
- Section 5 (schema-qualified): now creates `temp.sq_tv` and drops it cleanly. (No assertion query was added here because the original test was schema-qualification-focused, and the only change is removing the error gate.)

## Use cases / things to verify in review

- Parse `create temp table T (id int, primary key (id))` and `create temporary table T (id int, primary key (id))` — both should produce a `CreateTableStmt` with `isTemporary: true`.
- Parse `create temp view V as select 1 as N` — should produce a `CreateViewStmt` with `isTemporary: true`.
- Stringify either and reparse — `isTemporary` should survive.
- Try `create temp index X on T (id)`, `create temp unique index X on T (id)`, and `create temp assertion X check (1)` — each should raise the new error message `"Expected TABLE or VIEW after CREATE TEMP/TEMPORARY."` rather than silently succeeding or producing a confusing downstream error.
- The combination `CREATE TEMP IF NOT EXISTS TABLE T (...)` is **not** valid (and never was) — `TEMP` must come before `TABLE`/`VIEW`, then `IF NOT EXISTS` is parsed inside the per-stmt method. This was already the structure; no change there.

## Known gaps / things I deliberately didn't do

- The fix is parser-only. The downstream planner / schema layer accepts `isTemporary: true` for views (the sqllogic test successfully creates and queries a temp view), but **I did not audit how `isTemporary` is interpreted by the schema manager or whether temp tables/views are scoped correctly per-connection** — that was outside the ticket's scope (the ticket is about the parser dispatch and round-trip). If the reviewer wants end-to-end temp-namespace semantics tested, that's a separate ticket.
- The lexer maps `TEMP` and `TEMPORARY` to distinct tokens (`lexer.ts:23-24`); the disjunction `peekKeyword('TEMP') || peekKeyword('TEMPORARY')` covers both, matching the convention used elsewhere in the parser.
- No CHANGELOG entry — this project doesn't appear to maintain one (none touched in recent commits).

## Validation performed

- `yarn workspace @quereus/quereus run test` — **3274 passing**, 0 failing. (Run twice; the first run surfaced one sqllogic failure that was the now-obsolete `-- error:` expectation; updated as described and re-ran clean.)
- `yarn workspace @quereus/quereus run lint` — exit 0, no warnings.
- Property tests (`emit-roundtrip-property.spec.ts`) now exercise `isTemporary ∈ {true, false}` for both `createTable` and `createView` arbitraries, confirming round-trip parity across the new branch.
