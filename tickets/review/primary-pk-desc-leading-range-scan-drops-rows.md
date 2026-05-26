---
description: Review — primary-BTree range scan on a DESC-leading composite PRIMARY KEY no longer drops rows; secondary-branch isDescFirstColumn handling ported into the primary branch of scanLayer
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
---

## What changed

A leading-column range scan over a composite PRIMARY KEY whose leading column is
declared `DESC` previously returned **zero** rows (`SELECT a FROM td WHERE a >= 15`
over `PRIMARY KEY (a DESC, b)` → `[]` instead of `[{"a":20},{"a":30}]`). The
primary branch of `scanLayer` built its seek key only from `plan.lowerBound` and
iterated forward, so the DESC-aware comparator positioned the seek *past* the
matching rows (which sit at the front of the physical descending order) and the
scan yielded nothing.

The fix ports the secondary-index branch's `isDescFirstColumn` handling into the
primary branch (`scan-layer.ts`, the `if (plan.indexName === 'primary')` block):

1. **Direction detection** — `isDescFirstColumn = schema.primaryKeyDefinition?.[0]?.desc === true`.
   The all-columns fallback definition (used when no PK is declared) carries no
   `desc`, so the `?.` chain yields `false` there, which is correct.
2. **Direction-aware seek start** — for a DESC leading column the scan seeks from
   `plan.upperBound` (wrapped in a single-element array for composite PKs to match
   the comparator's prefix handling), or tree start when there's no upper bound.
   ASC-leading keeps the existing lower-bound wrap unchanged.
3. **Direction-aware early termination** — the old `!plan.descending && upperBound`
   early-exit was generalized into an `isAscending` block that mirrors the
   secondary branch exactly: DESC-leading breaks once the leading column drops
   below the lower bound; ASC-leading breaks once it passes the upper bound. The
   `equalityPrefix` prefix-mismatch break is preserved ahead of the bound checks.

The new logic is gated on `isAscending = !plan.descending`, matching the secondary
branch convention. The ASC-leading composite path and the lower-bound array wrap
(from the prior `composite-pk-range-scan-drops-rows` ticket) are untouched.

## How to validate

- `cd packages/quereus && yarn test` (or target the file: from repo root,
  `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "05.1-composite"`).
- `yarn lint` (from `packages/quereus`).

Both were run green at handoff (3584 passing / 9 pending across the suite; lint
exit 0).

## Test coverage added (`05.1-composite-pk-range-scan.sqllogic`)

A new DESC-leading PRIMARY KEY section, all asserting against `td (a INTEGER,
b INTEGER, v TEXT, PRIMARY KEY (a DESC, b))` with rows (10,20,30):

- The reported repro: `a >= 15 ORDER BY a` → `[{"a":20},{"a":30}]`.
- Inclusive lower bound on an exact key (`a >= 20`), exclusive (`a > 20`).
- Leading-column range `a >= 15 AND a < 30 ORDER BY a` → `[{"a":20}]`.
- Descending output: `a >= 15 ORDER BY a DESC` and `a >= 15 AND a < 30 ORDER BY a DESC`
  (exercises the `plan.descending` interaction).
- Three-column PK `(a DESC, b, c)` with a leading-column range and a `count(*)`.

## Reviewer notes / known gaps (treat tests as a floor)

- **`plan.descending=true` + upper bound was a specific worry.** During implement
  I reasoned that seeking from the upper bound while walking the tree *backward*
  could mis-start the scan. The added `ORDER BY a DESC` + range test passes, which
  means the optimizer produces a **forward** physical scan (`descending=false`)
  for `ORDER BY a DESC` over a DESC-leading PK, so the problematic combination is
  not actually generated for these queries. It is **not proven unreachable** — if
  a query path ever produces `descending=true` together with a leading-column
  upper bound on a DESC-leading PK, the seek-from-upper + backward-walk would
  start at the wrong end and could drop rows. Worth an adversarial probe (e.g.
  forcing `descending` via a plan that can't reorder, or a secondary DESC index
  with `ORDER BY ... ` that yields a backward physical scan with an upper bound).
  The secondary branch shares this exact shape and is likewise only covered for
  the ascending, no-upper-bound case.
- **Output ordering relies on explicit `ORDER BY`** in the tests for determinism.
  The natural (no-ORDER-BY) scan order for a DESC-leading PK forward scan is
  descending; I did not assert on un-ordered output.
- **No store-mode run.** Only `yarn test` (memory vtab) was exercised. This is a
  memory-module scan-layer change; `yarn test:store` was not run.
- Single-element-array wrap of the upper bound for composite PKs mirrors the
  existing lower-bound wrap; reviewer should confirm the comparator's
  short-key/prefix branch (`primary-key.ts` L123-126, `arrA.length - arrB.length`)
  positions `[upper]` correctly relative to full `[upper, b]` keys for `<` vs `<=`
  (the `a >= 15 AND a < 30` and `count(*)` tests cover the inclusive/exclusive
  boundary, but only for integer leading columns).
