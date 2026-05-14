---
description: Collapsed the parallel `PhysicalProperties.uniqueKeys` field into `fds`; unique keys are now encoded as `K → (all_cols \ K)` FDs (with `∅ → all_cols` for at-most-one-row). Removed the field from the type and migrated every producer + consumer.
prereq:
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/framework/characteristics.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/src/planner/nodes/table-function-call.ts
  - packages/quereus/src/planner/nodes/single-row.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/nodes/alias-node.ts
  - packages/quereus/src/planner/nodes/limit-offset.ts
  - packages/quereus/src/planner/nodes/ordinal-slice-node.ts
  - packages/quereus/src/planner/nodes/sort.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/src/planner/nodes/retrieve-node.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts
  - packages/quereus/src/planner/rules/join/rule-join-greedy-commute.ts
  - docs/optimizer.md
  - docs/architecture.md
---

## What landed

The `PhysicalProperties.uniqueKeys` field is gone. Unique keys are now expressed exclusively through `PhysicalProperties.fds`:

- A unique key `K` (with `K ⊊ all_cols`) is encoded as the FD `K → (all_cols \ K)`.
- The empty determinant set encodes "at-most-one-row" via the singleton FD `∅ → all_cols` (replaces the legacy `[[]]` marker).
- The "all-columns is the only key" case (DISTINCT, set-typed inputs without a smaller key) has no non-trivial FD encoding — it is communicated via `RelationType.isSet`.

### New helpers in `planner/util/fd-utils.ts`

- `superkeyToFd(key, columnCount)` — now returns `FunctionalDependency | undefined`; the undefined case is the all-cols-is-a-key tautology.
- `singletonFd(columnCount)` — build the `∅ → all_cols` "at-most-one-row" FD.
- `isSuperkey(attrs, fds, columnCount)` — closure-based; returns true on the trivial all-cols-superkey-of-all-cols tautology.
- `isAssertedKey(attrs, fds, columnCount)` — stricter: requires an FD in the set whose determinants ⊆ attrs and whose closure covers all columns. Use this when you need a positive uniqueness claim (e.g. strict-monotonicOn detection); the trivial superkey case is excluded.
- `hasAnyKey(fds, columnCount)` — true iff the FD set encodes any non-trivial key.
- `hasSingletonFd(fds, columnCount)` — true iff `∅ → all_cols` is present.
- `deriveKeysFromFds(fds, columnCount)` — minimal key sets discoverable from FDs.
- `AddFdOptions.uniqueKeys` was renamed to `AddFdOptions.keyHints` (semantics unchanged — cap-preference hint for which determinant sets to keep when truncating).

### Behavior change in `projectFds`

`projectFds` now drops a dependent column when it can't be mapped instead of dropping the whole FD. This keeps the singleton `∅ → all_cols` claim alive through projection (and is provably safe in general: `X → Y` implies `X → Y'` for any `Y' ⊆ Y`).

### `analyzeJoinKeyCoverage` shape change

The function now returns `preservedKeys: number[][]` (always non-undefined, possibly empty) instead of `uniqueKeys: number[][] | undefined`. `propagateJoinFds` accepts the preserved keys and materializes each as a `key → all_other_join_cols` FD on the join output via `superkeyToFd`. Callers also pass `totalColumnCount` so the encoding is correct.

The physical key-coverage check (`coversPhysicalKey` previously walking `phys.uniqueKeys`) is now `isSuperkey(eqSet, phys.fds, colCount)`.

## How to validate

**Validation in the implementation:** ran `yarn build`, `yarn lint`, and the full `yarn test` suite (2895 passing, 2 pending). Each migration step ran `yarn test` to confirm no regression.

### Test surfaces touched

- `test/optimizer/keys-propagation.spec.ts` — fully rewritten. `physical` column now carries FDs, not `uniqueKeys`; helpers `hasKeyFd`, `fdsHaveSingleColKey`, `fdsHaveAnyKey` inspect the FD shape. Logical-key checks (via `ProjectNode.getLogicalAttributes().uniqueKeys` JSON output) preserved where the single-column all-cols-key case has no FD encoding.
- `test/optimizer/fd-propagation.spec.ts` — dropped `uniqueKeys` from the test interface; updated the Distinct test to no longer assert on `uniqueKeys`; updated the `superkeyToFd` unit test to cover the new `undefined` return; updated the "non-injective expression" test to assert on the new key-encoding FD rather than the absence of col-1 references.
- `test/optimizer/fd-equivalence.spec.ts`, `test/optimizer/rule-groupby-fd-simplification.spec.ts` — dropped the unused `uniqueKeys` field from local type interfaces.
- `test/planner/framework.spec.ts` — `hasUniqueKeys` test rewritten to set an FD (`{0,1} → {2}`) and assert detection via the FD path.
- `test/planner/tvf-physical-properties.spec.ts` — replaced `uniqueKeys` field assertions with FD-shape assertions; for single-column TVFs (where the key spans all output cols) the test verifies the ordering/monotonicOn surfaces instead.

### Useful test cases for review

The cleanup is mostly mechanical, but watch for these subtleties:

- **Singleton FD through projection.** `projectFds` now preserves `∅ → ...` when at least one dependent maps. A test like "Filter covered-key over multi-col table, then Project" should still report the singleton claim on the Project output. Spot-check via the `query_plan()` `physical` column: look for an FD with empty `determinants`.
- **Single-column relations.** TVF advertisements with `keys: [[0]]` on a 1-col relation produce no FD (the all-cols tautology). The uniqueness claim lives on `RelationType.isSet` instead. `rule-distinct-elimination` consults logical `RelationType.keys` first, so this case still elides DISTINCT correctly; verify with `SELECT DISTINCT value FROM generate_series(1, ?)`.
- **Join key-encoding FD.** For `SELECT * FROM small INNER JOIN big ON small.fk = big.pk` the right PK is covered → preserved keys = small's key → an FD `{small_pk_idx} → all_other_join_cols` should appear on the join's physical output. Test in `keys-propagation.spec.ts` exercises this on 4-col output.
- **Strict monotonicOn on sort/window.** Uses `isAssertedKey` (not `isSuperkey`) — the strict claim requires a positive FD-encoded key, not the trivial all-cols-superkey case. Single-column sort over a non-unique source should report `strict: false`.

### Likely-overlooked

- The `physical-utils.ts` helpers `uniqueKeysImplyDistinct` and `projectUniqueKeys` are pure utilities on `number[][]` and have no production callers; they were left in place to avoid churn but the framework tests for them still exercise them. They could be removed in a follow-up if dead code matters.
- The `Project.getLogicalAttributes().uniqueKeys` field is preserved — it exposes the *logical* `RelationType.keys` as a debug surface. The naming is now slightly confusing (it's not the physical uniqueKeys), but renaming it would be a logged-output change with no production benefit.
- I did NOT touch `vtab/best-access-plan.ts`'s `BestAccessPlanResult.uniqueRows: boolean` — per the ticket's "Out of scope" section, that's a separate concern.

### Known gaps

- The asof-scan node passes left's FDs through but doesn't try to recover the left-key-as-output-key claim (which is provable: each left row appears at most once in the output). This matches the conservative prior behavior. A future ticket could add the left-key FD on the asof output's wider column space.
- The aggregate's group-key FD assumes a contiguous `[0..groupCount-1]` group-by column layout in the output. This matches all three aggregate node variants' `buildAttributes()` but should be re-verified if the aggregate output layout ever changes.

## Out of scope

- `RelationType.keys` (logical, schema-side) — unchanged.
- `BestAccessPlanResult.uniqueRows` — separate cleanup if warranted.
