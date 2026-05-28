description: Make DATETIME/DATE/TIME coercion canonical so equal instants compare equal regardless of input shape (numeric epoch, bare ISO, ISO with Z, offset, or [zone] annotation)
files: packages/quereus/src/types/temporal-types.ts, packages/quereus/test/logic/43-transition-constraints.sqllogic, packages/quereus/test/logic/98-temporal-edge-cases.sqllogic, docs/types.md, docs/datetime.md
----

## Problem (recap)

`DATETIME_TYPE.parse` produces different strings for the same instant depending on
input shape, and `compare` uses `BINARY_COLLATION`, so equal instants compare
unequal. Reproduced against the bundled `temporal-polyfill`:

| input | current `parse` output |
|---|---|
| `1500000000000` (number) | `"2017-07-14T02:40:00+00:00[UTC]"` (ZonedDateTime form) |
| `"2017-07-14T02:40:00+00:00[UTC]"` | `"2017-07-14T02:40:00"` (PlainDateTime silently drops zone) |
| `"2017-07-14T02:40:00+00:00"` | `"2017-07-14T02:40:00"` (PlainDateTime silently drops offset) |
| `"2017-07-14T02:40:00Z"` | **throws** — neither PlainDateTime nor ZonedDateTime accept bare `Z` |
| `"2017-07-14T02:40:00"` | `"2017-07-14T02:40:00"` |

Three failure modes:

1. **Non-canonical storage.** Numeric and string inputs for the same instant
   coerce to different strings → fail to compare equal.
2. **Silent zone loss.** `PlainDateTime.from` is tried first and quietly drops
   offsets/zone annotations from strings, so we lose semantic information without
   warning, and disagree with the numeric path which *keeps* the zone in its output.
3. **`Z` suffix is unparseable.** The current cascade tries `PlainDateTime.from`
   then `ZonedDateTime.from`. Both reject `"...Z"` in the current polyfill (the
   right tool for a bare-Z UTC designator is `Temporal.Instant.from`).

`DATE_TYPE` and `TIME_TYPE` are partially affected: their string branch calls
`PlainDate.from` / `PlainTime.from`, which throw on `Z`-suffixed strings (verified).
Their numeric branch produces the correct shape, so cross-representation equality
mostly works *except* for `Z`-suffixed strings, which never parse at all.

## Canonical form (decision)

Pick **bare PlainDateTime, normalized to UTC** as the canonical stored form for
DATETIME:

- Storage shape: `"YYYY-MM-DDTHH:MM:SS"` or `"YYYY-MM-DDTHH:MM:SS.sss"` —
  exactly what `Temporal.PlainDateTime.toString()` produces. This matches what
  `docs/types.md` already documents ("ISO 8601 string: YYYY-MM-DDTHH:MM:SS.sss")
  and what `bucketBounds` already assumes (line 175 of `temporal-types.ts`).
- Semantics: every datetime value represents a wall-clock instant in **UTC**.
  An input with an explicit offset or `[zone]` annotation is converted to UTC
  before the zone information is discarded (no silent drop). A bare ISO string
  with no offset is treated as already-UTC wall-clock.
- BINARY_COLLATION comparison stays correct: ISO strings of equal length sort
  by instant when all values are in the same zone (UTC).

For DATE / TIME the canonical form is unchanged (`"YYYY-MM-DD"` and
`"HH:MM:SS[.sss]"`); the fix only extends what `parse` *accepts* so that a
`Z`-suffixed or offset/zoned ISO string is converted to UTC first instead of
throwing.

### Why not "preserve zone" (Option B)

The docs explicitly say DATETIME stores the PlainDateTime form, and a
columnful zone annotation produces longer, less-sortable strings that don't
match what `bucketBounds` and the existing tests assume. Zone awareness is
already available at *function* level (`datetime(...)`, `epoch_s(...)`, etc.).

## Implementation

Rewrite the temporal `parse` / `validate` cascades to try the most informative
parser first and **convert** zone-bearing inputs to UTC rather than silently
dropping them. Helper:

```ts
// Convert any string ISO datetime form to a UTC PlainDateTime (canonical).
function parseDateTimeStringToUtcPlain(v: string): Temporal.PlainDateTime {
  // ZonedDateTime first: requires explicit [zone], so unambiguous.
  try { return Temporal.ZonedDateTime.from(v).toPlainDateTime(); /* in input zone */ } catch {}
  // Instant.from: handles 'Z' suffix and bare offsets like '+00:00'.
  try { return Temporal.Instant.from(v).toZonedDateTimeISO('UTC').toPlainDateTime(); } catch {}
  // Bare PlainDateTime (no zone/offset) — assume UTC wall-clock.
  return Temporal.PlainDateTime.from(v);
}
```

Then:

- `DATETIME_TYPE.parse`:
  - string branch → `parseDateTimeStringToUtcPlain(v).toString()`.
  - number branch → `Temporal.Instant.fromEpochMilliseconds(v).toZonedDateTimeISO('UTC').toPlainDateTime().toString()`
    (note `.toPlainDateTime()` — drops the `[UTC]` suffix that the current code emits).
  - throw on other types as today.
