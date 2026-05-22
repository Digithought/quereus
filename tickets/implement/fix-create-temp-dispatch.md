description: Fix `CREATE TEMP TABLE` / `CREATE TEMP VIEW` parser dispatch so stringifier output round-trips. Hoist the TEMP/TEMPORARY peek into `createStatement` before the TABLE/INDEX/VIEW/ASSERTION/UNIQUE dispatch, then thread the resulting flag into `createTableStatement` / `createViewStatement`. Reject TEMP for INDEX/ASSERTION/UNIQUE branches.
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
----

## Root cause

`parser.ts:2144 createStatement` dispatches directly on the next keyword token after `CREATE`, recognising only TABLE / INDEX / VIEW / ASSERTION / UNIQUE. The TEMP/TEMPORARY detection inside `createTableStatement` (`parser.ts:2171`) and `createViewStatement` (`parser.ts:2350`) is dead code — control never reaches it because the `TEMP` token is rejected one level up.

The top-level `parse` (`parser.ts:291`) does `case 'CREATE': this.advance(); stmt = this.createStatement(...)` so the fix must live in `createStatement` (or be split across both methods).

Stringifier output that fails today (from `ast-stringify.ts:741, 1036`):

- `create temp table x (...)` for `CreateTableStmt { isTemporary: true }`
- `create temp view v as select ...` for `CreateViewStmt { isTemporary: true }`

Both throw `Expected TABLE, [UNIQUE] INDEX, VIEW, ASSERTION, or VIRTUAL after CREATE.`

The property-based round-trip suite (`emit-roundtrip-property.spec.ts`) currently pins `isTemporary: false` in `createTableArb` and `createViewArb` with `Note:` comments citing this finding (lines 309-313, 343).

## Fix

In `createStatement` (`parser.ts:2144`), peek for TEMP/TEMPORARY before the existing dispatch. If present, consume it and only allow the TABLE or VIEW branch to follow; raise an error if INDEX/UNIQUE/ASSERTION follows TEMP (those are not valid in SQLite). Thread the resulting `isTemporary` flag into `createTableStatement` / `createViewStatement` as a new parameter and remove the now-unreachable peek inside each. Keep both `TEMP` and `TEMPORARY` accepted — the existing lexer maps each to its own keyword (`lexer.ts:23-24`), and the disjunction at the call sites covers both.

Sketch:

```ts
private createStatement(startToken, withClause?) {
    let isTemporary = false;
    if (this.peekKeyword('TEMP') || this.peekKeyword('TEMPORARY')) {
        isTemporary = true;
        this.advance();
    }
    if (this.peekKeyword('TABLE')) {
        this.consumeKeyword('TABLE', ...);
        return this.createTableStatement(startToken, isTemporary, withClause);
    } else if (this.peekKeyword('VIEW')) {
        this.consumeKeyword('VIEW', ...);
        return this.createViewStatement(startToken, isTemporary, withClause);
    } else if (isTemporary) {
        throw this.error(this.peek(), "Expected TABLE or VIEW after CREATE TEMP/TEMPORARY.");
    } else if (this.peekKeyword('INDEX')) { ... }
    // ... (INDEX, ASSERTION, UNIQUE INDEX as before)
}

private createTableStatement(startToken, isTemporary, _withClause?) {
    // delete lines 2170-2174; use parameter instead.
    ...
}

private createViewStatement(startToken, isTemporary, withClause?) {
    // delete lines 2349-2353; use parameter instead.
    ...
}
```

## TODO

- Modify `createStatement` (`parser.ts:2144-2163`) to peek/advance TEMP/TEMPORARY first; reject the combo with INDEX / UNIQUE / ASSERTION.
- Update `createTableStatement` (`parser.ts:2169`) to accept `isTemporary: boolean` as a parameter; delete the dead peek at 2170-2174; use the parameter when building the AST at 2279.
- Update `createViewStatement` (`parser.ts:2348`) the same way; delete the dead peek at 2349-2353.
- In `emit-roundtrip-property.spec.ts`: change `createTableArb` (line 327) and `createViewArb` (line 353) to make `isTemporary` an `fc.boolean()` field, and remove the `Note:` paragraphs at 309-313 and 343 that pin it false.
- Add unit cases in `test/emit/ast-stringify.spec.ts`: parse → stringify → re-parse for `create temp table`, `create temporary table`, and `create temp view`. Walk the post-reparse AST to assert `isTemporary === true` (consistent with that file's "walk the AST, not the string" style).
- Run `yarn workspace @quereus/quereus run test` and confirm the new cases + property tests pass.
- Run `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
