description: Support `ANALYZE <schema>.*` (SQLite syntax) in the parser and emit that form when `schemaName && !tableName`, closing the round-trip gap where the stringifier produced an `AnalyzeStmt` shape no parse could yield.
prereq:
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/planner/nodes/analyze-node.ts
  packages/quereus/src/runtime/emit/analyze.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit-missing-types.spec.ts
  packages/quereus/test/optimizer/statistics.spec.ts
----

## Problem

`AnalyzeStmt` allows three meaningful shapes, but the parser and stringifier disagree on a fourth:

| shape | parser can produce? | stringifier emits |
|---|---|---|
| `{}` | ✅ `analyze` | `analyze` |
| `{tableName}` | ✅ `analyze foo` | `analyze "foo"` |
| `{schemaName, tableName}` | ✅ `analyze a.b` | `analyze "a"."b"` |
| `{schemaName}` (no table) | ❌ never | `analyze "schema"` ← re-parses to `{tableName: "schema"}` |

`parser.ts` `analyzeStatement` (currently ~2689-2702) treats a single bare identifier as `tableName`, *always*. So `{schemaName, tableName: undefined}` is unreachable from any successful parse, yet `ast-stringify.ts` `analyzeToString` (line ~810) has a clause `if (stmt.schemaName) return 'analyze ' + quoteIdentifier(stmt.schemaName)`. A hand-built `AnalyzeStmt` with only `schemaName` therefore stringifies to SQL that silently re-parses to a *different* AST — a shape-changing round-trip with no error.

## Fix

Make the schema-only shape **representable and round-trippable** by adding SQLite's `ANALYZE <schema>.*` surface syntax:

- Parser: after consuming `name1` and a `DOT`, if the next token is `ASTERISK` (`TokenType.ASTERISK`, see `lexer.ts:136`), consume it and return `{type: 'analyze', schemaName: name1}` (no `tableName`). Otherwise parse the second identifier as today → `{schemaName: name1, tableName: name2}`.
- Stringifier: change the schema-only clause to emit `analyze <schema>.*`.

This is the correct semantic match: the runtime emitter (`runtime/emit/analyze.ts`) already analyzes **every table in `targetSchemaName`** when `targetTableName` is undefined, so `ANALYZE main.*` already has well-defined "analyze all tables in `main`" behavior — only the parse + stringify surface is missing.

### Behavior after fix

```
analyze              → {}                          → "analyze"
analyze foo          → {tableName:"foo"}           → 'analyze "foo"'
analyze a.b          → {schemaName:"a",tableName:"b"} → 'analyze "a"."b"'
analyze main.*       → {schemaName:"main"}         → 'analyze "main".*'   ← NEW, round-trips
```

## TODO

### Parser
- In `parser.ts` `analyzeStatement`, after `this.match(TokenType.DOT)`, branch on `this.match(TokenType.ASTERISK)`: if matched, return `{ type: 'analyze', schemaName: name1, loc: ... }`; else consume the identifier as before. Update the docstring `ANALYZE [schema.]table | ANALYZE` → include `| ANALYZE schema.*`.

### Stringifier
- In `ast-stringify.ts` `analyzeToString`, change the third clause to: `if (stmt.schemaName) return \`analyze ${quoteIdentifier(stmt.schemaName)}.*\`;`

### Plan-node display (consistency, low priority)
- `analyze-node.ts` `toString()`: add a schema-only branch returning `ANALYZE ${this.targetSchemaName}.*` so EXPLAIN output matches. (Optional but cheap; same three-way fall-through as the stringifier.)
- `runtime/emit/analyze.ts` `note`: currently `ANALYZE ${plan.targetTableName ?? 'all tables'}` — fine as-is, but consider `${targetTableName ?? (targetSchemaName ? schema + '.*' : 'all tables')}`. Optional polish only.

### Tests
- `emit-roundtrip-property.spec.ts`: add the schema-only arbitrary `fc.constant`/`identArb.map(schemaName => ({type:'analyze', schemaName}))` to `analyzeArb`, and **remove the "known gap" comment block** above it (lines ~641-648) since the gap is closed. Property: parse(stringify(ast)) deep-equals ast for all four shapes.
- `emit-missing-types.spec.ts` (`describe('analyze')`): add a case for `{type:'analyze', schemaName:'main'}` asserting the result equals `analyze "main".*` (or `.include('main')` + `.include('.*')`), confirming it is no longer mis-emitted as `analyze "main"`.
- Add a parser-level assertion (in whichever spec covers parse → AST; if none exists for analyze, fold a small parse round-trip into `emit-roundtrip-property` or `emit-missing-types`) that `ANALYZE main.*` parses to `{type:'analyze', schemaName:'main', tableName: undefined}`.
- Optionally extend `optimizer/statistics.spec.ts` with an `ANALYZE main.*` integration case asserting it analyzes all tables in the schema (mirror the existing `ANALYZE colors` test but schema-wide).

### Validation
- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/analyze-test.log; tail -n 80 /tmp/analyze-test.log` (PowerShell: use `Tee-Object`)
- Lint the touched files.
