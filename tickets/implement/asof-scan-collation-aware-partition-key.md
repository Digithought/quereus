---
description: Honor partition collation in AsofScan's bucket key (NOCASE / RTRIM)
files:
  - packages/quereus/src/runtime/emit/asof-scan.ts
  - packages/quereus/src/util/key-serializer.ts
  - packages/quereus/test/logic/84-asof-scan.sqllogic
---

## Problem

`emitAsofScan` (packages/quereus/src/runtime/emit/asof-scan.ts) builds the
right-side partition bucket key with an ad-hoc, BINARY-equivalent encoding:

```ts
function buildPartitionKey(row: Row, indices: number[]): string | null {
    if (indices.length === 0) return '';
    const parts: string[] = [];
    for (const idx of indices) {
        const v = row[idx];
        if (v === null || v === undefined) return null;
        parts.push(`${typeof v}:${String(v)}`);
    }
    return parts.join(' ');
}
```

So `'a'` and `'A'` hash into different buckets even when the partition
column is COLLATE NOCASE — yielding wrong asof matches whenever the
partition equi-pair uses a non-BINARY collation.

## Fix

Reuse the existing collation-aware key serializer that bloom join,
hash-aggregate, and window already use. The serializer's invariant
(matching the comparator-equality classes for BINARY / NOCASE / RTRIM,
verified by `test/collation-normalizer.spec.ts`) is exactly what we need.

Reference patterns:
- `packages/quereus/src/runtime/emit/bloom-join.ts` (lines 21–43): pre-resolves
  per-equi-pair `keyNormalizers` from `leftAttrs[li].type.collationName ||
  rightAttrs[ri].type.collationName`, then keys the hash bucket via
  `serializeRowKey(row, indices, keyNormalizers)`.
- `packages/quereus/src/util/key-serializer.ts`: exports `resolveKeyNormalizer`
  and `serializeRowKey`.

Apply the same shape inside `emitAsofScan`:

1. While building `leftPartitionIndices` / `rightPartitionIndices` from
   `plan.partitionAttrs`, also push a normalizer per pair, picking up
   `leftAttrs[li].type.collationName ?? rightAttrs[ri].type.collationName`
   (mirroring how the match-attr collation is already resolved a few lines
   up at line 68).
2. Delete the local `buildPartitionKey` function.
3. Both bucket-build (right side) and bucket-probe (left side) call sites
   switch to `serializeRowKey(row, leftPartitionIndices /* or right */,
   keyNormalizers)`.
4. The "no partition columns" fast path: `serializeRowKey` returns `''`
   when given an empty `indices` array (the loop simply doesn't run), so
   the empty-partition single-bucket case still works without a special
   branch — verify by inspection.
5. NULL semantics are preserved: `serializeRowKey` returns `null` when any
   value is NULL, exactly matching the current behavior (NULL partition
   value → never matches).

Imports to add at the top of `asof-scan.ts`:

```ts
import { resolveKeyNormalizer, serializeRowKey } from '../../util/key-serializer.js';
```

`Row` and the existing imports stay.

## Tests

Extend `packages/quereus/test/logic/84-asof-scan.sqllogic` with a NOCASE
partition section. Place after the existing partitioned cases (around line
85, before "Restore quotes for the unpartitioned case"), or as a new
dedicated section at the end before the cleanup.

Sketch:

```sql
-- NOCASE partition: 'A' on the left must match 'a' bucket on the right.
CREATE TABLE asof_trades_ci (id INTEGER PRIMARY KEY, symbol TEXT COLLATE NOCASE, ts INTEGER);
CREATE TABLE asof_quotes_ci (ts INTEGER PRIMARY KEY, symbol TEXT COLLATE NOCASE, bid REAL);

INSERT INTO asof_trades_ci VALUES
  (1, 'A', 100),
  (2, 'a', 200),
  (3, 'B', 150);

-- Right side uses lowercase; under NOCASE these must still match.
INSERT INTO asof_quotes_ci VALUES
  (50,  'a', 1.0),
  (180, 'b', 2.0);

-- Partitioned non-strict desc: each left row should find the right
-- bucket regardless of case.
-- t.id=1 (A,100): A/a quotes ≤ 100 → 50 → 1.0
-- t.id=2 (a,200): A/a quotes ≤ 200 → 50 → 1.0
-- t.id=3 (B,150): B/b quotes ≤ 150 → none (only ts=180) → null
SELECT t.id, q.bid FROM (SELECT id, symbol, ts FROM asof_trades_ci ORDER BY ts) t LEFT JOIN LATERAL (
  SELECT bid FROM asof_quotes_ci q WHERE q.symbol = t.symbol AND q.ts <= t.ts ORDER BY q.ts DESC LIMIT 1
) q ON true ORDER BY t.id;
→ [{"id":1,"bid":1},{"id":2,"bid":1},{"id":3,"bid":null}]

DROP TABLE asof_trades_ci;
DROP TABLE asof_quotes_ci;
```

Optionally add an analogous RTRIM case (`'B '` on the left, `'B'` on the
right under COLLATE RTRIM) to exercise the second built-in normalizer.
The Unicode/non-ASCII case from the original plan ticket is deferred —
NOCASE in Quereus is ASCII-only via `String.prototype.toLowerCase`, so a
"future Unicode collation" test isn't actionable here.

Run the suite with `yarn test` (or `yarn workspace @quereus/quereus run
test:logic` if you want to scope to the logic suite).

## TODO

- Edit `packages/quereus/src/runtime/emit/asof-scan.ts`:
  - Add the `resolveKeyNormalizer` / `serializeRowKey` import.
  - Build `keyNormalizers: ((s: string) => string)[]` alongside
    `leftPartitionIndices` / `rightPartitionIndices` inside the existing
    `for (const p of plan.partitionAttrs)` loop, picking
    `leftAttrs[leftIdx].type.collationName ?? rightAttrs[rightIdx].type.collationName`.
  - Replace right-side bucket build:
    `const pk = buildPartitionKey(row, rightPartitionIndices);` →
    `const pk = serializeRowKey(row, rightPartitionIndices, keyNormalizers);`
  - Replace left-side bucket probe:
    `const pk = buildPartitionKey(leftRow, leftPartitionIndices);` →
    `const pk = serializeRowKey(leftRow, leftPartitionIndices, keyNormalizers);`
  - Remove the now-unused `buildPartitionKey` helper.
  - Update the function-level comment near line 15–22 (the "BINARY-equivalent
    encoding" caveat) to reflect that the bucket key now honors the
    partition column's collation via the shared key serializer.
- Append the NOCASE partition test cases to
  `packages/quereus/test/logic/84-asof-scan.sqllogic` (and an RTRIM case if
  cheap).
- `yarn build` and `yarn test` from the repo root; both must pass.
- Lint: `yarn workspace @quereus/quereus run lint` (single-quote globs on
  Windows per AGENTS.md).
