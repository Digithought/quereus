---
description: Review `IsolationModule`'s overlay-level PK / UNIQUE pre-checks now reading column-level `defaultConflict` and per-UC `defaultConflict`, so column-level `ON CONFLICT REPLACE|IGNORE|FAIL|ROLLBACK` is honored when a statement omits an `OR <action>` override. Three-tier resolution (`stmt OR > per-constraint default > ABORT`) now matches the memory vtab.
files:
  packages/quereus-isolation/src/isolated-table.ts
  packages/quereus-store/test/isolated-store.spec.ts
---

# Review: `IsolationModule` honors column-level `defaultConflict`

## What changed

Three sites in `packages/quereus-isolation/src/isolated-table.ts` that previously short-circuited to `UNIQUE constraint failed` whenever the statement lacked an `OR <action>` override now read the column-level / UC-level default:

- **Live overlay row on insert** (formerly `isolated-table.ts:646–657`): replaced the `!args.onConflict || args.onConflict === ABORT` guard with `resolveEffective(args.onConflict, resolvePkDefaultConflict(this.tableSchema!))`. ABORT/FAIL/ROLLBACK still raise; IGNORE/REPLACE fall through to the wrapped vtab.
- **`checkMergedPKConflict`**: now resolves `effective = stmt ?? resolvePkDefaultConflict(schema) ?? ABORT` before deciding IGNORE / REPLACE / constraint-error.
- **`checkMergedUniqueConstraints`**: resolves per-UC: `effective = stmt ?? uc.defaultConflict ?? ABORT`.

