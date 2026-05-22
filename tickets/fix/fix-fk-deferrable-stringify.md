description: `ForeignKeyClause.deferrable` / `initiallyDeferred` are populated by the parser but silently dropped by the stringifier. Both column-level and table-level foreign-key arms in `ast-stringify.ts` omit the `[NOT] DEFERRABLE [INITIALLY DEFERRED|IMMEDIATE]` clause. `ast-stringify.ts:1-13` calls this out as a TODO.
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
----

## Problem

`parser.ts:3680-3720 parseForeignKeyClause` reads `[NOT] DEFERRABLE [INITIALLY DEFERRED|IMMEDIATE]` after the `ON DELETE` / `ON UPDATE` clauses and sets `deferrable` / `initiallyDeferred` on `ForeignKeyClause`.

`ast-stringify.ts:936-946` (column constraint, `foreignKey` arm) and the corresponding table-constraint arm emit `references <table>(<cols>) on delete … on update …` only — `deferrable` / `initiallyDeferred` are never serialized. Same field-drop class as #21/#23 fixed in `fix-ast-stringify-check-ops-and-compound-select`.

## Fix

After the `on delete`/`on update` emission in both FK arms, append a deferrability clause:

```ts
if (fk.deferrable !== undefined) {
    s += fk.deferrable ? ' deferrable' : ' not deferrable';
    if (fk.initiallyDeferred !== undefined) {
        s += fk.initiallyDeferred ? ' initially deferred' : ' initially immediate';
    }
}
```

Factor the emission into a `foreignKeyClauseTail(fk)` helper used by both the column-constraint `foreignKey` case and the table-constraint `foreignKey` case (they currently duplicate the `references … on delete … on update …` body — DRY out the deferrability together with that).

Also drop the `(TODO: FOREIGN KEY default actions and deferrability)` note in the file header (`ast-stringify.ts:12`).

## Test plan

- Extend the FK arbitraries in `packages/quereus/test/emit-roundtrip-property.spec.ts` (column-FK and table-FK records) to generate `deferrable` and `initiallyDeferred` — currently both fields are absent from those `fc.record` shapes.
- Add unit tests in `packages/quereus/test/emit/ast-stringify.spec.ts` for each of the four legal combinations (DEFERRABLE, DEFERRABLE INITIALLY DEFERRED, DEFERRABLE INITIALLY IMMEDIATE, NOT DEFERRABLE) at both column and table level — assert via post-reparse AST.
