description: FNV-1a hash loses carry from low-word multiplication, degrading hash quality
dependencies: none
files:
  packages/quereus/src/util/hash.ts
  packages/quereus/src/schema/schema-hasher.ts
  packages/quereus/test/util/hash.spec.ts
----
## Problem

In `fnv1aHash`, the 64-bit multiplication is split into 32-bit parts. When computing the
carry from the low-word multiplication, the code truncates `hashLow` before extracting
the carry:

```typescript
hashLow = (aLow * fnvPrimeLow) >>> 0;  // truncates to 32 bits — carry is lost
hashHigh = (aHigh * fnvPrimeLow + aLow * fnvPrimeHigh + (hashLow / 0x100000000)) >>> 0;
```

Since `hashLow` is already truncated to 32 bits by `>>> 0`, the expression
`hashLow / 0x100000000` is always < 1, contributing no integer carry to `hashHigh`.

The same issue occurs in the second multiplication block (for high bytes of multi-byte characters).

## Impact

- The hash is deterministic and consistent, so no correctness bugs arise.
- The high 32 bits are computed without the proper carry propagation, resulting in
  worse bit mixing than standard FNV-1a. This increases theoretical collision probability.
- Used in `schema-hasher.ts` for schema versioning — collision risk is low given
  typical schema string lengths, but the hash is not computing standard FNV-1a values.

## Fix

Save the full product before truncating to extract the carry:

```typescript
const fullLow = aLow * fnvPrimeLow;  // precise — product < 2^42 for fnvPrimeLow=0x1b3
hashLow = fullLow >>> 0;
hashHigh = (aHigh * fnvPrimeLow + aLow * fnvPrimeHigh + Math.floor(fullLow / 0x100000000)) >>> 0;
```

Apply the same pattern to the second multiplication block.

## Breaking Change Consideration

Fixing this changes the hash output for all inputs. Any stored schema hashes (e.g. in
sync metadata) would no longer match. Assess whether schema hashes are persisted before
applying the fix. If they are, a migration or dual-hash strategy may be needed.

- [ ] Determine if schema hashes are persisted anywhere
- [ ] Apply the carry fix to both multiplication blocks
- [ ] Update hash.spec.ts empty-string expected value (FNV offset basis unchanged, but verify)
- [ ] Verify existing hash tests still demonstrate good distribution
