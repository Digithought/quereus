description: Store module honors DESC direction in primary-key (and index) natural iteration order
dependencies: none
files:
  packages/quereus-store/src/common/encoding.ts
  packages/quereus-store/src/common/key-builder.ts
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus-sync/src/sync/store-adapter.ts
  packages/quereus-store/test/encoding.spec.ts
  packages/quereus-store/test/key-builder.spec.ts
  packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic
----

## What changed

Byte-level DESC encoding threads through the storage layer so that natural
KV iteration order matches declared per-column direction:

- `encodeCompositeKey(values, options, directions?)` — when `directions[i]` is
  true the encoded bytes of component `i` are bit-inverted (`^0xff`).
  Bit-inversion of a fixed-width sortable encoding preserves inverse
  byte-lex order per component without disturbing composite ordering.
- `buildDataKey(pk, options, directions?)` forwards `directions` to the
  composite encoder.
- `buildIndexKey(indexValues, pkValues, options, indexDirections?, pkDirections?)`
  takes independent DESC flags for the index half and the PK suffix.
- `buildFullScanBounds()` now returns `{ gte: Uint8Array(0) }` (unbounded).
  The previous `lt: [0xff]` upper bound would have excluded any key whose
  first byte is 0xff — which happens whenever a DESC column's encoded type
  prefix (NULL 0x00, INT 0x01, …) is inverted.
- `buildIndexPrefixBounds(values, options, directions?)` accepts per-component
  directions so prefix probes against DESC indexes encode consistently.
- `StoreTable` captures `pkDirections` in the constructor and in
  `updateSchema` (ALTER) and passes it to every `buildDataKey` call site
  (`query`, INSERT/UPDATE/DELETE, `rekeyRows`, REPLACE eviction).
- `updateSecondaryIndexes` computes `indexDirections` per index and passes
  both halves' directions to `buildIndexKey`.
- `StoreModule.buildIndexEntries` (used during `CREATE INDEX` on existing
  rows) also computes and forwards both halves' directions.
- `store-adapter.ts` (sync apply path) threads PK directions from the
  resolved `TableSchema`.

## Use cases / validation

- `CREATE TABLE t (id INTEGER PRIMARY KEY DESC)` — natural `select *` order
  is descending (baseline, already worked for INTEGER via memory vtab).
- `CREATE TABLE t (name TEXT PRIMARY KEY DESC)` — now descending under
  store mode (was ascending before this ticket).
- `CREATE TABLE t (val REAL PRIMARY KEY DESC)` — now descending.
- `CREATE TABLE t (name TEXT, PRIMARY KEY (name DESC))` — table-level DESC
  constraint also honored.
- Composite mixed `(c ASC, seq DESC)` — c groups ascend, seq descends within
  each group.

## Tests

- `packages/quereus-store/test/encoding.spec.ts` — unit tests for
  single-column DESC (INT, TEXT, REAL) and mixed ASC/DESC composite shapes;
  also asserts `directions=undefined` == all-false ASC.
- `packages/quereus-store/test/key-builder.spec.ts` — DESC direction tests
  on `buildDataKey` + `buildIndexKey` (independent halves) and the new
  unbounded `buildFullScanBounds` shape.
- `packages/quereus/test/logic/40.1-pk-desc-direction.sqllogic` — all five
  scenarios pass under `QUEREUS_TEST_STORE=true`.

## Validation runs

- `yarn workspace @quereus/store run build` — clean.
- `yarn build` — clean.
- `yarn workspace @quereus/store test` — 216 passing.
- `yarn test` — all green.
- `yarn test:store` — 566 passing; the single failure in
  `50-declarative-schema.sqllogic` is a pre-existing, unrelated deferred-
  constraint connection resolution issue (not touched by this ticket).

## Reviewer focus

- Confirm direction threading through every `buildDataKey` /
  `buildIndexKey` call site (data ops, index maintenance, sync apply,
  index backfill).
- Confirm `buildFullScanBounds` callers do not rely on the removed `lt`
  upper bound.
- Confirm `updateSchema` refreshes `pkDirections` after ALTER.
