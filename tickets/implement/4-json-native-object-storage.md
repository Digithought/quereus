description: Native JSON type with PhysicalType.OBJECT — store JSON as JS objects, not strings
dependencies: None (builds on existing JSON_TYPE, json functions, and storage layer)
files:
  - packages/quereus/src/types/logical-type.ts (PhysicalType enum, getPhysicalType, physicalTypeName)
  - packages/quereus/src/common/types.ts (SqlValue type, isSqlValue, describeSqlValueViolation)
  - packages/quereus/src/common/json-types.ts (JSONValue type)
  - packages/quereus/src/types/json-type.ts (JSON_TYPE definition — major update)
  - packages/quereus/src/types/builtin-types.ts (reference for type patterns)
  - packages/quereus/src/types/registry.ts (already registered, no change expected)
  - packages/quereus/src/common/type-inference.ts (inferLogicalTypeFromValue, getLiteralSqlType)
  - packages/quereus/src/core/param.ts (parameter type inference — indirect via type-inference)
  - packages/quereus/src/util/comparison.ts (StorageClass, getStorageClass, compareSameType, getSqlDataTypeName)
  - packages/quereus/src/func/builtins/scalar.ts (typeof function)
  - packages/quereus/src/func/builtins/conversion.ts (json() conversion function)
  - packages/quereus/src/func/builtins/json.ts (all json_* scalar functions)
  - packages/quereus/src/func/builtins/json-helpers.ts (safeJsonParse, prepareJsonValue, etc.)
  - packages/quereus/src/func/builtins/json-tvf.ts (json_each, json_tree)
  - packages/quereus-store/src/common/serialization.ts (serializeRow/deserializeRow — add $json marker)
  - packages/quereus-store/src/common/encoding.ts (encodeValue/decodeValue — add TYPE_OBJECT)
  - docs/types.md (update JSON section from "Future" to documented)
  - docs/functions.md (update json() return type description)
----

## Overview

The JSON logical type already exists (`JSON_TYPE` in `json-type.ts`) but uses `PhysicalType.TEXT` —
JSON values are stored as serialized JSON strings. This ticket changes JSON to use a new
`PhysicalType.OBJECT` so values live as native JS objects/arrays/primitives in memory.
This eliminates repeated parse/stringify cycles when accessing JSON columns.

The serialize/deserialize hooks on `LogicalType` convert between native objects (in-memory)
and JSON strings (on-disk), keeping the storage layer format-agnostic.

## Architecture

### Physical type addition

Add `OBJECT = 6` to the `PhysicalType` enum. This represents values whose JS runtime type is
`object` (plain objects, arrays) or JSON-compatible primitives stored as their native JS type.

Extend `SqlValue` to include object:
```typescript
export type SqlValue = string | number | bigint | boolean | Uint8Array | null | JsonSqlValue;
export type JsonSqlValue = { [key: string]: JSONValue } | JSONValue[];
```

Using a named type alias (`JsonSqlValue`) rather than bare `object` gives better type narrowing
and prevents accidental use of non-JSON objects (Date, Map, etc.) as SQL values.

### JSON_TYPE changes

```typescript
export const JSON_TYPE: LogicalType = {
  name: 'JSON',
  physicalType: PhysicalType.OBJECT,

  validate: (v) => {
    if (v === null) return true;
    // Accept native objects/arrays (already parsed)
    if (typeof v === 'object' && !(v instanceof Uint8Array)) return true;
    // Accept JSON strings (for backward compat / TEXT input)
    if (typeof v === 'string') return safeJsonParse(v) !== null;
    // Accept JSON-compatible primitives
    if (typeof v === 'number' || typeof v === 'boolean') return true;
    return false;
  },

  parse: (v) => {
    // Convert TEXT → native object; passthrough already-native values
    if (v === null) return null;
    if (typeof v === 'string') {
      const parsed = safeJsonParse(v);
      if (parsed === null) throw new TypeError(`Invalid JSON: ${v}`);
      return parsed; // Return native object, not re-stringified
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'object' && !(v instanceof Uint8Array)) return v;
    throw new TypeError(`Cannot convert ${typeof v} to JSON`);
  },

  serialize: (v) => {
    // Native object → JSON string for storage
    if (v === null) return null;
    return JSON.stringify(v);
  },

  deserialize: (v) => {
    // JSON string from storage → native object
    if (v === null) return null;
    if (typeof v === 'string') return JSON.parse(v);
    return v; // Already native
  },

  compare: (a, b) => { /* deep compare using existing deepCompareJson */ },
};
```

### Utility function updates

- `getPhysicalType(value)`: add `typeof v === 'object'` → `PhysicalType.OBJECT` (after Uint8Array check)
- `physicalTypeName(OBJECT)`: return `'OBJECT'`
- `isSqlValue(value)`: accept plain objects and arrays
- `describeSqlValueViolation(value)`: handle object case
- `getStorageClass(v)`: add `StorageClass.OBJECT = 4` for JSON objects
- `compareSameType`: add OBJECT case using `deepCompareJson`
- `getSqlDataTypeName(v)`: return `'json'` for objects
- `inferLogicalTypeFromValue(v)`: map objects → `JSON_TYPE`
- `getLiteralSqlType(v)`: handle objects (return a new `SqlDataType.JSON` or map to TEXT)

### JSON function dual-input support

All `json_*` functions currently call `safeJsonParse(input)` on TEXT input. With OBJECT storage,
inputs may already be native objects. Add a shared helper:

```typescript
// In json-helpers.ts
export function coerceToJsonValue(input: SqlValue): JSONValue | null {
  if (input === null) return null;
  if (typeof input === 'string') return safeJsonParse(input);
  if (typeof input === 'object' && !(input instanceof Uint8Array)) return input as JSONValue;
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  return null;
}
```

