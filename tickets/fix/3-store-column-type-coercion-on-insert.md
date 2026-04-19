description: Store module preserves raw input values without coercing to declared column type (INTEGER/REAL columns store text)
dependencies: none
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/src/common/encoding.ts
  packages/quereus/src/types/
  packages/quereus/test/logic/10.2-column-features.sqllogic
  packages/quereus/test/logic.spec.ts
----

Reproduced by `10.2-column-features.sqllogic:269` under `QUEREUS_TEST_STORE=true`:

```
Actual:   {"typeof(int_col)": "text", "int_col": "100",  "typeof(real_col)": "text", "real_col": "2.71"}
Expected: {"typeof(int_col)": "integer", "int_col": 100, "typeof(real_col)": "real", "real_col": 2.71}
```

When a string `'100'` is inserted into an `INTEGER` column, memory coerces to the declared logical type; store keeps the raw text. Same semantic family as the JSON-normalization ticket, but distinct storage path and worth its own resolution — the existing `10-distinct_datatypes.sqllogic` skip entry is labelled *"type affinity coercion (store module stores raw values without coercion)"* for exactly this reason.

### TODO

- Confirm where coercion happens in the memory path (insert-time type-system conversion)
- Apply the same coercion before writing to the KV store — or before serialization in the store encoder
- Verify `typeof()` and arithmetic behaviour match memory after the fix
- Remove `10-distinct_datatypes.sqllogic` from `MEMORY_ONLY_FILES` once resolved
- Add round-trip coverage in `packages/quereus-store/test/`
