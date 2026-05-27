description: DATETIME/DATE/TIME logical-type coercion is not canonical — a value inserted as a numeric epoch and the same instant given as an ISO string coerce to different stored strings and compare unequal
files: packages/quereus/src/types/temporal-types.ts, packages/quereus/src/util/comparison.ts, packages/quereus/test/logic/43-transition-constraints.sqllogic
----
## Problem

The `DATETIME` logical type (and, by the same shape, `DATE`/`TIME`) does **not**
produce a canonical stored representation. Two inputs that denote the *same
instant* coerce to *different* strings, and because `DATETIME.compare` uses
`BINARY_COLLATION` (raw string comparison), they then compare **unequal**.

Reproduction (verified against `temporal-polyfill` as used by the engine):

```
numeric  1500000000000        → Instant.fromEpochMilliseconds(v)
                                  .toZonedDateTimeISO('UTC').toString()
                               → "2017-07-14T02:40:00+00:00[UTC]"

string   "2017-07-14T02:40:00+00:00[UTC]"
                               → PlainDateTime.from(v)  (tried FIRST, succeeds,
                                  silently dropping the offset + zone annotation)
                               → "2017-07-14T02:40:00"

"2017-07-14T02:40:00+00:00[UTC]" === "2017-07-14T02:40:00"  →  false
```

See `packages/quereus/src/types/temporal-types.ts`:
- `DATETIME_TYPE.parse` (lines ~138-161): numeric branch yields a **ZonedDateTime**
  string (`...+00:00[UTC]`); string branch tries `PlainDateTime.from` first, which
  *succeeds* for an offset/zoned string by discarding the offset and zone, yielding
  a bare **PlainDateTime** string.
- `DATETIME_TYPE.compare` (line ~163): `BINARY_COLLATION` on the raw strings, so the
  two representations above are not equal.

## Why it matters

Any comparison between a datetime column value that originated as a number and one
that originated as a string silently disagrees. This surfaces in:
- `where dt_col = '<iso string>'` against rows inserted via numeric epoch (and the
  reverse),
- joins / `in` / `exists` across datetime columns populated from mixed sources,
- CHECK / FK / deferred constraints comparing such columns (this is how it was
  found — see below).

This is a latent correctness bug independent of the deferred-CHECK coercion work.

## How it was discovered

While reviewing `deferred-check-coercion-mismatch` (GitHub #25, now complete), a
UPDATE-path regression test compared an UPDATE's textual `new.*` value against a
parent row stored from a numeric epoch. The deferred CHECK failed even though both
sides denote the same instant — not because of the deferred-queue snapshot (that
fix is correct), but because the two coerce to different strings. The review test
was narrowed to numeric-vs-numeric to stay within the scope the #25 fix actually
addresses; the cross-representation case is deliberately **not** asserted there and
is tracked by this ticket. The existing "alternate textual representation" case in
`43-transition-constraints.sqllogic` only passes because a textual-stored parent
(`p2`) sits at the same instant, so it never exercises textual-NEW vs numeric-stored.

## Expected behavior

A datetime/date/time value should have a single canonical stored form so that
equal instants compare equal regardless of whether they were supplied as a numeric
epoch or an ISO string (with or without offset/zone). Decide and document the
canonical form, e.g.:
- normalize all `DATETIME` inputs to a single representation (UTC `Instant` /
  `ZonedDateTime[UTC]`, or a bare `PlainDateTime` after offset normalization), and
- ensure `parse` of a string with an explicit offset/zone does **not** silently
  drop that information when the canonical form is zone-aware (today `PlainDateTime.from`
  is tried before `ZonedDateTime.from`, which is the trap).

Confirm `compare` then agrees with `parse`'s canonical form (binary collation is
fine once the representation is canonical, but a semantic instant comparison may be
preferable — evaluate the trade-off for naive vs zoned datetimes).

## Acceptance / regression coverage

- Add sqllogic cases that insert a datetime column from a numeric epoch and query /
  constrain it with the equivalent ISO string (and vice versa), asserting equality.
- Re-enable a textual-NEW-vs-numeric-stored case in
  `43-transition-constraints.sqllogic` (currently numeric-vs-numeric only).
- Cover `DATE` and `TIME` analogously if they share the non-canonical shape.
- Decide semantics for offset/zoned vs naive datetime equality and document in
  `docs/types.md`.