Replace `safeJsonParse(json)` calls in each json_* function with `coerceToJsonValue(json)`.
Functions that return JSON values should return native objects (not re-stringified) when their
return type is JSON. Functions like `json_extract` that can return scalar SQL values continue
to return scalars.

Functions to update:
- `json_valid` — accept objects (always valid if object)
- `json_type` — accept objects
- `json_extract` — accept objects; return native sub-objects for nested JSON, scalars for primitives
- `json_array_length` — accept objects
- `json_quote` — accept objects
- `json_array` — return native array (not stringified)
- `json_object` — return native object (not stringified)
- `json_insert/replace/set/remove` — accept and return objects
- `json_patch` — accept and return objects
- `json_schema` — accept objects
- `json_group_array/object` — return native objects
- `json_each/json_tree` — accept objects
- `json()` conversion — return native object

### Storage layer (quereus-store)

**Row serialization** (`serialization.ts`):
The existing replacer/reviver handles `bigint` and `Uint8Array` with `$bigint`/`$blob` markers.
Add a `$json` marker for JSON objects to prevent collision:

```typescript
// In replacer:
if (typeof value === 'object' && value !== null && !(value instanceof Uint8Array) && !Array.isArray(value)) {
  // Only wrap if this object is a SqlValue-level JSON value (not a $bigint/$blob marker)
  // Actually: JSON objects in a Row are always at the top level (row[i]),
  // whereas $bigint/$blob markers are created by the replacer itself.
  // The replacer runs depth-first, so by the time we see a raw object in a Row slot,
  // it IS a JSON value.
}
```

Actually, the simpler approach: `JSON.stringify(row, replacer)` already correctly serializes
objects. The reviver currently only transforms `$bigint`/`$blob` markers and leaves other objects
alone — which means JSON objects round-trip correctly through `JSON.parse`.

The only risk is a JSON object that contains `{"$bigint": "123"}` being misinterpreted.
Add a `$json` wrapper at the row-element level in the replacer:
```typescript
// In replacer, when key is a numeric index (row element):
if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array) && value !== null) {
  if ('$bigint' in value || '$blob' in value) {
    return { '$json': value }; // Wrap to prevent marker collision
  }
}
```
And in the reviver, unwrap `$json` before checking for `$bigint`/`$blob`.

**Key encoding** (`encoding.ts`):
Add `TYPE_OBJECT = 0x05` prefix. Encode by serializing to JSON string, then encoding that
string as TEXT. This gives deterministic sort order (by JSON string representation).

### Test expectations

Key sqllogic tests:
- `select json('{"a":1}')` returns a native object (when viewed as JSON), not a string
- `select typeof(json('{"a":1}'))` returns `'json'`
- `create table t (data json); insert into t values (json('{"x":1}')); select json_extract(data, '$.x') from t` → 1
- `select json_extract('{"a":1}', '$.a')` still works (TEXT input backward compat)
- JSON columns in stored tables survive serialize/deserialize round-trip
- JSON objects with `$bigint`/`$blob` keys don't collide with storage markers
- Parameter binding with JS objects: `db.prepare('insert into t values (?)', [{x:1}])`
- `json_array(1,2,3)` returns a native array
- Deep comparison: `select json('{"a":1}') = json('{"a":1}')` → true


## TODO

### Phase 1: Core infrastructure
- Add `OBJECT = 6` to `PhysicalType` enum in `logical-type.ts`
- Update `getPhysicalType()` to handle objects → `PhysicalType.OBJECT`
- Update `physicalTypeName()` for OBJECT
- Extend `SqlValue` type in `common/types.ts` to include JSON objects (add `JsonSqlValue` type)
- Update `isSqlValue()` to accept plain objects/arrays
- Update `describeSqlValueViolation()` for objects
- Update `StorageClass` enum and `getStorageClass()` in `comparison.ts` (add OBJECT class)
- Update `compareSameType()` for OBJECT storage class (use `deepCompareJson`)
- Update `getSqlDataTypeName()` to return `'json'` for objects
- Update `inferLogicalTypeFromValue()` to map objects → `JSON_TYPE`
- Update `getLiteralSqlType()` for objects

### Phase 2: JSON_TYPE and conversion
- Rewrite `JSON_TYPE` in `json-type.ts` to use `PhysicalType.OBJECT`
- Add `serialize`/`deserialize` hooks (object ↔ JSON string)
- Update `validate`, `parse`, `compare` for native object values
- Update `json()` conversion function in `conversion.ts` to return native objects

### Phase 3: JSON function updates
- Add `coerceToJsonValue()` helper in `json-helpers.ts`
- Update `prepareJsonValue()` if needed for object passthrough
- Update all json_* scalar functions in `json.ts` to use `coerceToJsonValue()`
- Update json_each/json_tree in `json-tvf.ts`
- Update json_group_array/json_group_object return values
- Ensure functions that return JSON values return native objects, not strings

### Phase 4: Storage layer
- Update `serialization.ts` in quereus-store: add `$json` wrapper for marker collision prevention
- Update `encoding.ts` in quereus-store: add `TYPE_OBJECT` key encoding/decoding
- Test round-trip through serialization and key encoding

### Phase 5: Tests and docs
- Add/update sqllogic tests for native JSON object behavior
- Test backward compat (TEXT input to json functions still works)
- Test parameter binding with object values
- Test storage round-trip (insert JSON, restart/reload, read back)
- Update `docs/types.md` — change JSON from "Future" to documented, update PhysicalType table
- Update `docs/functions.md` — clarify json() returns native object
- Ensure build passes (`yarn build`) and all tests pass (`yarn test`)
