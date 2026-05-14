---
description: `store-table.ts` UPDATE path doesn't honor column-level `defaultConflict` on the PRIMARY KEY. The PK-collision branch checks `args.onConflict === REPLACE`/`IGNORE` by strict-equal and ignores per-constraint defaults, so under pure store mode (no isolation overlay) a plain UPDATE on a table whose PK is `... PRIMARY KEY ON CONFLICT REPLACE` falls through to a unique-constraint failure. Through the isolation layer the pre-check resolves column-level defaults itself, which is why the isolated-store tests pass; the gap is in the raw store path used by `yarn test:store`.
prereq:
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-isolation/src/isolated-table.ts
---

## Background

`packages/quereus-store/src/common/store-table.ts` lines ~683–701 contain
the PK-collision branch of the UPDATE path:

```ts
if (pkChanged) {
  const existingAtNew = await store.get(newKey);
  if (existingAtNew) {
    if (args.onConflict === ConflictResolution.IGNORE) {
      return { status: 'ok', row: undefined };
    }
    if (args.onConflict !== ConflictResolution.REPLACE) {
      return { status: 'constraint', ... };
    }
  }
}
```

`args.onConflict` is now `undefined` (post-`dml-executor-update-path-default-conflict`)
when no statement-level OR clause is present, so column-level
`ON CONFLICT REPLACE`/`IGNORE` on the PK is not consulted. The memory
module (`packages/quereus/src/vtab/memory/layer/manager.ts`) and the
isolation layer (`packages/quereus-isolation/src/isolated-table.ts`)
both consult `resolvePkDefaultConflict(schema)` as the middle tier of
the precedence rule (statement OR > per-constraint default > ABORT).
`store-table.ts` should match.

Also worth checking: the `replacedRow` return field on the UPDATE
success path. The store-table UPDATE branch currently returns
`{ status: 'ok', row: coerced }` even when REPLACE evicted a row at the
new PK — once
[dml-executor-update-replaced-row-not-recorded](./dml-executor-update-replaced-row-not-recorded.md)
lands, the executor will start consuming `replacedRow` on UPDATE and the
store path will need to populate it.

## Test plan

- Run `yarn test:store` (quereus logic suite against the LevelDB store
  module) with sections 7 and 8 of
  `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic`
  in scope. They should pass without the isolation layer in the way.

## Scope note

Surfaced during review of
`dml-executor-update-path-default-conflict`. The implementer flagged
"Store-mode (`yarn test:store`) was not exercised here" — this ticket
covers the gap.
