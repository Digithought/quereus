description: Wire `[NOT] DEFERRABLE [INITIALLY ...]` through the AST stringifier so `ForeignKeyClause.deferrable` / `initiallyDeferred` round-trip on both column-level and table-level foreign keys. Implementation already in place; this ticket exists to gate the review pass.
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
----

## What landed

- `ast-stringify.ts`: dropped the FK-deferrability TODO from the file header. Factored the FK clause body (`references … on delete … on update …`) into a new `foreignKeyClauseTail(fk)` helper and extended it to emit ` [not] deferrable [initially deferred|immediate]` when `fk.deferrable !== undefined`. Both the column-constraint `foreignKey` arm (`columnConstraintsToString`) and the table-constraint `foreignKey` arm (`tableConstraintsToString`) now delegate to the helper, eliminating the prior duplication.
- `emit-roundtrip-property.spec.ts`: added an `fkDeferrabilityArb` arbitrary covering the seven legal shapes (`{}`, `DEFERRABLE`, `DEFERRABLE INITIALLY DEFERRED|IMMEDIATE`, `NOT DEFERRABLE`, `NOT DEFERRABLE INITIALLY DEFERRED|IMMEDIATE`). Both the column-FK and table-FK record shapes now include it and propagate `deferrable` / `initiallyDeferred` onto the generated `ForeignKeyClause`.
- `test/emit/ast-stringify.spec.ts`: added a `Foreign-key deferrability` describe block that pins all four canonical clauses (`DEFERRABLE`, `DEFERRABLE INITIALLY DEFERRED`, `DEFERRABLE INITIALLY IMMEDIATE`, `NOT DEFERRABLE`) at both column and table level via post-reparse AST assertions.

## Verified

`yarn workspace @quereus/quereus run test --grep "AST round-trip"` — 47 passing, including the 8 new deferrability cases and the property round-trip suites whose arbitraries now generate deferrability.

## Notes for review

- The helper deliberately keeps `initiallyDeferred` nested inside the `deferrable !== undefined` guard, mirroring the parser (`parser.ts:3688-3710`) which can only set `initiallyDeferred` once a DEFERRABLE/NOT DEFERRABLE token has been consumed. Generating `initiallyDeferred` without `deferrable` would emit invalid SQL.
- `ColumnConstraint` and `TableConstraint` themselves also expose `deferrable` / `initiallyDeferred` (ast.ts:432-433, 446-447), but the parser only writes them onto the inner `ForeignKeyClause` (parser.ts:3716). No code path currently sets them on the constraint, so the stringifier ignores them — flag if a future producer starts populating those fields.
