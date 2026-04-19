description: Apply declared column-type coercion in the store module's update() path so INSERT/UPDATE serialize logically-typed values (mirrors memory-table behavior) — covers INTEGER/REAL affinity and JSON normalization
dependencies: none
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus/src/types/validation.ts            (validateAndParse - reuse)
  packages/quereus/src/types/index.ts                  (re-export surface)
  packages/quereus/src/types/json-type.ts             (JSON_TYPE.parse handles text→parsed)
  packages/quereus/src/vtab/memory/layer/manager.ts   (reference: performInsert/performUpdate)
  packages/quereus/src/schema/column.ts               (ColumnSchema.logicalType)
  packages/quereus/test/logic/10-distinct_datatypes.sqllogic
  packages/quereus/test/logic/10.2-column-features.sqllogic
  packages/quereus/test/logic/06-builtin_functions.sqllogic
  packages/quereus/test/logic/03.6-type-system.sqllogic
  packages/quereus/test/logic/97-json-function-edge-cases.sqllogic
  packages/quereus/test/logic.spec.ts                 (MEMORY_ONLY_FILES)
  packages/quereus-store/test/                        (add round-trip coverage)
----

## Root cause

`StoreTable.update()` in `packages/quereus-store/src/common/store-table.ts` (lines 499-668) serializes the incoming `values` array directly via `serializeRow(values)` without coercing each cell to its declared column type. The memory path does this coercion inside `MemoryTableManager.performInsert()` / `performUpdate()` (`packages/quereus/src/vtab/memory/layer/manager.ts:543-552` and `594-603`) using `validateAndParse(value, column.logicalType, column.name)` from `packages/quereus/src/types/validation.ts`.

Because the planner/runtime explicitly leaves coercion to the vtab (see `packages/quereus/src/runtime/emit/insert.ts:26` — *"No affinity conversion here - let the type system handle it"*), a vtab that skips the step stores raw strings into INTEGER/REAL columns — and likewise leaves JSON-typed columns holding raw text rather than the parsed native object.

### Repro for the JSON case

`03.6-type-system.sqllogic:235` and `97-json-function-edge-cases.sqllogic:631` under `QUEREUS_TEST_STORE=true`:

```sql
CREATE TABLE json_tbl (id INTEGER PRIMARY KEY, j JSON);
INSERT INTO json_tbl VALUES (1, '{"a":1}');
SELECT j FROM json_tbl;
-- memory: {"j": {"a": 1}}   (parsed)
-- store:  {"j": "{\"a\":1}"} (raw text)
```

Consequences: `typeof(j)` returns `'text'` instead of `'json'`, and `json_*` functions fed the raw string behave differently. `JSON_TYPE.parse()` in `packages/quereus/src/types/json-type.ts:23-40` already converts strings via `safeJsonParse` — the same `validateAndParse` call that fixes INTEGER/REAL also fixes JSON automatically.

## Fix

Coerce the inbound `values` (and `oldKeyValues` where appropriate) inside `StoreTable.update()` using the same `validateAndParse` helper, before any PK extraction, serialization, or index-key construction. Apply to both `insert` and `update` operations. `delete` only uses `oldKeyValues` for key lookup and doesn't need coercion.

Notes:
- `ColumnSchema.logicalType` is the affinity source; access via `this.tableSchema!.columns[i]`.
- `validateAndParse` is already exported from `@quereus/quereus` (`packages/quereus/src/types/index.ts`).
- Coerce before `extractPK(values)` so PK encoding uses the normalized types (otherwise `buildDataKey` would key a text `'100'` differently from integer `100`).
- Guard against `values.length > schema.columns.length` (defensive, matching the memory path).

### Implementation sketch

```ts
import { validateAndParse } from '@quereus/quereus';

private coerceRow(row: Row): Row {
    const cols = this.tableSchema!.columns;
    return row.map((v, i) =>
        i < cols.length ? validateAndParse(v, cols[i].logicalType, cols[i].name) : v
    ) as Row;
}
```

Use in `insert`/`update` cases:
```ts
const coerced = this.coerceRow(values);
const pk = this.extractPK(coerced);
// ...
const serializedRow = serializeRow(coerced);
// emit events / updateSecondaryIndexes using `coerced` instead of raw `values`
// return { status: 'ok', row: coerced, ... }
```

### Why this location

- Matches memory-path semantics exactly (same helper, same call site intent).
- Guarantees consistency whether INSERTs arrive from SQL, sync stream, or direct `update()` calls.
- Keeps coercion at the mutation boundary, preserving existing read-side serialization format.

## Verification

1. `yarn workspace @quereus/quereus test` — smoke test memory path still green.
2. `QUEREUS_TEST_STORE=true yarn workspace @quereus/quereus test` (or `yarn test:store`):
   - `10.2-column-features.sqllogic:269` must now yield `{int_col: 100, typeof: "integer", real_col: 2.71, typeof: "real"}`.
   - `03.6-type-system.sqllogic:235` and `97-json-function-edge-cases.sqllogic:631` must yield parsed JSON (`{"j": {"a": 1}}`) and `typeof(j) == 'json'`.
   - Remove `'10-distinct_datatypes.sqllogic'` and `'06-builtin_functions.sqllogic'` from `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts:39-44` and re-run — expect pass.
3. `yarn workspace @quereus/quereus-store test` — new coverage (below).

## Tests to add (`packages/quereus-store/test/`)

Follow the Mocha/ts-node pattern used by existing specs (e.g. `alter-table.spec.ts`, `isolated-store.spec.ts`). A new `column-coercion.spec.ts`:

- INSERT `'100'` into an INTEGER column → stored + scanned back as number `100`; `typeof(row[i]) === 'number'`.
- INSERT `'2.71'` into a REAL column → stored + scanned back as number `2.71`.
- INSERT number `42` into a TEXT column → stored as `'42'`.
- INSERT a valid-looking-but-wrong string (e.g. `'abc'` into INTEGER) → same error `QuereusError` with `StatusCode.MISMATCH` as memory path.
- Round-trip after close/reopen of the KV store to prove persisted form is the coerced type (not raw text).
- UPDATE path mirrors INSERT: string-to-integer coercion produces numeric value in the serialized row.
- PK coercion: inserting `'1'` into an INTEGER PK and then querying with `WHERE pk = 1` must find the row (ensures `extractPK` runs on coerced values).
- INSERT JSON text `'{"a":1}'` into a JSON column → stored + scanned back as a native object `{a: 1}`; `typeof` in SQL returns `'json'`.
- INSERT invalid JSON text into a JSON column → `QuereusError`/`TypeError` from `JSON_TYPE.parse` (same path as memory).
- Round-trip JSON column through close/reopen to verify persisted form is parseable as the native object (no double-stringification).

## TODO

- Add `coerceRow` helper to `StoreTable` and wire it into `insert`/`update` cases of `update()` before PK extraction and serialization
- Verify `updateSecondaryIndexes` receives coerced row so index keys use logical types
- Ensure `UpdateResult.row` / `replacedRow` contain the coerced row (callers may rely on logical typing)
- Add `packages/quereus-store/test/column-coercion.spec.ts` with the cases above (including JSON-column round trip)
- Remove `'10-distinct_datatypes.sqllogic'` and `'06-builtin_functions.sqllogic'` from `MEMORY_ONLY_FILES` in `packages/quereus/test/logic.spec.ts`
- Run `yarn test` and `yarn test:store`; both must pass (including `03.6-type-system.sqllogic` and `97-json-function-edge-cases.sqllogic`)
- Lint: `yarn workspace @quereus/quereus lint` (store package has no lint script)
