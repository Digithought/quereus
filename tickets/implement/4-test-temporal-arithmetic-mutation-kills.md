---
description: Raise mutation and branch coverage on temporal arithmetic paths in runtime/emit — `temporal-arithmetic.ts` (87.19% lines / 86.71% branches) and the temporal dispatch branches in `binary.ts` (68.15% mutation score). Flagged as next step in `docs/zero-bug-plan.md` §6.
dependencies: Stryker infrastructure
files:
  packages/quereus/src/runtime/emit/binary.ts
  packages/quereus/src/runtime/emit/temporal-arithmetic.ts
  packages/quereus/src/types/temporal-types.ts
  packages/quereus/test/logic/107-temporal-arithmetic-mutation-kills.sqllogic
  packages/quereus/test/runtime/temporal-arithmetic.spec.ts
  packages/quereus/docs/zero-bug-plan.md
  packages/quereus/docs/types.md
---

## Context

Temporal arithmetic in Quereus covers date/time/timestamp + interval/timespan combinations. `binary.ts` dispatches to `tryTemporalArithmetic` and `tryTemporalComparison` for any operator that receives a temporal value; both of those helpers plus the dispatch branches in `binary.ts` are under-covered:

| File | Lines | Branches | Mutation |
|---|---|---|---|
| `temporal-arithmetic.ts` | 87.19% | 86.71% | — |
| `binary.ts` | — | — | 68.15% |
| `temporal-types.ts` | 81.88% | 71.01% | — |

`binary.ts:122-171` has three distinct code paths (specialized temporal, numeric-only fast path, generic path) that each call into `tryTemporalArithmetic` with different precondition setups. Mutants that flip the order of the temporal check, skip the check, or return the wrong value will silently produce numeric coercions of a temporal, which looks plausible but is wrong.

## Scope

Target the following branches specifically:

### `temporal-arithmetic.ts`
- `tryTemporalArithmetic` (line 143) — every `+` / `-` combination of: date+interval, timestamp+interval, time+interval, interval+date, interval-interval, date-date, timestamp-timestamp, time-time
- `tryTemporalComparison` (line 377) — every operator on timespan×timespan, and the early-return when either side isn't a timespan
- Month-arithmetic rollover (e.g. `2024-01-31 + 1 month` → `2024-02-29`, `2024-02-29 + 1 year` → `2025-02-28`)
- Negative intervals on each operand type
- Mixed-sign intervals (`P1Y-1M`) — decide expected behavior; test or document
- DST/timezone handling on timestamp arithmetic (if the runtime has timezone awareness — check `temporal-types.ts` first)

### `binary.ts` temporal dispatch
- Line 122-127 specialized path triggered
- Line 167-171 generic path triggered
- Line 292-305 comparison dispatch with mixed-temporal-type operands (should return `undefined` and fall through to coercion)
- Cases where one operand is NULL — temporal check must not mask the NULL

### `temporal-types.ts` branches (81.88%)
- `TIMESPAN_TYPE.compare` corner cases: zero-length, negative, differing unit representations of equal durations (`PT60M` vs `PT1H`)

## Test strategy

**Unit tests** (`test/runtime/temporal-arithmetic.spec.ts`, new): direct calls to `tryTemporalArithmetic` / `tryTemporalComparison` with well-formed values, asserting exact result values and types. This is the densest way to kill value-mutating mutants.

**SQL logic tests** (`test/logic/107-temporal-arithmetic-mutation-kills.sqllogic`, new): end-to-end queries exercising `date + interval`, `timestamp - date`, `time + interval`, comparison in WHERE and ORDER BY, aggregation (`min(timestamp)`, `max(interval)`). Use hand-verified constant results in `query T` blocks.

### Expected tables (to be filled in during implementation)

For the sqllogic file, each section should have 4-8 cases covering both operator orderings and NULL propagation:

```
# Date + interval arithmetic
query T
select cast('2024-01-15' as date) + cast('P10D' as interval);
----
2024-01-25

# Timestamp - timestamp yields interval
query T
select cast('2024-01-15T12:00:00' as timestamp) - cast('2024-01-15T10:00:00' as timestamp);
----
PT2H
```

Target: raise `binary.ts` mutation score from 68.15% to ≥85% and keep `temporal-arithmetic.ts` at or above 90% lines.

## Validation loop

```bash
cd packages/quereus
yarn test
yarn mutation:subsystem emit
```

## TODO

- [ ] Audit `temporal-types.ts` to determine which temporal variants actually exist (date / time / timestamp / interval / timespan) and whether timezone arithmetic is in scope
- [ ] Create `test/runtime/temporal-arithmetic.spec.ts` — unit tests for `tryTemporalArithmetic` and `tryTemporalComparison`, one describe per operand-type combination
- [ ] Create `test/logic/107-temporal-arithmetic-mutation-kills.sqllogic` — end-to-end date/time/timestamp/interval arithmetic and comparison with hand-verified results
- [ ] Cover month-boundary rollover, leap-year `Feb 29 → Feb 28`, negative intervals, zero intervals
- [ ] Cover NULL propagation — one NULL operand anywhere must return NULL, not a coerced numeric zero
- [ ] Cover comparison of equal-duration timespans with different unit representations (`PT60M` = `PT1H`)
- [ ] Re-run `yarn mutation:subsystem emit`, record score
- [ ] Update `docs/zero-bug-plan.md` §6 table with new scores
- [ ] Cross-check `docs/types.md` temporal section against observed behavior; file a follow-up fix ticket for any divergence
