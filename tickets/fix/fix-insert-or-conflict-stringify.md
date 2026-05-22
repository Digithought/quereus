description: `INSERT … on conflict <res>` (legacy trailing form) cannot round-trip. The stringifier emits the trailing form when `InsertStmt.onConflict` is set, but the parser only produces that field via the `INSERT OR <res>` lead-in. The trailing `on conflict <res>` clause was retired in favor of the UPSERT shape (`ON CONFLICT [(cols)] DO …`).
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
----

## Problem

`ast-stringify.ts:566-568` emits, for an `InsertStmt` whose `onConflict` is set to anything but `ABORT`:

```sql
insert into t (a, b) values (1, 2) on conflict replace
```

`parser.ts:410` only accepts the UPSERT form after `ON CONFLICT` (validates `DO UPDATE …` / `DO NOTHING`). The trailing-keyword form is no longer recognized. So the produced SQL re-parses to a different AST shape (or fails outright).

`onConflict` is populated *only* by the `INSERT OR <res>` lead-in (`parser.ts:333-339`). The two surfaces — `INSERT OR <res> INTO …` and `ON CONFLICT DO …` — are mutually exclusive in the parser (`parser.ts:418`).

## Fix

In `insertToString`, when `stmt.onConflict` is set and ≠ ABORT, emit `insert or <res>` as the lead-in (in place of `insert`) and remove the trailing `on conflict <res>` emission at line 566-568.

```ts
const parts: string[] = ['insert'];
if (stmt.onConflict && stmt.onConflict !== ConflictResolution.ABORT) {
    parts.push('or', ConflictResolution[stmt.onConflict].toLowerCase());
}
parts.push('into', …);
```

UPSERT clauses (`stmt.upsertClauses`) continue to emit as today.

## Test plan

- Drop the `Note: onConflict can't round-trip` constraint in `insertArb` in `packages/quereus/test/emit-roundtrip-property.spec.ts`; let the arbitrary set `onConflict` from `conflictResArb`.
- Add a unit test in `packages/quereus/test/emit/ast-stringify.spec.ts` for each conflict-resolution value (ROLLBACK / FAIL / IGNORE / REPLACE) — assert the post-reparse AST's `onConflict` round-trips.
- Verify the parser still rejects an INSERT that uses *both* `OR <res>` and `ON CONFLICT DO …` (existing mutual-exclusivity check).
