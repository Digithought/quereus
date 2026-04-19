description: Store module must honor DESC direction in primary-key (and index) natural iteration order
dependencies: none
files:
  packages/quereus-store/src/common/encoding.ts
  packages/quereus-store/src/common/key-builder.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/encoding.spec.ts
  packages/quereus-store/test/key-builder.spec.ts
  packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic
----

## Problem

Store's KV iteration is byte-lexicographic. Keys are produced by `encodeCompositeKey` with no awareness of per-column `desc` direction, so a table declared `PRIMARY KEY (id DESC)` (or a column-level `... PRIMARY KEY DESC`) iterates ascending instead of descending under `QUEREUS_TEST_STORE=true`.

`packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic:14` reproduces:
```
Actual:   {"id": 1}
Expected: {"id": 3}
```

Memory vtab's `digitree` comparator applies `desc ? -1 : 1` (see `packages/quereus/src/vtab/memory/utils/primary-key.ts:57`). Store needs the byte-level equivalent: invert the encoded bytes of any DESC column so that natural byte-lex order matches the declared DESC order of that column, independent of any surrounding ASC columns.

## Design

Per-column direction threads through the encoder:

- `encodeCompositeKey(values, options, directions?)` — for each position where `directions[i] === true`, bit-invert (`^0xff`) every byte of that value's encoded bytes. This preserves inverse sort order per component without disturbing composite ordering.
- `buildDataKey(pkValues, options, directions?)` — forwards `directions` to the composite encoder.
- `buildIndexKey(indexValues, pkValues, options, indexDirections?, pkDirections?)` — each half is direction-aware.
- `buildFullScanBounds()` — the `lt: [0xff]` upper bound becomes invalid once DESC columns can produce leading 0xff bytes (e.g. inverted NULL type prefix 0x00 → 0xff). Drop the bounds (return empty options) or widen them; data stores are per-table so unbounded iteration over the store is safe.

`StoreTable` captures PK directions at construction:
```ts
protected pkDirections: boolean[] = this.tableSchema!.primaryKeyDefinition.map(pk => !!pk.desc);
```
It passes `pkDirections` to every `buildDataKey` call (INSERT / UPDATE / DELETE / point-get / range-scan).

For each secondary index, compute its `indexDirections` = `index.columns.map(c => !!c.desc)` and pass both `indexDirections` and `pkDirections` to `buildIndexKey` so ordered index scans (when added) honor per-column direction.

## Testing

- Add unit tests in `packages/quereus-store/test/encoding.spec.ts`:
  - `encodeCompositeKey` with `directions=[true]` produces bytes that sort in reverse for pure-DESC single column (INT, TEXT, REAL).
  - Mixed `directions=[false, true]`: sort preserves ASC on column 0, DESC on column 1.
  - Mixed `directions=[true, false]`: primary DESC group, secondary ASC within group.
- Add `packages/quereus-store/test/key-builder.spec.ts` cases mirroring composite PK direction shapes.
- Re-run `packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic` under `QUEREUS_TEST_STORE=true` (`yarn test:store`) — all four scenarios must pass.

## TODO

- Extend `encodeCompositeKey` with optional `directions` parameter and implement bit-inversion per component.
- Extend `buildDataKey` / `buildIndexKey` signatures.
- Loosen `buildFullScanBounds` so inverted-byte keys are not excluded.
- Capture `pkDirections` in `StoreTable`; thread through all key-building call sites in `store-table.ts`.
- Compute per-index directions inside `updateSecondaryIndexes` and pass to `buildIndexKey`.
- Add encoding and key-builder unit tests for pure-DESC and mixed composite keys.
- Run `yarn lint && yarn build && yarn test` and `yarn test:store` (focus on `40.1-pk-desc-direction.sqllogic`).
