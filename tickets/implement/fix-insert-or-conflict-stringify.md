description: `InsertStmt.onConflict` can't round-trip — the stringifier emits the retired trailing `on conflict <res>` clause, which the parser no longer accepts. Move the conflict resolution into the `INSERT OR <res>` lead-in, which is the only surface the parser still produces it from.
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
----

## Background

`InsertStmt.onConflict` is populated **only** by the `INSERT OR <res>` lead-in
(`packages/quereus/src/parser/parser.ts:333-339`). The trailing
`on conflict <res>` clause was retired in favor of UPSERT
(`ON CONFLICT [(cols)] DO …`); the parser at `parser.ts:410-426` only
accepts `ON CONFLICT` as an UPSERT lead, validates `DO UPDATE …`/`DO NOTHING`,
and explicitly rejects mixing the two surfaces (`parser.ts:418-420`).

`packages/quereus/src/emit/ast-stringify.ts:565-567` (in `insertToString`)
emits the trailing form. So an AST with `onConflict = REPLACE` stringifies to
`insert into t … values (…) on conflict replace`, which the parser then
rejects (or, if accepted via a different code path, would not round-trip).

`ConflictResolution.ABORT` is the default and is dropped by the stringifier
in the current and the proposed code, matching the
`emit-roundtrip-comparator` convention that treats `undefined` and `ABORT`
as equivalent.

The property-test arbitrary in `emit-roundtrip-property.spec.ts:660-673`
documents the gap (comment block + an `insertArb` that never sets
`onConflict`). After this fix the comment goes away and the arbitrary draws
from `conflictResArb`.

## Fix

In `insertToString` (ast-stringify.ts), inject the `OR <res>` token after
`insert` and before `into`, then drop the trailing emission entirely:

```ts
parts.push('insert');
if (stmt.onConflict && stmt.onConflict !== ConflictResolution.ABORT) {
    parts.push('or', ConflictResolution[stmt.onConflict].toLowerCase());
}
parts.push('into', expressionToString(stmt.table));
```

Remove lines 565-567 (the trailing `on conflict <res>` push). UPSERT
emission (the `stmt.upsertClauses` loop) is unchanged.

## TODO

- Edit `insertToString` in `packages/quereus/src/emit/ast-stringify.ts`:
  - Replace the single `parts.push('insert into', expressionToString(stmt.table))` call with three pushes: `insert`, the optional `or <res>` pair, then `into <table>`.
  - Delete the `if (stmt.onConflict && stmt.onConflict !== ConflictResolution.ABORT)` block at lines 565-567.
- Update `packages/quereus/test/emit-roundtrip-property.spec.ts`:
  - Drop the multi-line `Note: legacy INSERT OR <res> …` comment above `insertArb` (lines 660-663).
  - Extend `insertArb` to draw an extra `conflictResArb` value and set `stmt.onConflict` when defined. Do **not** also generate `upsertClauses` in the same statement — the parser rejects the mix.
- Add an `INSERT OR <res> lead-in` describe block to `packages/quereus/test/emit/ast-stringify.spec.ts`:
  - Cover `ROLLBACK`, `FAIL`, `IGNORE`, `REPLACE` (table-driven). For each: parse `insert or <res> into T (a, b) values (1, 2)`, stringify, regex-match the emitted SQL for `^insert\s+or\s+<res>\s+into\b`, re-parse, assert `onConflict` survives.
  - Include an ABORT case asserting the OR clause is dropped (default) and the emitted SQL matches `^insert\s+into\b`.
  - Add `InsertStmt` to the existing AST-type import block and import `ConflictResolution` from `../../src/common/constants.js`.
- Verify the parser's existing mutual-exclusivity check still fires by leaving `upsertClauses` out of the new INSERT arbitrary (no separate test needed — the parser error message at `parser.ts:418-420` is already exercised by other tests).
- Run `yarn workspace @quereus/quereus run test --grep "round-trip"` and `… --grep "INSERT"` and confirm green.

## End
