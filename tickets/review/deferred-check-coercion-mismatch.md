description: Review fix coercing NEW.* values to column logical types before queueing deferred CHECK rows (GitHub #25)
files: packages/quereus/src/runtime/emit/constraint-check.ts, packages/quereus/test/logic/43-transition-constraints.sqllogic
----
GitHub issue: https://github.com/gotchoices/quereus/issues/25

## What was done

Deferred CHECK constraints that compare `new.*` against rows stored in other
tables were failing for logical types that rewrite values on parse (e.g.
`datetime`). The stored rows are coerced on insert, but the `new.*` values
snapshotted for deferred evaluation were raw, so equality (`P.TS = new.ParentTS`)
spuriously failed at COMMIT.

### Fix (`emit/constraint-check.ts`)

- Added a small helper `coerceNewSection(row, tableSchema)` (placed just above
  `generateDefaultConstraintName`). It clones the flat OLD/NEW row and coerces
  only the NEW section (indices `n..2n-1`) via
  `validateAndParse(value, column.logicalType, column.name)`.
- Per-cell parse failures are caught and fall back to the raw value, so the
  authoritative MISMATCH error still surfaces from the row's own
  `performInsert` downstream — error layer/message/timing unchanged for genuinely
  invalid rows.
- The deferred queue call site (`checkCheckConstraints`) now passes
  `coerceNewSection(row, tableSchema)` instead of `row.slice()`. The live `row`
  flowing down the pipeline is untouched (helper builds a fresh array).
- Imported `validateAndParse` from `../../types/validation.js`.

OLD values (`0..n-1`) are intentionally left raw: NULL on INSERT, or read from
already-coerced stored rows on UPDATE. `committed.*` is fetched via subquery from
stored (coerced) data, so coercing NEW alone also fixes transition constraints.

### Regression tests (`test/logic/43-transition-constraints.sqllogic`)

Appended a new section using `USING memory`:
- **Positive** (the validated #25 repro): `Parent(Id TEXT, TS datetime, PK(Id,TS))`
  inserted via numeric literal `1700000000000`; `Child` with deferred `exists`
  CHECK against `Parent.TS` succeeds at COMMIT.
- **Negative**: a Child whose `ParentTS` (`1800000000000`) has no matching Parent
  still fails (`-- error: CHECK constraint failed: ParentExists`), proving the
  fix didn't make the check vacuously pass. Verified the failed row didn't land.
- **Alternate textual representation**: `'2023-11-14T22:13:20+00:00[UTC]'` on both
  sides to lock in coerced-vs-coerced equality.

## Validation performed

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — 3642 passing, 9 pending, exit 0.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).

## Known gaps / things for the reviewer to probe

- **contextRow coercion deliberately out of scope** (per ticket). Mutation
  `contextRow` values are evaluated expressions not necessarily typed against
  this table's columns, and the repro doesn't implicate them. If a follow-up need
  surfaces, file a separate ticket — do not widen here.
- **Store path not run.** Only the memory-backed `yarn test` was run. The store
  path shares coercion semantics via `coerceRow`, so behavior should match, but
  `yarn test:store` was not executed (slower; not agent-runnable by default).
  Reviewer may spot-check if concerned.
- **Fallback-on-throw masking.** The try/catch keeps the raw value on any
  `validateAndParse` throw. This is intentional to preserve error semantics, but
  worth confirming it doesn't hide a case where a deferred check *should* see a
  coerced value that legitimately fails parse (the row would also fail its own
  performInsert, so net behavior is unchanged — confirm this reasoning holds).
- The alternate-textual test relies on `1700000000000` ms and
  `'2023-11-14T22:13:20+00:00[UTC]'` being the same instant; both Parent rows
  (`p1`, `p2`) thus carry the same coerced TS but distinct Ids (no PK conflict).
