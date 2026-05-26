---
description: Review fix for memory-table composite-PK / multi-column-secondary-index leading-column range scan dropping all but the last matching row
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/utils/primary-key.ts, packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
---

## What was wrong

A range scan over a **composite** primary key (or multi-column secondary
index) constrained only on its **leading column** (`a >= ?`, `a > ?`,
`a >= ? and a < ?`) returned only the **last** matching row in key order.

Root cause: the BTree stores composite keys as arrays (`[a, b]`), but the
lower-bound seek `startKey` was built from the bare **scalar** leading value.
The composite comparator (`createCompositeColumnPrimaryKeyFunctions.compare`,
primary-key.ts L119-137) reads `arrA.length` / `arrA[i]`; given a scalar, both
are `undefined`, so the seek landed past nearly all rows and the ascending
scan yielded only the final one. Upper-bound-only scans were correct (no seek
start key) and single-column keys were correct (comparator compares scalars).

## The fix

`packages/quereus/src/vtab/memory/layer/scan-layer.ts`, both range branches:
wrap the scalar lower bound in a single-element array **only when the key is
composite**, so the comparator's existing prefix handling (L124-126 positions
a shorter key before all full keys sharing that prefix) seeks correctly.

- Primary branch (~L63): composite test is
  `(schema.primaryKeyDefinition?.length ?? schema.columns.length) > 1` —
  the `?? columns.length` handles the all-columns-PK fallback where
  `primaryKeyDefinition` is `undefined`.
- Secondary branch (~L130): composite test is
  `(indexDef?.columns.length ?? 1) > 1` (`indexDef` resolved at ~L116;
  guarded for `undefined`).

Single-column keys stay on the scalar path. The `equalityPrefix` branch
already relied on this prefix-seek behavior; the lower-bound-only branch
simply had not.

## Validation performed

- `yarn workspace @quereus/quereus test` → **3584 passing, 0 failing**, 9
  pending. Includes the previously-RED reproduction
  `test/logic/05.1-composite-pk-range-scan.sqllogic` (composite `>=`/`>`/
  `>= … <` for 2- and 3-column PKs, single-column PK control, upper-bound-only
  control, and multi-column secondary-index leading-column range). No
  regressions in 05-vtab_memory / 02-filters / 04-order-by.
- `yarn workspace @quereus/quereus lint` → exit 0, clean.
- **Secondary path is discriminating, not just covered by reasoning.** Dumped
  the plan for `select id from idx_t where k >= 15 order by k` (composite index
  `idx_kn (k, name)`) via `query_plan(...)`: the chosen access path is
  `INDEXSEEK ... USING idx_kn` (not a full primary scan + filter), so the
  secondary-branch edit is genuinely exercised by the test rows.

## Things a reviewer should double-check

- **`equalityPrefix` + `lowerBound` interaction**: the composite wrap only
  applies in the `else if (plan.lowerBound)` branch, which is *not* taken when
  `equalityPrefix` is set (that branch already builds an array and appends the
  bound). Confirm no plan shape sets both in a way that bypasses the new wrap.
- **DESC composite leading column**: the new test uses ASC keys only. A
  composite PK / index whose leading column is `desc` takes a different
  early-termination path (primary branch has no `isDescFirstColumn` handling;
  secondary branch does at L125-128 keyed on `upperBound`). The lower-bound
  wrap still applies, but a DESC-leading composite range scan is not covered by
  a test — worth a glance or a follow-up case.
- **Descending scans** (`order by … desc`) over composite keys with a lower
  bound: not exercised by the new test. The wrap is independent of scan
  direction, but the comparator's prefix rule positions a short key *before*
  the prefix group, which is the correct seek-start for ascending; for a
  descending scan the start key semantics differ. Existing suite passes, but no
  dedicated composite-desc-lower-bound assertion exists.

## Documentation

No doc change made. `docs/optimizer.md` describes planner-level seek-key
construction (scalar parameter/correlated expressions) and access-path
selection; the array-vs-scalar shaping of memory-vtab BTree keys is an
internal implementation detail not described there, so nothing is
contradicted. Deferral is intentional, not an oversight.
