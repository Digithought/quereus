description: Native JSON type with PhysicalType.OBJECT — store JSON as JS objects, not strings
dependencies: None
files:
  - packages/quereus/src/types/logical-type.ts (PhysicalType.OBJECT = 6, getPhysicalType, physicalTypeName)
  - packages/quereus/src/common/types.ts (JsonSqlValue, SqlValue union, isSqlValue, describeSqlValueViolation, DeepReadonly)
  - packages/quereus/src/common/json-types.ts (JSONValue type — unchanged)
  - packages/quereus/src/types/json-type.ts (JSON_TYPE rewritten: PhysicalType.OBJECT, serialize/deserialize hooks)
  - packages/quereus/src/common/type-inference.ts (inferLogicalTypeFromValue, getLiteralSqlType for objects)
  - packages/quereus/src/util/comparison.ts (StorageClass.OBJECT, getStorageClass, compareSameType, getSqlDataTypeName)
  - packages/quereus/src/func/builtins/json-helpers.ts (coerceToJsonValue returns undefined on failure)
  - packages/quereus/src/func/builtins/json.ts (all json_* functions accept/return native objects)
  - packages/quereus/src/func/builtins/json-tvf.ts (json_each/json_tree accept native objects)
  - packages/quereus/src/func/builtins/conversion.ts (json() returns native object)
  - packages/quereus/src/func/builtins/scalar.ts (typeof returns 'json' for objects)
  - packages/quereus/src/emit/ast-stringify.ts (object literal rendering)
  - packages/quereus/src/index.ts (JsonSqlValue export)
  - packages/quereus-store/src/common/serialization.ts ($json marker for collision prevention)
  - packages/quereus-store/src/common/encoding.ts (TYPE_OBJECT key encoding)
  - packages/quereus/test/boundary-validation.spec.ts (updated: objects accepted as SqlValue)
  - packages/quereus/test/logic/03.6-type-system.sqllogic (JSON column outputs native objects)
  - packages/quereus/test/logic/06-builtin_functions.sqllogic (json_* functions return native objects)
  - packages/quereus/test/logic/06.7-json-extended.sqllogic (json_* functions return native objects)
  - docs/types.md (JSON type documented, PhysicalType table updated)
  - docs/functions.md (json() returns native object, JSON functions description updated)
----

## Summary

Changed JSON from `PhysicalType.TEXT` (values stored as serialized JSON strings) to
`PhysicalType.OBJECT` (values stored as native JS objects/arrays/primitives in memory).
This eliminates repeated parse/stringify cycles when working with JSON columns.

### Key changes

**Core infrastructure:**
- `PhysicalType.OBJECT = 6` added to enum
- `JsonSqlValue` type added to `SqlValue` union (plain objects and arrays)
- `StorageClass.OBJECT = 4` for comparison ordering
- `isSqlValue()` accepts plain objects/arrays
- `inferLogicalTypeFromValue()` maps objects → `JSON_TYPE`

**JSON_TYPE rewrite:**
- `physicalType` changed from `TEXT` to `OBJECT`
- `parse()` converts JSON strings to native objects; passes through native objects
- `validate()` accepts strings (for backward compat), objects, numbers, booleans
- `serialize()` converts native objects to JSON strings for storage
- `deserialize()` parses JSON strings back to native objects from storage
- `compare()` uses JSON.stringify for deep comparison

**JSON functions:**
- `coerceToJsonValue()` returns `undefined` on failure (not `null`) to distinguish
  parse failure from valid JSON null
- All `json_*` functions accept both native objects and JSON strings as input
- `json_array()`, `json_object()`, `json_insert/replace/set/remove()`, `json_patch()`
  return native objects (not JSON strings)
- `json_group_array()`, `json_group_object()` return native arrays/objects
- `json_extract()` returns native sub-objects for nested values

**Storage layer:**
- Row serialization: `$json` marker wraps objects containing `$bigint`/`$blob` keys
  to prevent marker collision during round-trip
- Key encoding: `TYPE_OBJECT = 0x05` prefix, serialized as JSON string then text-encoded

## Test scenarios for review

- `select json('{"a":1}')` → native object `{"a":1}` (not the string `'{"a":1}'`)
- `select typeof(json('{"a":1}'))` → `'json'`
- `create table t (data json); insert into t values ('{"x":1}'); select data from t` → `{"x":1}`
- JSON strings as input still work: `select json_extract('{"a":1}', '$.a')` → `1`
- `json_array(1,2,3)` returns native array `[1,2,3]`
- `json_object('a',1)` returns native object `{"a":1}`
- `json_valid(null)` → `false`, `json_valid('null')` → `true`
- `json_schema('null', 'null')` → `true` (JSON null matches null type)
- Invalid JSON rejected: `insert into json_tbl values ('{invalid')` → error
- Objects with `$bigint`/`$blob` keys survive serialization round-trip
- Parameter binding with plain objects: `[{x:1}]` inferred as JSON type
- Deep comparison: `json('{"a":1}') = json('{"a":1}')` → `true`
- Aggregate: `json_group_array(val)` returns native array