To keep the wrapped overlay vtab in agreement with what the overlay decided, `update()` computes `effectiveOR = args.onConflict ?? resolvePkDefaultConflict(this.tableSchema!)` once at the top and forwards it on every `overlay.update({...})` call (the four sites at: insert fall-through, tombstone-to-row conversion, PK-change update's insert, same-PK update, and no-existing-overlay-row insert). The wrapped memory vtab's own resolver would arrive at the same answer (since `createOverlaySchema` spreads column references and `defaultConflict` survives), but forwarding the resolved value makes the contract explicit at the boundary.

Two helpers added at module scope at the bottom of `isolated-table.ts`:

- `resolvePkDefaultConflict(schema)` — mirrors the helper of the same name in `packages/quereus/src/vtab/memory/layer/manager.ts:1491` (intentionally duplicated; a cross-package home would widen the public API surface for one line).
- `resolveEffective(stmt, perConstraint)` — three-tier `stmt ?? perConstraint ?? ABORT`.

`TableSchema` is now imported as a type from `@quereus/quereus`.

## Tests

Added six cases under a new `describe('column-level ON CONFLICT default (defaultConflict)')` block in `packages/quereus-store/test/isolated-store.spec.ts` (after the existing `cross-layer UNIQUE / PK conflict detection` group):

1. **PK col-level REPLACE, plain INSERT, underlying conflict** — second insert wins.
2. **PK col-level IGNORE, plain INSERT, underlying conflict** — first row retained.
3. **Statement `OR ABORT` overrides col-level REPLACE** — raises constraint error; original row retained.
4. **UNIQUE col-level REPLACE, plain INSERT, underlying conflict** — prior conflicting row evicted, new row wins.
5. **UNIQUE col-level IGNORE, plain INSERT, underlying conflict** — second insert silently dropped; cnt = 1.
6. **PK col-level REPLACE, live overlay row in same BEGIN/COMMIT** — second insert in same txn replaces first.

All 250 tests in `@quereus/store` pass. `@quereus/isolation` (64) and `@quereus/quereus` (2940) also pass.

## Known gaps to probe

- **UPDATE path doesn't honor column-level `defaultConflict` end-to-end.** `packages/quereus/src/runtime/emit/dml-executor.ts:499` coerces `plan.onConflict ?? ConflictResolution.ABORT` before calling `vtab.update()`. The INSERT path at line 369 deliberately keeps `undefined` so the vtab can fall back to per-constraint defaults, but the UPDATE path overwrites `undefined` with `ABORT`. Consequence: a `PRIMARY KEY ON CONFLICT REPLACE` column does **not** make an `UPDATE` that hits a PK collision (e.g., `UPDATE t SET id = 2 WHERE id = 1` against an existing id=2) silently replace — it still raises. The overlay code in `isolated-table.ts` now does the right thing if it ever sees `undefined` from above, but currently it doesn't. This is upstream of the isolation layer; fixing it likely belongs in a separate ticket that audits the UPDATE-path `?? ABORT` (mirror INSERT's comment at `dml-executor.ts:366–368`). I drafted a test for this case and then removed it with a comment in `isolated-store.spec.ts` explaining the upstream constraint.
- **Table-level `PRIMARY KEY (a, b) ON CONFLICT IGNORE` is also a gap.** `findConstraintPKDefinition` in `packages/quereus/src/schema/table.ts:483` doesn't propagate `TableConstraint.onConflict` onto column `defaultConflict`, and `resolvePkDefaultConflict` only inspects columns. The pre-existing logic test `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic` only covers column-level forms, so this gap is symmetric to the upstream baseline — but the lamina conformance ticket may want it. Out of scope here.
- **Flush-time `onConflict`.** `flushOverlayToUnderlying` (`isolated-table.ts:1063+`) calls `underlyingTable.update({ operation: 'insert' | 'update' | 'delete', preCoerced: true })` without passing `onConflict`. By the time we flush, the overlay's pre-check has already resolved all conflicts (REPLACE evictions are tombstoned, IGNORE never reaches flush). But if a future change introduces a code path where the underlying could see a conflict at flush, the lack of `onConflict` would surface as an ABORT. Not exercised today; flagging for awareness.
- **Sample-plugins failures are pre-existing.** `yarn test` shows 2 failures in `@quereus/sample-plugins` (`key_value_store virtual table > supports delete/update`). Verified via `git stash` that those failures exist on `main` and are unrelated.

## Reviewer probe list

- `effective` computation in the live-overlay-row branch (insert path, `isolated-table.ts` near line ~660) — confirm `args.onConflict` (when ABORT/FAIL/ROLLBACK) properly short-circuits; confirm REPLACE/IGNORE fall through and don't double-resolve in the wrapped vtab.
- `effectiveOR` propagation: the four `overlay.update({..., onConflict: effectiveOR})` and one `{...argsForOverlay, ...}` spread. Is there a code path I missed where `args.onConflict` is still passed raw to `overlay.update`? (I left the `case 'delete'` overlay calls using `args.onConflict` since they don't pre-check uniqueness — confirm that's fine.)
- `resolveEffective(onConflict, uc.defaultConflict)` inside `checkMergedUniqueConstraints` — the UC's own default wins per-constraint. The argument forwarded to `overlay.update` is the PK-level `effectiveOR`. That's correct because IGNORE/REPLACE paths short-circuit with `{status: 'ok'}` or insert a tombstone *before* reaching `overlay.update`, so the wrapped vtab never sees an unresolved UC conflict — but worth a second read.
- Live overlay row branch when the table has no column-level PK default and no statement OR: `resolveEffective(undefined, undefined) === ABORT` — same as before. Verify no regression on the existing tests in `cross-layer UNIQUE / PK conflict detection`.
- Verify the helpers at module scope (after the class) don't trigger TDZ for any callers that use them inside the class body. Currently only called from within instance methods, which are invoked after module load, so the hoisting of function declarations covers it — but worth confirming.

## How to validate

```
yarn workspace @quereus/store run test
yarn workspace @quereus/isolation run test
yarn workspace @quereus/quereus run test
```

All pass. The new test block is `describe('column-level ON CONFLICT default (defaultConflict)')` in `packages/quereus-store/test/isolated-store.spec.ts`.

External acceptance signal (out of this repo): the lamina conformance suite's
`29.1-column-level-on-conflict.sqllogic` cases 1–5 — those run through `createSqllogicFixture`, which wraps `LaminaModule` in `IsolationModule`, and they exercise the same INSERT-side semantics this ticket fixed.
