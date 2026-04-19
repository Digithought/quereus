description: Store module ignores DESC direction on primary-key iteration
dependencies: none
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/src/common/key-builder.ts
  packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic
----

Reproduced by `40.1-pk-desc-direction.sqllogic:14` under `QUEREUS_TEST_STORE=true`:

```
Actual:   {"id": 1}
Expected: {"id": 3}
```

A DESC-keyed table should iterate in descending key order; store returns ascending. See the full scenario in the sqllogic file — it creates a table with `PRIMARY KEY (id DESC)` and expects reads to emerge in descending order.

### Hypothesis

Store's KV iteration uses byte-lexicographic order with a single direction. Either the key encoding doesn't flip bytes for DESC columns, or the scan ignores the column's direction attribute. Memory's comparator is PK-direction-aware via the `digitree` comparator setup — store needs the equivalent encoding-side flip.

### TODO

- Confirm how the PK direction is conveyed to the store (table schema property)
- Either invert key-byte encoding for DESC columns at write time, or iterate in reverse when scan direction requires it
- Add a spec in `packages/quereus-store/test/` for pure-DESC and mixed ASC/DESC composite keys
- Re-run `40.1-pk-desc-direction.sqllogic` in store mode
