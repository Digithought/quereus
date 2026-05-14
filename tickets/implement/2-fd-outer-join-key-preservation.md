---
description: Refine outer-join key and FD propagation so the preserved side's keys/FDs survive when equi-pairs cover the other side's unique key
prereq: fd-property-foundation
files:
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/test/optimizer/keys-propagation.spec.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts
  - docs/optimizer.md
---

## Motivation

`combineJoinKeys` and `analyzeJoinKeyCoverage` in `planner/util/key-utils.ts` currently bail to `[]` for any join type other than `inner`/`cross`. The conservative floor is sound but too coarse for outer joins.

Sound refinement (LEFT / RIGHT outer):
- LEFT JOIN A,B preserves A's unique keys on the output **iff** the equi-pairs cover a unique key on B (each A-row matches ≤ 1 B-row, so no row duplication). Then `estimatedRows ≤ leftRows`.
- RIGHT JOIN is symmetric.
- FULL OUTER: neither side preserved; out of scope.
- Preserved-side FDs over preserved-side columns always survive (null padding only affects the other side's columns). `propagateJoinFds` already does this correctly for `left`/`right`; no FD code change required.

### Deviation from the plan ticket

The plan ticket's prescribed `combineJoinKeys` change for `'left'`/`'right'` ("unconditionally propagate preserved-side keys") is **unsound**: without equi-pair-coverage info, a LEFT JOIN can still duplicate left-side rows when B has multiple matches per A-row. `A LEFT JOIN B` with `B = {(1,x),(1,y)}` and `A = {1}` produces two rows with the same A-key.

Therefore this implementation **plumbs equi-pair info into `combineJoinKeys`** so the propagation can be made conditional on coverage at the logical-type layer — matching `analyzeJoinKeyCoverage`'s physical-layer logic. This preserves soundness while enabling the plan's downstream optimization use-cases (DISTINCT elimination above LEFT JOIN with right-PK covered, etc.). The plan's `propagateJoinFds` recommendation is already implemented; no change there.

## Architecture

### `combineJoinKeys` — new optional `equiPairs` parameter

```typescript
export function combineJoinKeys(
  leftKeys: ReadonlyArray<ReadonlyArray<ColRef>>,
  rightKeys: ReadonlyArray<ReadonlyArray<ColRef>>,
  joinType: JoinType,
  leftColumnCount: number,
  equiPairs?: ReadonlyArray<{ left: number; right: number }>,
): ColRef[][]
```

Branch table:
- `'inner' | 'cross'`: existing union (left keys + right keys shifted).
- `'left'`: if `equiPairs` cover **any** right-side unique key (i.e. some right key's columns are all in `equiPairs.map(p => p.right)`), return `leftKeys` unchanged. Otherwise `[]`.
- `'right'`: symmetric — if `equiPairs` cover any left-side unique key, return `rightKeys` shifted by `leftColumnCount`. Otherwise `[]`.
- `'full'`: `[]`.
- `'semi' | 'anti'`: return `leftKeys` unchanged (left-only output; null-padding doesn't apply because non-matching left rows are dropped/kept as-is, not padded). This is a tightening; current code returns `[]` for these but `buildJoinRelationType` bypasses `combineJoinKeys` for semi/anti via the shortcut path, so this isn't user-visible in practice — kept for `combineJoinKeys` API soundness.

Extract a small predicate helper (file-local) to test coverage:
```typescript
function joinPairsCoverKey(
  keys: ReadonlyArray<ReadonlyArray<{ index: number }>>,
  eqIndices: Set<number>,
): boolean {
  return keys.some(k => k.length > 0 && k.every(c => eqIndices.has(c.index)));
}
```

### `analyzeJoinKeyCoverage` — extend for LEFT / RIGHT

Currently:
```typescript
if (joinType !== 'inner' && joinType !== 'cross') {
  return { leftKeyCovered: false, rightKeyCovered: false, uniqueKeys: undefined, estimatedRows: undefined };
}
```

After (semi/anti shortcut stays as-is; full still returns the empty result):

- `'left'`: build `rightEqSet = new Set(equiPairs.map(p => p.right))`. If `coversKey(rightType?.keys, rightEqSet) || coversPhysicalKey(rightPhys, rightEqSet)` then:
  - `rightKeyCovered = true`, `leftKeyCovered = false`
  - `uniqueKeys = leftPhys?.uniqueKeys` (left's physical keys survive; indices already 0..leftColumnCount-1)
  - `estimatedRows = leftRows`
- `'right'`: symmetric — if left key covered, propagate right's physical keys shifted by `leftColumnCount`, cap at `rightRows`.
- `'full'`: unchanged (returns empty result).

The internal `coversKey` / `coversPhysicalKey` helpers can be reused as-is.

### Callsite updates

- **`JoinNode.computePhysical`** (`planner/nodes/join-node.ts`): already passes `pairs` to `analyzeJoinKeyCoverage` — no change. Already calls `propagateJoinFds` — no change.
- **`JoinNode.getType`**: extract equi-pairs from `condition` (use existing `extractEquiPairsFromCondition` with `this.left.getAttributes()` / `this.right.getAttributes()`) and pass them as the new `equiPairs` argument to `combineJoinKeys`.
- **`BloomJoinNode.getType`** / **`MergeJoinNode.getType`**: currently call `buildJoinRelationType(..., [])`. These have `this.equiPairs` already in attribute-id form. Convert to column indices via the same pattern used in `computePhysical` and pass to `combineJoinKeys` (along with the source keys). This brings physical nodes' logical `RelationType.keys` to parity with `JoinNode`.

### `propagateJoinFds` — no change

The existing `left`/`right` branches preserve preserved-side FDs/ECs/bindings and drop the other side's. Left-side FDs by construction only reference left columns (which retain their indices on the join output), so the soundness condition "drop FDs whose dependents reference null-padded columns" is automatically satisfied — no fanning out is needed.

### Interaction with consumers

- `rule-distinct-elimination` (`rules/distinct/rule-distinct-elimination.ts:36`) checks both `physical.uniqueKeys` and `RelationType.keys`. The rule runs in the Structural pass (before physical selection populates join `uniqueKeys`), so the **logical-type** propagation in `combineJoinKeys` is the critical surface for "DISTINCT eliminated above LEFT JOIN with right PK covered".
- `CatalogStatsProvider.joinSelectivity`, `rule-quickpick-enumeration`, and the constraint extractor's row-specific classification all currently read physical `uniqueKeys` — they benefit from the `analyzeJoinKeyCoverage` extension automatically.

## Use cases enabled

- `SELECT DISTINCT t.* FROM t LEFT JOIN u ON t.id = u.tid` where `u.tid` is unique on `u`: DISTINCT is eliminated.
- `LEFT JOIN` cardinality estimates tighten to `leftRows` when right's key is covered (vs. the previous `leftRows * rightRows * heuristic`-style fallback).
- Parent joins above a `LEFT JOIN` with right-key-covered can be planned as merge/hash on the preserved side's key (downstream physical key now visible).

## Tests

### keys-propagation.spec.ts

- `LEFT JOIN preserves left PK when right PK covered` — `SELECT * FROM t LEFT JOIN u ON t.id = u.tid` where both have PKs on the join columns. Assert `RelationType.keys` (via `query_plan` props) contains a key over left's PK column.
- `LEFT JOIN drops keys when right PK not covered` — `SELECT * FROM t LEFT JOIN u ON t.v = u.v` where `t.v`/`u.v` are non-unique. Assert no logical key surfaces.
- `RIGHT JOIN preserves right PK when left PK covered` — symmetric.
- `FULL OUTER JOIN drops both sides' keys` — assert empty keys.
- `DISTINCT elimination above LEFT JOIN` — `SELECT DISTINCT t.* FROM t LEFT JOIN u ON t.id = u.tid` with `u.tid` UNIQUE: Distinct node not present in the plan.
- `Cardinality estimate: LEFT JOIN with right PK covered shows estimatedRows = leftRows` — `query_plan` `physical.estimatedRows` on the join node equals left child's row count.

### fd-propagation.spec.ts (existing test extended)

The current `LEFT outer JOIN: right FDs and equi-pair FDs are dropped` test asserts the right-side / cross-side FDs are gone. Add an assertion that left-side FDs (`{0} → {1}` for `lo.id → lo.v`) survive:
```typescript
expect(fdHas(joinProps!.fds, [0], [1])).to.equal(true);
```

### Unit test for combineJoinKeys (new, in keys-propagation.spec.ts unit section)

- `combineJoinKeys` with `LEFT` + equiPairs covering right's key → returns left keys.
- `combineJoinKeys` with `LEFT` + equiPairs NOT covering right's key → returns `[]`.
- `combineJoinKeys` with `LEFT` + no equiPairs argument → returns `[]` (back-compat).

## Documentation

- **docs/optimizer.md** § "Key inference after projections / joins" (line 1188): describe LEFT/RIGHT outer refinement and the equi-pair-coverage requirement.
- **docs/optimizer.md** § "Shared join key-coverage analysis" (line 1172): add LEFT/RIGHT cases.
- In-line API comments on `combineJoinKeys` and `analyzeJoinKeyCoverage` in `key-utils.ts`.
- No `docs/architecture.md` change.

## Out of scope

- FULL OUTER JOIN key inference (the "compound case" — both sides covered by equi-pairs).
- Anti-join key refinement (current behavior is already correct).
- Outer-join propagation for more exotic FD subtypes (e.g., approximate FDs).

## TODO

Phase 1 — Core inference

- Add `equiPairs` parameter to `combineJoinKeys` (default undefined for back-compat). Implement LEFT/RIGHT branches with coverage check; keep FULL → `[]`; tighten SEMI/ANTI to return left keys.
- Extend `analyzeJoinKeyCoverage` for LEFT/RIGHT — propagate preserved-side `uniqueKeys` and cap `estimatedRows` when other-side key is covered.

Phase 2 — Call sites

- Update `JoinNode.getType()` to extract equi-pairs and pass to `combineJoinKeys`.
- Update `BloomJoinNode.getType()` and `MergeJoinNode.getType()` to derive column-index equi-pairs from `this.equiPairs` (attribute-id form) and pass to `combineJoinKeys`.

Phase 3 — Tests & docs

- Extend `keys-propagation.spec.ts` with the LEFT/RIGHT/FULL cases listed above (including DISTINCT elimination and `estimatedRows` checks).
- Extend the existing `LEFT outer JOIN` test in `fd-propagation.spec.ts` to assert left-side FDs survive.
- Add unit tests for `combineJoinKeys` with/without `equiPairs`.
- Update `docs/optimizer.md` § "Key inference after projections / joins" and § "Shared join key-coverage analysis".

Phase 4 — Validation

- `yarn workspace @quereus/quereus run lint`
- `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/quereus-test.log` and confirm clean.
