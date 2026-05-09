---
description: Honor partition collation in AsofScan's bucket key (NOCASE / RTRIM)
files:
  - packages/quereus/src/runtime/emit/asof-scan.ts
  - packages/quereus/test/logic/84-asof-scan.sqllogic
---

## Summary

`emitAsofScan` previously built right/left partition bucket keys with an
ad-hoc, BINARY-equivalent encoding (`${typeof v}:${String(v)}` joined by
spaces). That meant `'a'` and `'A'` hashed into different buckets even
when the partition column was COLLATE NOCASE — yielding wrong asof
matches whenever the partition equi-pair used a non-BINARY collation.

The fix routes both bucket-build and bucket-probe through the shared
collation-aware `serializeRowKey` helper from
`packages/quereus/src/util/key-serializer.ts` — the same one bloom join,
hash-aggregate, and window already use. The serializer's invariant
(matching the comparator-equality classes for BINARY / NOCASE / RTRIM,
verified by `test/collation-normalizer.spec.ts`) is exactly what AsofScan
needs.

## Changes

### `packages/quereus/src/runtime/emit/asof-scan.ts`
- Imported `resolveKeyNormalizer` and `serializeRowKey` from the shared
  key-serializer.
- Removed the local `buildPartitionKey` helper (and its "BINARY-only"
  caveat in the surrounding comment).
- While building `leftPartitionIndices` / `rightPartitionIndices` from
  `plan.partitionAttrs`, also build a parallel `keyNormalizers: ((s:
  string) => string)[]`, picking
  `leftAttrs[leftIdx].type.collationName ?? rightAttrs[rightIdx].type.collationName`
  per pair — mirroring `bloom-join.ts:41-42`.
- Both bucket-build (right side) and bucket-probe (left side) now call
  `serializeRowKey(row, indices, keyNormalizers)`.

The empty-partition fast path (no partition columns) still works without
a special branch: `serializeRowKey` returns `''` when given an empty
`indices` array because the loop simply doesn't run. NULL semantics are
preserved: `serializeRowKey` returns `null` when any value is NULL,
exactly matching the prior behavior (NULL partition → never matches).

### `packages/quereus/test/logic/84-asof-scan.sqllogic`
Added two new sections at the end (before the cleanup of the original
`asof_trades`/`asof_quotes`):

1. **NOCASE partition** — `asof_trades_ci`/`asof_quotes_ci` with `symbol
   TEXT COLLATE NOCASE`. Left rows use `'A'`/`'a'`/`'B'`; right rows use
   `'a'`/`'b'`. Verifies that case-different partition values still
   bucket together. Three result rows include one mixed-case match, one
   same-case match, and one case-different bucket where the temporal
   filter still rules out a match (returns null).
2. **RTRIM partition** — `asof_trades_rt`/`asof_quotes_rt` with `symbol
   TEXT COLLATE RTRIM`. Left rows use `'B '`/`'B  '` (one and two
   trailing spaces), right uses `'B'`. Verifies trailing-space
   differences collapse into the same bucket under RTRIM.

The Unicode/non-ASCII case from the original plan ticket is intentionally
deferred — NOCASE in Quereus is ASCII-only via
`String.prototype.toLowerCase`, so a "future Unicode collation" test
isn't actionable yet.

## Validation

- `yarn build` — passes.
- `yarn test` — 2647 passing in the quereus suite (logic + plan +
  optimizer etc.); other workspace suites pass.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).

## Review focus

- Confirm `keyNormalizers` resolution mirrors bloom-join: left collation
  preferred, fall back to right (matches the existing
  `matchCollationName` resolution at line 50 of asof-scan.ts).
- Confirm `serializeRowKey('', [], [])` short-circuits correctly for the
  no-partition single-bucket path — by inspection of
  `key-serializer.ts:111-125`, the loop is bypassed when `indices.length
  === 0` and an empty string is returned. Existing unpartitioned tests in
  84-asof-scan.sqllogic continue to pass, which would not be true if
  this path regressed.
- New test sections cover NOCASE and RTRIM. Optional follow-up: a
  multi-column-partition test mixing BINARY + NOCASE columns to exercise
  per-pair normalizer selection (not added — current single-column tests
  are sufficient and the per-pair plumbing is the same as bloom-join's,
  which already has multi-column coverage).
