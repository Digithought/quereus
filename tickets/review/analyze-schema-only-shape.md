description: Review the `ANALYZE <schema>.*` surface syntax that closes the AnalyzeStmt round-trip gap (schema-only shape was stringifiable but unparseable).
prereq:
files:
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/planner/nodes/analyze-node.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit-missing-types.spec.ts
  packages/quereus/test/optimizer/statistics.spec.ts
  docs/sql.md
----

## What was implemented

Closed the `AnalyzeStmt` round-trip gap: the stringifier could emit a schema-only shape
(`{schemaName}`, no `tableName`) but no successful parse produced it, so a hand-built
schema-only AST silently re-parsed to a *different* AST (`{tableName: schema}`).

Fix: added SQLite's `ANALYZE <schema>.*` surface syntax. The schema-only shape now both
parses and stringifies, round-tripping cleanly.

### Behavior now

```
analyze        → {}                            → "analyze"
analyze foo    → {tableName:"foo"}             → 'analyze foo'
analyze a.b    → {schemaName:"a",tableName:"b"} → 'analyze a.b'
analyze main.* → {schemaName:"main"}           → 'analyze main.*'   ← NEW, round-trips
```

### Changes

- **Parser** (`parser.ts` `analyzeStatement`, ~2689): after a `DOT`, branch on `ASTERISK` →
  return `{type:'analyze', schemaName: name1}` (no tableName); else parse second identifier
  as before. Docstring updated to include `| ANALYZE schema.*`.
- **Stringifier** (`ast-stringify.ts` `analyzeToString`, ~810): schema-only clause now emits
  `analyze <schema>.*`.
- **Plan node** (`analyze-node.ts` `toString()`): added schema-only branch → `ANALYZE <schema>.*`
  so EXPLAIN output matches.
- `runtime/emit/analyze.ts` was **not** changed — it already analyzes every non-view table in
  `targetSchemaName` when `targetTableName` is undefined, which is exactly the `main.*` semantics.
  Its `note` string (`ANALYZE ${targetTableName ?? 'all tables'}`) was left as-is (optional polish
  only, per ticket).
- **Docs** (`docs/sql.md`): added `analyze main.*` example and updated the `analyze_stmt` grammar.

## Tests added

- `emit-roundtrip-property.spec.ts`: removed the stale "known gap" comment; added the schema-only
  arbitrary (`identArb.map(schemaName => ({type:'analyze', schemaName}))`) to `analyzeArb`, so the
  property `parse(stringify(ast)) ≡ ast` now covers all four shapes. Added a direct parse assertion
  that `ANALYZE main.*` parses to `{schemaName:'main', tableName: undefined}`.
- `emit-missing-types.spec.ts`: added a schema-only stringify case.
- `optimizer/statistics.spec.ts`: added `ANALYZE main.*` integration test asserting it analyzes
  every table in the schema (products=100, widgets=3).

## Validation done

- `yarn workspace @quereus/quereus run build` — exit 0.
- `yarn workspace @quereus/quereus test` — 3608 passing, 9 pending, 0 failing.
- ESLint on the three touched source files — clean.

## Notes / things to scrutinize

- **Assertion looseness**: `quoteIdentifier('main')` returns `main` unquoted (it's a safe
  identifier), so the emit-missing-types test asserts `.include('main')` + `.include('.*')`
  rather than an exact string. The round-trip property test is the real guard against
  shape-changing emits; the stringify unit test is a weaker sanity check. A reviewer may want
  an exact-string case using an identifier that *does* require quoting (e.g. a reserved word or
  one with special chars) to confirm `analyze "weird name".*` round-trips too.
- **`schema.*` vs `*` for table glob**: only the `schema.*` form is supported; bare `analyze *`
  is not (and isn't SQLite syntax). Confirm that's the intended surface.
- The runtime emitter's `note` string still says `all tables` for the schema-only case rather
  than `schema.*` — purely cosmetic in EXPLAIN, left per ticket's "optional polish only".
- No `.sqllogic` coverage was added; the integration assertion lives in the optimizer spec.
