description: Fix APPLY SCHEMA seed data to handle boolean and Uint8Array values
dependencies: none
files:
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
----

## Summary

Fixed `emitApplySchema` seed data value interpolation which silently mapped `boolean` and `Uint8Array` values to `'NULL'` via the fallthrough default case.

## Changes

**schema-declarative.ts (lines 14-21, 157-163):**
- Added `uint8ArrayToHex()` cross-platform helper (no Node `Buffer` dependency)
- Added `typeof v === 'boolean' ? (v ? '1' : '0')` branch — booleans map to SQL integers
- Added `v instanceof Uint8Array ? X'${uint8ArrayToHex(v)}'` branch — blobs map to hex literals

## Testing

**50-declarative-schema.sqllogic Step 53:**
- Declares schema with `true`/`false` boolean and `X'cafebabe'`/`X'deadbeef'` blob seed values
- Verifies booleans are stored as 1/0 integers (not NULL)
- Verifies blobs are preserved with correct type (`blob`) and length (4 bytes each)

## Validation
- Build passes
- 329 tests passing, 1 pre-existing failure (unrelated DDL lifecycle/alterTable reuse bug in 10.1-ddl-lifecycle.sqllogic:248)
