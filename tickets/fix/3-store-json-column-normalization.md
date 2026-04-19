description: JSON-typed columns round-trip as raw text via the store module instead of as parsed native JSON values (memory normalizes, store does not)
dependencies: none
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/src/common/encoding.ts
  packages/quereus/src/types/
  packages/quereus/test/logic/03.6-type-system.sqllogic
  packages/quereus/test/logic/97-json-function-edge-cases.sqllogic
  packages/quereus/test/logic.spec.ts
----

Reproduced by `03.6-type-system.sqllogic:235` and `97-json-function-edge-cases.sqllogic:631` under `QUEREUS_TEST_STORE=true`:

```sql
CREATE TABLE json_tbl (id INTEGER PRIMARY KEY, j JSON);
INSERT INTO json_tbl VALUES (1, '{"a":1}');
SELECT j FROM json_tbl;
-- memory: {"j": {"a": 1}}   (parsed)
-- store:  {"j": "{\"a\":1}"} (raw text)
```

The same-shaped failure at `97-json-function-edge-cases.sqllogic:631` confirms it's the column-storage path, not a one-off. The `06-builtin_functions.sqllogic` entry already in `MEMORY_ONLY_FILES` carries this exact comment: *"JSON normalization differs between memory and store (memory normalizes, store preserves raw)."* That file is skipped today; `03.6` and `97` are not, and they surface real functional loss — `typeof(j)` returns `'text'` instead of `'json'`, and `json_*` functions fed the raw string behave differently.

### Design question

The right fix is almost certainly "store should normalize on insert too" — logical JSON columns should persist the parsed representation (or a canonical serialization that is re-inflated on read). The alternative — teach readers to parse lazily — leaks storage details upward and breaks `typeof`.

### TODO

- Confirm memory's path: where does `INSERT INTO json_tbl VALUES (1, '{"a":1}')` get coerced into a native JSON value? (Likely the type-system's insert-time coercion.)
- Decide: does the store's encoder serialize the already-parsed value, or re-parse on read? Either produces the right semantics; pick whichever avoids double-encoding overhead.
- Fix and re-check `typeof(j)` behaviour (should return `'json'`)
- Remove `06-builtin_functions.sqllogic` from `MEMORY_ONLY_FILES` once this is resolved — the skip was for this exact reason
- Add `packages/quereus-store/test/` coverage for JSON column round-trip
