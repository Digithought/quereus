description: `analyze <schemaName>` (schema-only, no table) is emitted by `ast-stringify.ts:810` but unreachable from the parser surface — a single bare identifier in `analyze foo` always parses as `tableName`, not `schemaName`. So the AST shape `{schemaName, tableName: undefined}` cannot exist after a successful parse, yet the stringifier emits SQL that re-parses to a *different* AST shape. Needs a spec decision before any fix lands.
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/parser.ts
----

## Problem

`parser.ts:2693-2706` produces:

- `{type: 'analyze'}` (bare `ANALYZE;`),
- `{type: 'analyze', tableName: id}` (single identifier — *always* tableName),
- `{type: 'analyze', schemaName: a, tableName: b}` (dotted `a.b`).

`ast-stringify.ts:807-811`'s third clause emits `analyze <schemaName>` when `schemaName` is set but `tableName` is not. Re-parsing that SQL produces `{tableName: <schemaName>}` — a different shape.

The schema-only branch is structurally unreachable in legitimate planner output (every parser-produced AST omits this shape). But a downstream agent constructing an `AnalyzeStmt` by hand could trigger it, and the silent re-shaping would be hard to notice.

## Two viable fixes — pick one before writing code

1. **Treat the schema-only branch as a contract violation.** Throw in the stringifier:

   ```ts
   if (stmt.schemaName && !stmt.tableName) {
       throw new QuereusError("ANALYZE with only schemaName is not supported", StatusCode.INTERNAL);
   }
   ```

   Justification: parser-built ASTs never have this shape; only buggy hand-built ASTs do.

2. **Support `ANALYZE <schema>.*` in the parser** (SQLite syntax) and emit that form when `schemaName && !tableName`. This extends the surface — not just a stringify fix.

Option 1 is conservative and matches the current behavior of the rest of the codebase (planner-contract violations throw). Option 2 is the right move only if there's a real use case for "analyze every table in a schema" — none observed today.

## Resolution

This is a project-spec decision. Block on owner sign-off before implementing. Once resolved, lift the constraint in `analyzeArb` (`packages/quereus/test/emit-roundtrip-property.spec.ts`) — currently it generates none / tableName / schemaName+tableName and excludes the schema-only shape.
