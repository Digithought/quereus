description: Make DATETIME/DATE/TIME coercion canonical so equal instants compare equal regardless of input shape (numeric epoch, bare ISO, ISO with Z, offset, or [zone] annotation)
files: packages/quereus/src/types/temporal-types.ts, packages/quereus/test/logic/43-transition-constraints.sqllogic, packages/quereus/test/logic/98-temporal-edge-cases.sqllogic, docs/types.md, docs/datetime.md
----

## Summary

Reworked the column-type `parse`/`validate` cascades for the three textual
temporal types (`DATE`, `TIME`, `DATETIME`) so that equal instants
canonicalize to identical stored strings regardless of input shape. The fix
removes a silent zone-drop and a `Z`-suffix parse failure that together made
cross-representation equality (`numeric epoch = textual ISO`) impossible.

## Canonical form (decision)

- **DATETIME**: bare PlainDateTime in UTC, e.g. `"2017-07-14T02:40:00"` —
  matches what `docs/types.md` already documented and what `bucketBounds`
  already assumes (line 195 of `temporal-types.ts`).
- **DATE**: unchanged (`"YYYY-MM-DD"`), but `parse` now also accepts
  `Z`-suffixed / offset / zoned ISO datetime strings, converting them to UTC
  before extracting the date.
- **TIME**: unchanged (`"HH:MM:SS[.sss]"`), but `parse` now also accepts the
  same broader set of inputs, converting to UTC time.

Comparison stays on `BINARY_COLLATION`: with all values in the same canonical
zone (UTC), lexicographic == instant-order.

## Implementation

`packages/quereus/src/types/temporal-types.ts`:

- New private helper `parseDateTimeStringToUtcPlain(v: string)` that tries
  `ZonedDateTime.from` → `Instant.from` (`Z`/offset path, converted to UTC) →
  `PlainDateTime.from` (bare wall-clock).
- `DATETIME_TYPE.parse` now routes both the string branch and the numeric
  branch through this helper / through `Instant.fromEpochMilliseconds` and
  emits the **bare** PlainDateTime form. The number branch previously emitted
  `"...+00:00[UTC]"` (ZonedDateTime form) — that is the headline change.
- `DATETIME_TYPE.validate` mirrors the cascade so `Z`-suffixed strings are
  accepted, not rejected.
- `DATE_TYPE.parse` / `validate` add a fallback through
  `parseDateTimeStringToUtcPlain` so a `Z`/offset/zoned datetime string
  degrades to its UTC date instead of throwing.
- `TIME_TYPE.parse` / `validate` add the same fallback for UTC time.

## Tests

### Modified

`packages/quereus/test/logic/43-transition-constraints.sqllogic`
(GitHub #25 section, ~lines 295-330):

- Replaced the `[UTC]`-shaped literals in the `p2`/`c3` rows with
  `'2023-11-14T22:13:20Z'` so the test exercises canonicalization rather than
  relying on the silent-drop bug to make both sides match.
- Re-introduced the textual-NEW-vs-numeric-stored UPDATE case that
  `deferred-check-coercion-mismatch` deliberately omitted: `p4` parent stored
  via `1600000000000` ms epoch, then `UPDATE Child SET ParentTS =
  '2020-09-13T12:26:40Z' WHERE Id = 'c3';` succeeds because both sides
  canonicalize to `'2020-09-13T12:26:40'`.

### Added

`packages/quereus/test/logic/98-temporal-edge-cases.sqllogic`, three new
sections at the bottom of the file:

- `DATETIME: cross-representation canonicalization` — six rows
  (numeric epoch, bare ISO, `Z`, `+00:00`, `+00:00[UTC]`, `+02:00`) all
  representing the same instant; asserts `count(distinct ts) = 1` and that
  all six equal the canonical `'2017-07-14T02:40:00'`.
- `DATE: Z-suffix / offset / zoned / numeric → canonical date` — five rows
  collapsing to `'2024-01-15'`.
- `TIME: Z-suffix / ISO datetime degrade to canonical UTC time` — four rows
  collapsing to `'10:30:00'`.

## Docs

- `docs/types.md` — DATETIME entry now explicitly documents UTC
  canonicalization for inputs with offsets / `Z` / zone annotations.
- `docs/datetime.md` — appended a paragraph to "Input Parsing" clarifying
  that column-type `parse` canonicalizes, separate from the lenient
  SQL-function parsing above it.

## Validation

- `yarn workspace @quereus/quereus test` → 3642 passing, 9 pending, 0 failing.
- `yarn workspace @quereus/quereus lint` → clean (exit 0).
- Did not run `yarn test:store` per AGENTS.md guidance (default `yarn test` is
  the agent default; `test:store` is for store-specific issues / releases).

## Known gaps / follow-ups for review

- **Lenient SQL functions unchanged.** `datetime()`, `date()`, `time()`,
  `datetime('now')`, `strftime`, etc. in `packages/quereus/src/func/builtins/datetime.ts`
  still return their existing formats (e.g. `datetime('now')` calls
  `new Date().toISOString()` and returns the `Z`-suffixed string verbatim
  before any canonicalization). The ticket scoped this explicitly to
  column-type `parse`; if a `datetime('now')` result is inserted into a
  DATETIME column it *will* canonicalize via the column type. Worth
  reconsidering whether the function-level outputs should also align, but
  out of scope here.
- **Old persisted values.** A LevelDB-backed database written before this
  change may contain rows in the old `"...+00:00[UTC]"` shape. Per project
  policy ("Don't worry about backwards compatibility yet") there is no
  migration shim. In-memory vtab tests are moot.
- **`Temporal.PlainDateTime.from('2024-01-15')` behavior.** The polyfill
  accepts a date-only string and defaults time to `00:00:00`. That means
  `TIME_TYPE.parse('2024-01-15')` (previously: throws) now returns
  `'00:00:00'`. I did **not** add an explicit guard against this because
  the ticket's cascade is "PlainTime first, fall through to PlainDateTime",
  and the resulting value is internally consistent (extracting the time
  component of midnight UTC). Flagging in case the reviewer wants stricter
  semantics.
- **No unit tests for `parseDateTimeStringToUtcPlain` in isolation.** Coverage
  is via the new sqllogic cross-representation rows. The reviewer may want
  a small TS-level test exercising malformed-but-tricky inputs (e.g. mixed
  offset + `[zone]`, `'now'`, the 'YYYYMMDD' compact form) to lock the
  cascade order — none of those flow through the column type today, so I
  left it.
- **`Z`-suffix branch via `Instant.from` discards sub-millisecond precision
  if any input ever carries it.** Not exercised by any test, but worth a
  glance.

## Test plan for reviewer

1. Run `yarn workspace @quereus/quereus test` and confirm green.
2. Re-read `parseDateTimeStringToUtcPlain` and the cascade order — the only
   non-obvious bit is "ZonedDateTime first because it requires `[zone]`".
3. Verify the new sqllogic sections in `98-temporal-edge-cases.sqllogic`
   actually exercise every shape from the ticket's table.
4. Spot-check `43-transition-constraints.sqllogic` for the re-introduced
   textual-NEW-vs-numeric-stored UPDATE case (`'c3'` + `'p4'`).
5. Consider whether the lenient SQL functions in
   `packages/quereus/src/func/builtins/datetime.ts` need a follow-up — if
   yes, file a `fix/` or `plan/` ticket; do not chase inside this review.
