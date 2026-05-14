---
description: Review outer-join key + FD propagation refinement: preserved-side keys survive LEFT/RIGHT joins when equi-pairs cover the other side's unique key
files:
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/test/optimizer/keys-propagation.spec.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts
  - docs/optimizer.md
---

## Summary

Refined key and FD propagation for outer joins so the preserved side's keys/FDs survive when the equi-join pairs cover the other side's unique key. Previously `combineJoinKeys` and `analyzeJoinKeyCoverage` bailed to empty results for any non-inner/cross join, which is too conservative.

## What landed

### `combineJoinKeys` (`planner/util/key-utils.ts`)

- New optional `equiPairs?: ReadonlyArray<{ left: number; right: number }>` parameter (column-index form).
- Branch table:
  - `inner` / `cross`: unchanged — union of both sides (right indices shifted).
  - `left`: returns `leftKeys` unchanged iff `equiPairs` cover any right-side unique key; else `[]`. Right keys never survive (NULL-padded right columns break uniqueness).
  - `right`: symmetric — returns `rightKeys` shifted iff `equiPairs` cover any left-side unique key; else `[]`.
  - `full`: `[]`.
  - `semi` / `anti`: returns `leftKeys` (left-only output, no null-padding).
- Helper `joinPairsCoverKey(keys, eqIndices)` factored out for readability.
- `joinType` parameter tightened from `string` to `JoinType`.
- Back-compat: omitting `equiPairs` makes LEFT/RIGHT return `[]`, matching the prior conservative behaviour.

### `analyzeJoinKeyCoverage` (`planner/util/key-utils.ts`)

- LEFT branch: when right-side key is covered, propagates left's physical `uniqueKeys` and caps `estimatedRows` at `leftRows`. Right-side keys are not propagated (null-padding violates them).
- RIGHT branch: symmetric.
- FULL: still returns empty (both sides can be null-padded).
- SEMI/ANTI: unchanged.
- INNER/CROSS: unchanged.

### Call sites

- `JoinNode.getType()` (`join-node.ts`): now extracts equi-pairs via `extractEquiPairsFromCondition` and passes them to `combineJoinKeys`.
- `BloomJoinNode.getType()` (`bloom-join-node.ts`): derives column-index pairs from `this.equiPairs` (attribute-id form) and passes them to `combineJoinKeys` — previously passed `[]` to `buildJoinRelationType`, dropping logical keys entirely.
- `MergeJoinNode.getType()` (`merge-join-node.ts`): same treatment.
- `JoinNode.computePhysical` and the physical nodes' `computePhysical` were already correct; no FD-propagation code changed.

### Deviation from the plan ticket (documented in the implement ticket)

The plan ticket's prescribed `combineJoinKeys` change for `'left'`/`'right'` (unconditionally propagate preserved-side keys) was unsound — a LEFT JOIN can still duplicate left-side rows when B has multiple matches per A-row. The implementation makes propagation conditional on equi-pair coverage of the other side's key, mirroring the physical-layer logic in `analyzeJoinKeyCoverage`.

## Use cases & validation

### Validated use cases

- `SELECT DISTINCT t.* FROM t LEFT JOIN u ON t.id = u.tid` where `u.tid` is `u`'s PK → DISTINCT eliminated above the LEFT JOIN.
- `LEFT JOIN` cardinality estimate is now bounded by left's row count when right's key is covered (instead of the previous heuristic fallback).
- LEFT JOIN with non-unique join columns (e.g. `t.v = u.v` where neither side is unique) correctly drops keys (no false propagation).
- LEFT JOIN preserves left-side FDs (e.g. PK `id → v`) by construction — left-side FDs only reference left columns, which retain their indices on the join output. (Existing `propagateJoinFds` left-branch was already correct.)
- BloomJoinNode / MergeJoinNode `getType().keys` now matches `JoinNode.getType().keys` (parity at the logical-type layer for both physical algorithms).

### Tests added

- `test/optimizer/keys-propagation.spec.ts` — new `Outer-join key propagation` describe block:
  - LEFT JOIN preserves left PK when right PK covered (physical `uniqueKeys` contains left's PK).
  - LEFT JOIN drops keys when right key NOT covered.
  - LEFT JOIN with right PK covered: `estimatedRows` is bounded by left cardinality.
  - DISTINCT eliminated above LEFT JOIN when right PK is covered.
  - `combineJoinKeys` unit tests: LEFT w/ coverage, LEFT w/o coverage, LEFT w/o equiPairs (back-compat), RIGHT w/ coverage, INNER union, SEMI passthrough, FULL → `[]`.
- `test/optimizer/fd-propagation.spec.ts` — existing `LEFT outer JOIN: right FDs and equi-pair FDs are dropped` test extended to assert left-side FDs survive (`{id} → {v}` on output cols `{0} → {1}`).

### Validation runs

- `yarn workspace @quereus/quereus run lint`: clean (exit 0).
- `yarn workspace @quereus/quereus run test`: **2803 passing, 2 pending**, no failures.

## Areas the reviewer should scrutinize

- Soundness of the LEFT/RIGHT key-survival rule: confirm that "equi-pairs cover any right-side unique key ⇒ each left row matches ≤ 1 right row ⇒ left keys survive" holds across all combinations of multi-column keys, composite equi-pair sets, and NULL-equality semantics. The implementation uses the same "any-key fully covered" check that `analyzeJoinKeyCoverage` has been using at the physical layer.
- `BloomJoinNode.getType()` / `MergeJoinNode.getType()` previously returned `[]` for `RelationType.keys`. Surfacing keys here is a tightening — downstream consumers that read logical keys (e.g. `rule-distinct-elimination` in the structural pass) will see more keys. Confirm no consumer assumed `[]` and would behave incorrectly with a populated keys list.
- LEFT JOIN `estimatedRows` reduction: assertion in the test is bounded (`≤ left cardinality`) rather than exact, because `tableSchema.estimatedRows` for in-test memory tables is not explicitly set. The reduction logic itself is unit-covered indirectly by `combineJoinKeys`.

## Out of scope

- FULL OUTER JOIN key inference (the "compound case" — both sides covered by equi-pairs that survive null-padding).
- Anti-join key refinement.
- Outer-join propagation for non-FD subtypes (e.g., approximate FDs).

## Documentation

- `docs/optimizer.md` § "Shared join key-coverage analysis": added per-join-type bullets for LEFT/RIGHT/FULL/SEMI/ANTI behaviour.
- `docs/optimizer.md` § "Key inference after projections / joins": rewrote `combineJoinKeys` description with the full branch table.

## Reviewer TODO

- Verify the `combineJoinKeys` branch table against soundness intuition for each join type.
- Spot-check that adding logical `keys` to `BloomJoinNode.getType()` / `MergeJoinNode.getType()` doesn't perturb any structural-pass rule unexpectedly. The rule-distinct-elimination case is exercised by the new test; survey other consumers of `RelationType.keys` for similar effects.
- Confirm no regression in the wider test suite (already green).
- Read `docs/optimizer.md` § "Shared join key-coverage analysis" and § "Key inference after projections / joins" for accuracy.
