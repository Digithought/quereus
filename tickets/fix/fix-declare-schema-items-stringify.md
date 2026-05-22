description: `DeclareSchema` items are stubbed in the stringifier — `declareItemToString` emits placeholders like `table X { ... }` instead of serializing the actual table/view/index/assertion body. A `DeclareSchemaStmt` cannot round-trip.
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/parser.ts
----

## Problem

`ast-stringify.ts:870-887 declareItemToString` emits stub placeholders:

```ts
if (it.type === 'declaredTable') {
    return `table ${it.tableStmt.table.name} { ... }`;
}
// declaredIndex, declaredView, declaredAssertion all similar
```

The `{ ... }` and `(...)` payloads drop every field of the embedded statement. The property test (`packages/quereus/test/emit-roundtrip-property.spec.ts`) excludes `DeclareSchema` entirely; the unit suite `packages/quereus/test/emit/ast-stringify.spec.ts` doesn't cover it.

## Fix sketch

Walk the parser's declare-item productions (around `parser.ts:2710 declareSchemaStatement` and following) and mirror them in the stringifier. Each declared-item arm should call the matching top-level emitter (`createTableToString`, `createIndexToString`, etc.) so the body round-trips. The declarative-schema wrapper syntax (`table <name> { … }`) likely needs its own per-item formatter — coordinate with the planner ticket `plan-declarative-schema-semantic-equivalence` which already covers semantic equivalence on the schema graph.

`declaredSeed` already emits `seed <tbl> ((v1, v2), …)` using `JSON.stringify`; verify the parser actually consumes the JSON-encoded form (it may want SQL literal escaping instead).

## Test plan

- Add a `declareSchemaArb` to `packages/quereus/test/emit-roundtrip-property.spec.ts` once the stringifier serializes real bodies — generate a small `DeclareSchemaStmt` with one declared table, then assert round-trip.
- Add unit cases in `packages/quereus/test/emit/ast-stringify.spec.ts` exercising each declared-item kind.
