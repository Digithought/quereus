description: Fix APPLY SCHEMA seed data to handle boolean and Uint8Array values
dependencies: none
files:
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## Bug

In `emitApplySchema`, the seed data value interpolation (line ~157) mapped `boolean` and `Uint8Array` to `'NULL'` via the fallthrough case. These are valid `SqlValue` types that were silently discarded.

## Fix Applied

**schema-declarative.ts:**
- Added `typeof v === 'boolean' ? (v ? '1' : '0')` branch for boolean → integer mapping
- Added `v instanceof Uint8Array ? X'${uint8ArrayToHex(v)}'` branch for blob → hex literal mapping
- Added cross-platform `uint8ArrayToHex()` helper (no Node `Buffer` dependency)

**50-declarative-schema.sqllogic (Step 53):**
- New test declares a schema with boolean (`true`/`false`) and blob (`X'cafebabe'`/`X'deadbeef'`) seed values
- Verifies booleans map to 1/0 integers (not NULL)
- Verifies blobs are preserved with correct type and length (not NULL)

## TODO
- [x] Add boolean → 0/1 mapping in seed data interpolation
- [x] Add Uint8Array → hex literal mapping (cross-platform)
- [x] Add test case with boolean and blob seed data
- [x] Build passes
- [x] Tests pass (182 passing, 1 pre-existing failure in unrelated alterTable test)
