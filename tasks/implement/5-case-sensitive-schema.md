---
description: Fix schema names being improperly case-sensitive
dependencies: none
---

## Bug Description

Schema names like "App" and "app" should resolve to the same schema, but several code paths in `SchemaManager` fail to normalize schema names to lowercase before using them as map keys. The `schemas` map in `SchemaManager` uses lowercase keys, but not all lookup/access methods lowercase their input before querying the map.

## Root Cause

The `SchemaManager.schemas` map stores keys in lowercase (e.g., `addSchema` uses `lowerName`), but several methods that read from this map do **not** lowercase the schema name before lookup. This means if a caller passes `"App"` instead of `"app"`, the lookup fails silently (returns `undefined`) or creates a mismatch.

## Affected Locations

### Primary: `packages/quereus/src/schema/manager.ts`

1. **`getView()` (line ~362-366)**: `this.schemas.get(targetSchemaName)` — `targetSchemaName` is not lowercased. If `schemaName` param is mixed-case, lookup fails.

2. **`getSchemaItem()` (line ~375-384)**: `this.schemas.get(targetSchemaName)` — same issue as `getView()`.

3. **`getTable()` (line ~517-521)**: `this.schemas.get(targetSchemaName)` — same issue. The `targetSchemaName` comes from `schemaName ?? this.currentSchemaName` without lowercasing.

4. **`dropView()` (line ~477-481)**: `this.schemas.get(schemaName)` — `schemaName` is not lowercased.

5. **`addSchema()` (line ~247)**: Creates `new Schema(name)` with original case instead of `new Schema(lowerName)`. The `Schema.name` property will retain the original case, causing `addView()` schema name comparison to fail if cases differ.

### Secondary: `packages/quereus/src/schema/schema.ts`

6. **`addView()` (line ~93)**: Compares `view.schemaName !== this.name` — this is a case-sensitive string comparison. If the `Schema` object was created with original-case name (from `addSchema` bug #5) and the view has a different case, this check fails incorrectly.

### Tertiary: `packages/quereus/src/planner/building/schema-resolution.ts`

7. **`resolveTableSchema()` cache keys (line ~23, ~59)**: Cache keys include `resolvedSchemaName` and `schemaPath` values without lowercasing. If the same schema is referenced as "App" and "app" in different queries, they get separate cache entries (cache miss, not a correctness bug since `findTable` does lowercase internally, but wasteful).

## Fix Strategy

The fix should normalize schema names at the boundary — i.e., in every `SchemaManager` method that accepts a schema name parameter. This is the defensive approach that prevents any caller from accidentally passing mixed-case names.

### Changes Required

**`packages/quereus/src/schema/manager.ts`:**
- `getView()`: lowercase `targetSchemaName` before map lookup
- `getSchemaItem()`: lowercase `targetSchemaName` before map lookup
- `getTable()`: lowercase `targetSchemaName` before map lookup
- `dropView()`: lowercase `schemaName` before map lookup
- `addSchema()`: pass `lowerName` to `new Schema(lowerName)` instead of `name`

**`packages/quereus/src/schema/schema.ts`:**
- `addView()`: use case-insensitive comparison for `view.schemaName` vs `this.name`

**`packages/quereus/src/planner/building/schema-resolution.ts`:**
- Normalize cache keys to lowercase for schema names and table names

## TODO

### Phase 1: Fix SchemaManager methods
- [ ] In `getView()`, lowercase `targetSchemaName` before `this.schemas.get()`
- [ ] In `getSchemaItem()`, lowercase `targetSchemaName` before `this.schemas.get()`
- [ ] In `getTable()`, lowercase `targetSchemaName` before `this.schemas.get()`
- [ ] In `dropView()`, lowercase `schemaName` before `this.schemas.get()`
- [ ] In `addSchema()`, pass `lowerName` to `new Schema()` constructor

### Phase 2: Fix Schema class
- [ ] In `addView()`, use case-insensitive comparison: `view.schemaName.toLowerCase() !== this.name.toLowerCase()`

### Phase 3: Fix planner cache keys
- [ ] In `resolveTableSchema()`, lowercase schema name and table name in cache keys

### Phase 4: Add test
- [ ] Add a sqllogic test that creates a schema with mixed case and verifies case-insensitive access

