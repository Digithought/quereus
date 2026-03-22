description: Fix FNV-1a carry loss from low-word multiplication in both blocks
dependencies: none
files:
  packages/quereus/src/util/hash.ts
  packages/quereus/test/util/hash.spec.ts
----

## Problem (confirmed)

In `fnv1aHash` (hash.ts:31-33), the 64-bit multiplication truncates `hashLow` before
extracting the carry, so `hashLow / 0x100000000` always evaluates to < 1 (zero carry).
The same bug exists in the second multiplication block (hash.ts:40-42) for multi-byte
characters.

Reproducing test added in `hash.spec.ts` ("should correctly propagate carry from
low-word multiplication") — currently fails with high-word mismatch:
  buggy:  `af63db6c8601ec8c`
  fixed:  `af63da998601ec8c`

## Breaking change assessment

Schema hashes are **not persisted**. `computeSchemaHash` / `computeShortSchemaHash`
(schema-hasher.ts) are only called at runtime for `EXPLAIN SCHEMA` output. No migration
or dual-hash strategy is needed.

## Fix

Save the full product before truncating, in both multiplication blocks:

```typescript
// Block 1 (hash.ts:31-33) — replace:
hashLow = (aLow * fnvPrimeLow) >>> 0;
hashHigh = (aHigh * fnvPrimeLow + aLow * fnvPrimeHigh + (hashLow / 0x100000000)) >>> 0;
hashLow = hashLow >>> 0;

// With:
const fullLow = aLow * fnvPrimeLow;
hashLow = fullLow >>> 0;
hashHigh = (aHigh * fnvPrimeLow + aLow * fnvPrimeHigh + Math.floor(fullLow / 0x100000000)) >>> 0;

// Block 2 (hash.ts:40-42) — same pattern:
hashLow = (bLow * fnvPrimeLow) >>> 0;
hashHigh = (bHigh * fnvPrimeLow + bLow * fnvPrimeHigh + (hashLow / 0x100000000)) >>> 0;
hashLow = hashLow >>> 0;

// With:
const fullLow2 = bLow * fnvPrimeLow;
hashLow = fullLow2 >>> 0;
hashHigh = (bHigh * fnvPrimeLow + bLow * fnvPrimeHigh + Math.floor(fullLow2 / 0x100000000)) >>> 0;
```

Precision note: `aLow * fnvPrimeLow` max product is ~`0xFFFFFFFF * 0x1B3` ≈ 1.87e12,
well within Number's 2^53 safe integer range.

## TODO

- Apply carry fix to both multiplication blocks in hash.ts
- Ensure the reproducing test passes
- Verify existing tests (distribution, consistency) still pass
- Run build and full test suite
