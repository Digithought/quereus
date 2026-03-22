description: Fixed String() on JSON objects in keys-propagation.spec.ts
files:
  packages/quereus/test/optimizer/keys-propagation.spec.ts
----
## Summary

The `keys-propagation.spec.ts` tests used `String(rows[0].props)` to serialize query plan properties, which produced `[object Object],...` for object arrays instead of valid JSON. The fix replaced these with `JSON.stringify(rows[0].props)` throughout the file.

The one remaining `String()` call (line 103, for `node_type` string arrays) is correct — `String()` on an array of strings produces a comma-joined string suitable for `.include()` checks.

## Testing

All 8 tests in the suite pass:
- Project preserves PK-based uniqueness
- Join combines keys for inner join (conservative)
- Composite PK join preserves left keys when right PK covered
- Distinct declares all-columns key
- GROUP BY declares group key
- Physical hash join node has key-driven estimatedRows
- Unique constraint columns create additional keys in RelationType
- DISTINCT elimination when source has unique keys
