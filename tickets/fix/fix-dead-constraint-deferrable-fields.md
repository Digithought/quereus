description: `ColumnConstraint.deferrable` / `initiallyDeferred` and `TableConstraint.deferrable` / `initiallyDeferred` are declared in `parser/ast.ts` but never populated by the parser. The only deferrability the parser writes is on the embedded `ForeignKeyClause`. Either remove the dead fields, or wire the parser to set them when `[NOT] DEFERRABLE …` follows a non-FK constraint (SQLite-style).
prereq: fix-fk-deferrable-stringify
files:
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/parser/parser.ts
----

## Problem

`parser/ast.ts:432-433` (ColumnConstraint) and `:446-447` (TableConstraint) declare:

```ts
deferrable?: boolean;
initiallyDeferred?: boolean;
```

Grep over `parser.ts` shows the only assignments to `deferrable` / `initiallyDeferred` are inside `parseForeignKeyClause` (`parser.ts:3680-3720`) and they land on the `ForeignKeyClause` shape — never on the surrounding `ColumnConstraint` / `TableConstraint`. So the two fields on the constraint types are dead.

## Two-option fix

Decide which behavior we want, then converge:

1. **Drop the fields.** Remove `deferrable` / `initiallyDeferred` from `ColumnConstraint` and `TableConstraint` in `parser/ast.ts`. The stringifier never references them (`ast-stringify.ts:898-955 columnConstraintsToString`, plus the table-constraint emitter). Any downstream callers fail to compile — surface them and triage.
2. **Wire the parser.** Accept `[NOT] DEFERRABLE [INITIALLY DEFERRED|IMMEDIATE]` after a non-FK column constraint (CHECK / UNIQUE / PRIMARY KEY) and after a table-level constraint. SQLite syntax does allow this on UNIQUE and PRIMARY KEY constraints (though it's a no-op outside FK context). If we adopt this, the stringifier needs the same emission helper as `fix-fk-deferrable-stringify` — extract `deferrabilityTail(c)` and reuse from both `columnConstraintsToString` and `tableConstraintsToString`.

Recommendation: option 1 unless we have a planner reason to track deferrability on non-FK constraints. The audit ticket (`ast-emit-stringify-audit`) listed these as "dead — drop or wire."

## Test plan

- After landing, sample shrinking from the property test: temporarily set `deferrable` / `initiallyDeferred` on a non-FK column constraint in a unit test and confirm it either (option 1) becomes a type error, or (option 2) round-trips through the stringifier.
- If option 2, extend the column-constraint arbitrary in `packages/quereus/test/emit-roundtrip-property.spec.ts` to attach deferrability to the PK / UNIQUE / CHECK arms.