- `DATETIME_TYPE.validate`:
  - string branch → mirror the cascade above (try all three; succeed if any
    parses). Today validate only tries PlainDateTime then ZonedDateTime, which
    rejects `Z`-suffixed strings.
- `DATE_TYPE.parse`:
  - string branch → if `PlainDate.from(v)` throws, fall back to
    `parseDateTimeStringToUtcPlain(v).toPlainDate().toString()` so that
    `"2024-01-15T10:30:00Z"` becomes `"2024-01-15"` instead of throwing.
  - `validate` mirrors.
- `TIME_TYPE.parse`:
  - string branch → if `PlainTime.from(v)` throws, fall back to
    `parseDateTimeStringToUtcPlain(v).toPlainTime().toString()` so that
    `"2024-01-15T10:30:00Z"` becomes `"10:30:00"` instead of throwing.
  - `validate` mirrors.
- Leave `compare` on BINARY_COLLATION; with canonical storage it is now correct.

Keep the error messages of the throwing path identical (callers in
`conversion.ts` wrap them in `QuereusError`).

### Backward-compat note

A column previously populated from a numeric epoch and stored under the old
shape (`"...+00:00[UTC]"`) would now stop matching freshly inserted equivalents.
Per project policy ("Don't worry about backwards compatibility yet"), no
migration shim. Anyone with persisted databases must re-parse on read; for the
in-memory vtab this is moot.

## Regression coverage

1. **New sqllogic file** (or new section in `98-temporal-edge-cases.sqllogic`):
   exercise cross-representation equality on a column.
   - Insert one row per shape — `1500000000000`, `'2017-07-14T02:40:00'`,
     `'2017-07-14T02:40:00Z'`, `'2017-07-14T02:40:00+00:00'`,
     `'2017-07-14T02:40:00+00:00[UTC]'`, `'2017-07-14T04:40:00+02:00'` —
     and assert all stored values are equal and equal to the canonical
     `'2017-07-14T02:40:00'`.
   - Same exercise on DATE (Z-suffix, offset, zoned, numeric all → `'2024-01-15'`).
   - Same exercise on TIME for the Z-suffix and ISO-with-date cases.
2. **`43-transition-constraints.sqllogic`** (lines 295-318):
   - Replace `'2023-11-14T22:13:20+00:00[UTC]'` literals with `'2023-11-14T22:13:20Z'`
     (or another non-bare form) so the test still exercises a zone-bearing
     textual input — but now it actually goes through normalization rather
     than relying on the silent-drop bug to match.
   - Re-introduce the textual-NEW-vs-numeric-stored UPDATE case that the
     `deferred-check-coercion-mismatch` ticket deliberately omitted:
     `INSERT INTO Parent VALUES ('p4', 1600000000000);` then
     `UPDATE Child SET ParentTS = '2020-09-13T12:26:40Z' WHERE Id = 'c3';`
     should now succeed (1600000000000 ms = 2020-09-13T12:26:40Z).
3. Skim `98-temporal-edge-cases.sqllogic`, `06-builtin_functions.sqllogic`,
   `16-epoch.sqllogic`, `24-builtin-branches.sqllogic`, and
   `107-temporal-arithmetic-mutation-kills.sqllogic` for any assertion that
   relied on the old numeric-→-`[UTC]` shape (none expected — only test 43
   currently references `[UTC]`, per grep). Adjust any drift.

## Docs

- `docs/types.md`: under "Temporal Types → DATETIME", add one sentence noting
  that inputs with offset / `Z` / `[zone]` are converted to UTC before being
  stored as the canonical bare-PlainDateTime form, and that comparison is
  therefore by UTC wall-clock.
- `docs/datetime.md`: under "Internal Representation → Input Parsing", add a
  short paragraph at the end clarifying the canonicalization for stored values
  (vs. lenient parsing used by the SQL functions, which keep their existing
  behavior — this ticket is only about the *column-type* `parse`).

## TODO

- Add `parseDateTimeStringToUtcPlain` helper in `temporal-types.ts`.
- Rewrite `DATETIME_TYPE.parse` and `DATETIME_TYPE.validate` to use it; fix the
  number branch to emit bare PlainDateTime.
- Add `Z`/offset/zoned fallback to `DATE_TYPE.parse` and `DATE_TYPE.validate`.
- Add `Z`/offset/zoned fallback to `TIME_TYPE.parse` and `TIME_TYPE.validate`.
- Update `43-transition-constraints.sqllogic`: replace `[UTC]` literals; add
  the textual-NEW-vs-numeric-stored UPDATE case that was previously deferred.
- Add a new sqllogic test (new file or section in
  `98-temporal-edge-cases.sqllogic`) covering cross-representation equality
  for DATETIME, DATE, and TIME.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
- Update `docs/types.md` and `docs/datetime.md` per above.
