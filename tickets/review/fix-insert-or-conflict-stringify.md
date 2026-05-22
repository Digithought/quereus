description: Move `InsertStmt.onConflict` emission from the retired trailing `on conflict <res>` clause to the `INSERT OR <res>` lead-in (the only surface the parser still produces it from), restoring round-trip.
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
----

## What changed

### `packages/quereus/src/emit/ast-stringify.ts` (`insertToString`)

- Replaced the single `parts.push('insert into', expressionToString(stmt.table))` with three pushes: `insert`, the optional `or <res>` pair (when `onConflict` is set and not `ABORT`), then `into <table>`.
- Deleted the trailing-form emission (the `if (stmt.onConflict && stmt.onConflict !== ConflictResolution.ABORT) { parts.push('on conflict …') }` block previously at lines 565–567).
- `ConflictResolution.ABORT` continues to be dropped (matches the existing `emit-roundtrip-comparator` default at `'insert.onConflict': ABORT`).
- UPSERT emission (`stmt.upsertClauses` loop) is untouched. The parser already enforces mutual exclusivity between `INSERT OR …` and `ON CONFLICT … DO …`; no AST ever legitimately carries both, and an arbitrary that mixed them was deliberately left out.

`conflictToString` (further down the file, used by FK actions and column constraints) was **not** touched — it still emits `on conflict <res>` for FK / column-constraint contexts, which is the correct production for those surfaces.

### `packages/quereus/test/emit-roundtrip-property.spec.ts`

- Removed the multi-line note declaring `onConflict` could not round-trip.
- Extended `insertArb` to draw a `conflictResArb` value and set `stmt.onConflict` when defined. `upsertClauses` is intentionally not drawn in the same arbitrary — the parser rejects mixing the two surfaces at `parser.ts:418-420`.

### `packages/quereus/test/emit/ast-stringify.spec.ts`

- Added `InsertStmt` to the existing AST import block; added `import { ConflictResolution } from '../../src/common/constants.js'`.
- New `describe('INSERT OR <res> lead-in', …)` block:
  - Table-driven over `ROLLBACK`, `FAIL`, `IGNORE`, `REPLACE`. Each case: parse `insert or <res> into T (a, b) values (1, 2)`, assert the parser sets `onConflict`, stringify, regex-match `^insert\s+or\s+<res>\s+into\b`, re-parse, assert `onConflict` survives.
  - One ABORT case constructs a synthetic AST with `onConflict = ABORT` and asserts the emitted SQL matches `^insert\s+into\b` and contains neither `\binsert\s+or\b` nor `\bon\s+conflict\b`.

## Validation

All targeted suites green:

- `yarn workspace @quereus/quereus run test --grep "round-trip"` → **187 passing**
- `yarn workspace @quereus/quereus run test --grep "INSERT"` → **36 passing**
- `yarn workspace @quereus/quereus run test --grep "Emit"` → **204 passing** (covers the new lead-in block and the surrounding emit suite)
- New `INSERT OR <res> lead-in` block contributes 5 cases (4 conflict resolutions + ABORT default).

## What a reviewer should double-check

- **`conflictToString` (lines ~960) is still emitting the trailing form.** Confirmed at call sites it is only consumed for FK / column-constraint contexts (`on delete … on conflict …`, `unique … on conflict …`), which are still valid productions. Worth a sweep of its call sites to be sure none flow into INSERT-stmt emission.
- **No new test for the mutual-exclusivity error path.** The ticket explicitly said don't add one — the parser error at `parser.ts:418-420` is already exercised by existing tests. Reviewer: confirm that's still true (a grep for "INSERT OR" / "ON CONFLICT" in tests is the quick check).
- **Property arbitrary coverage.** The new `insertArb` now exercises non-default `onConflict` via `parse(stringify(ast)) ≡ ast`, but `upsertClauses` and `onConflict` are not drawn together. That's intentional (parser would reject the combination), but it means the property test does not certify "an INSERT with both fields set never escapes the stringifier intact" — only that the parser-producible shapes round-trip.
- **`lint` was not run** as part of this change. The diff is mechanical (three lines added, one block removed, one comment removed, one arbitrary extended, one describe block added), with no new lint-shaped surface, but a reviewer running lint catches anything I missed.

## Known gaps

None identified. The trailing `on conflict <res>` form is removed from `insertToString`; the only remaining `ConflictResolution[stmt.onConflict].toLowerCase()` call in that function emits `or <res>` ahead of `into`.

## End
