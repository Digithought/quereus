description: `CREATE TEMP TABLE` / `CREATE TEMP VIEW` cannot round-trip — `ast-stringify.ts` emits `create temp …` but the parser's `createStatement` dispatcher peeks for TABLE/INDEX/VIEW/ASSERTION/UNIQUE only, with no TEMP/TEMPORARY hop. The TEMP-detection branches in `createTableStatement` / `createViewStatement` are unreachable.
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
----

## Problem

Stringifier output for an `AST.CreateTableStmt { isTemporary: true }`:

```
create temp table x (…)
```

fails to parse with:

```
Expected TABLE, [UNIQUE] INDEX, VIEW, ASSERTION, or VIRTUAL after CREATE.
```

`parser.ts:2144 createStatement` dispatches directly on the next keyword token. The TEMP/TEMPORARY detection at `createTableStatement:2171` and `createViewStatement:2350` only fires if dispatch already routed there, but `TABLE`/`VIEW` is gone by then. The `temp` token in `create temp table x (…)` is read as the post-CREATE object keyword and rejected.

## Fix sketch

Hoist the TEMP/TEMPORARY peek into `createStatement` (or into the top-level CREATE branch in `parse`) before the TABLE/VIEW/INDEX/ASSERTION dispatch:

```ts
private createStatement(startToken, withClause?) {
    let isTemporary = false;
    if (this.peekKeyword('TEMP') || this.peekKeyword('TEMPORARY')) {
        isTemporary = true;
        this.advance();
    }
    if (this.peekKeyword('TABLE')) {
        this.consumeKeyword('TABLE', …);
        return this.createTableStatement(startToken, isTemporary, withClause);
    }
    // … pass isTemporary into createViewStatement as well
}
```

Either remove the now-dead detection inside `createTableStatement` / `createViewStatement` or have those methods accept the pre-parsed flag. `CREATE TEMP INDEX` / `CREATE TEMP ASSERTION` are syntactically invalid in SQLite — the hoisted peek should reject TEMP for those branches.

## Test plan

- Re-enable `isTemporary: true` in `createTableArb` / `createViewArb` in `packages/quereus/test/emit-roundtrip-property.spec.ts` (each currently carries a `Note:` comment fixed to `isTemporary: false` citing this finding).
- Add an explicit case in `packages/quereus/test/emit/ast-stringify.spec.ts` exercising `create temp table` and `create temporary table` (both forms) plus `create temp view`.
- Verify `temp` and `temporary` are both accepted (parser presently matches either keyword; keep that surface).
