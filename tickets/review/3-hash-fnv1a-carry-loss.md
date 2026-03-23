description: Review FNV-1a carry loss fix in hash.ts
dependencies: none
files:
  packages/quereus/src/util/hash.ts
  packages/quereus/test/util/hash.spec.ts
----

## Summary

Fixed carry loss in `fnv1aHash` 64-bit multiplication. The `>>> 0` truncation on line 31
destroyed the full product before the carry could be extracted on line 32, producing
`hashLow / 0x100000000 → 0` every time. Same bug in the second multiplication block
(multi-byte character path).

## Fix applied

In both multiplication blocks, save the full (untruncated) product in a temp variable
before truncating, then extract the carry from the full product via `Math.floor(full / 0x100000000)`.

## Testing

- Existing reproducing test ("should correctly propagate carry from low-word multiplication") now passes
- All 33 hash-related tests pass
- Full test suite: 298 passing, 1 pre-existing failure (bigint-mixed-arithmetic, unrelated)
- Type-check clean

## Use cases for validation

- Verify hash output changes are acceptable (schema hashes are not persisted, only used at runtime for `EXPLAIN SCHEMA`)
- Confirm distribution test still shows good spread
- Confirm Unicode/multi-byte path also benefits from the fix (block 2)
