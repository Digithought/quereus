description: Extract shared logic from JoinNode / BloomJoinNode / MergeJoinNode to reduce duplication
dependencies: none
files:
  packages/quereus/src/planner/nodes/join-node.ts
  packages/quereus/src/planner/nodes/bloom-join-node.ts
  packages/quereus/src/planner/nodes/merge-join-node.ts
  packages/quereus/src/planner/nodes/join-utils.ts       # NEW — shared plan-node utilities
  packages/quereus/src/runtime/emit/join.ts
  packages/quereus/src/runtime/emit/bloom-join.ts
  packages/quereus/src/runtime/emit/merge-join.ts
  packages/quereus/src/runtime/emit/join-output.ts       # NEW — shared emitter helper
----

## Context

The three join plan-node classes (`JoinNode`, `BloomJoinNode`, `MergeJoinNode`) and their emitters share large blocks of near-identical code. This ticket extracts shared logic into utility functions.

## Phase 1 — Plan-node utilities

Create `packages/quereus/src/planner/nodes/join-utils.ts` with three functions:

### `buildJoinAttributes(leftAttrs, rightAttrs, joinType, preserveAttributeIds?)`

Shared implementation of `buildAttributes()`:

```ts
export function buildJoinAttributes(
    leftAttrs: readonly Attribute[],
    rightAttrs: readonly Attribute[],
    joinType: JoinType,
    preserveAttributeIds?: readonly Attribute[],
): Attribute[] {
    if (preserveAttributeIds) return preserveAttributeIds.slice() as Attribute[];
    if (joinType === 'semi' || joinType === 'anti') return leftAttrs.slice() as Attribute[];

    const attributes: Attribute[] = [];
    for (const attr of leftAttrs) {
        const isNullable = joinType === 'right' || joinType === 'full';
        attributes.push(isNullable ? { ...attr, type: { ...attr.type, nullable: true } } : attr);
    }
    for (const attr of rightAttrs) {
        const isNullable = joinType === 'left' || joinType === 'full';
        attributes.push(isNullable ? { ...attr, type: { ...attr.type, nullable: true } } : attr);
    }
    return attributes;
}
```

JoinNode calls it without `preserveAttributeIds`. BloomJoinNode and MergeJoinNode pass their `preserveAttributeIds`.

### `buildJoinRelationType(leftType, rightType, joinType, keys?)`

Shared implementation of `getType()`:

```ts
export function buildJoinRelationType(
    leftType: RelationType,
    rightType: RelationType,
    joinType: JoinType,
    keys?: ReadonlyArray<ReadonlyArray<ColRef>>,
): RelationType
```

- Semi/anti → returns leftType shape
- Otherwise → combines columns with nullable marking, computes `isSet`, combines `rowConstraints`
- `keys` parameter: JoinNode passes `combineJoinKeys(...)`, BloomJoinNode/MergeJoinNode pass `[]`

### `estimateJoinRows(leftRows, rightRows, joinType)`

Shared `estimatedRows` logic — full switch covering cross/inner/left/right/full/semi/anti/default. This also **fixes** the missing `right`/`full` cases in BloomJoinNode and MergeJoinNode.

```ts
export function estimateJoinRows(
    leftRows: number | undefined,
    rightRows: number | undefined,
    joinType: JoinType,
): number | undefined
```

### Refactor each node class

- Replace the private `buildAttributes()` body with a call to `buildJoinAttributes()`
- Replace `getType()` body with a call to `buildJoinRelationType()`
- Replace `estimatedRows` getter body with a call to `estimateJoinRows()`

### Move `EquiJoinPair` to `join-utils.ts`

Currently `EquiJoinPair` lives in `bloom-join-node.ts` and is imported by `merge-join-node.ts`. Move it to `join-utils.ts` and re-export from `bloom-join-node.ts` to avoid breaking external imports:

```ts
// bloom-join-node.ts
export type { EquiJoinPair } from './join-utils.js';
```

Update `merge-join-node.ts` to import from `join-utils.js` directly.

## Phase 2 — Emitter output helper

Create `packages/quereus/src/runtime/emit/join-output.ts` with a helper for the post-match output pattern shared by all three emitters:

```ts
import type { Row } from '../../common/types.js';
import type { JoinType } from '../../planner/nodes/join-node.js';

/**
 * After scanning the right side for a given left row, determines what (if any)
 * row to yield for semi/anti/left join semantics.
 *
 * Returns the row to yield, or null if nothing should be yielded.
 * For LEFT JOIN unmatched rows, also sets the rightSlot to null padding.
 */
export function joinOutputRow(
    joinType: JoinType,
    matched: boolean,
    isSemiOrAnti: boolean,
    leftRow: Row,
    rightColCount: number,
    rightSlot: { set(row: Row): void },
): Row | null {
    if (isSemiOrAnti) {
        if ((joinType === 'semi' && matched) || (joinType === 'anti' && !matched)) {
            return leftRow;
        }
        return null;
    }
    if (!matched && joinType === 'left') {
        const nullPadding = new Array(rightColCount).fill(null) as Row;
        rightSlot.set(nullPadding);
        return [...leftRow, ...nullPadding] as Row;
    }
    return null;
}
```

Each emitter replaces its 7-line post-match block with:
```ts
const outputRow = joinOutputRow(plan.joinType, matched, isSemiOrAnti, leftRow, rightColCount, rightSlot);
if (outputRow) yield outputRow;
```

## Phase 3 — Validate

- Build passes (`yarn build`)
- All existing join tests pass (`yarn test`)
- Key test files: `test/logic/11-joins.sqllogic`, `test/logic/82-bloom-join.sqllogic`, `test/logic/83-merge-join.sqllogic`, `test/logic/08.1-semi-anti-join.sqllogic`

## Key test expectations (existing — no new tests needed, this is a pure refactor)

- Inner, left, semi, anti joins produce identical results before/after
- Bloom join and merge join sqllogic tests pass unchanged
- `test/optimizer/join-quickpick.spec.ts` and `test/optimizer/keys-propagation.spec.ts` pass unchanged

## TODO

### Phase 1 — Plan-node utilities
- Create `packages/quereus/src/planner/nodes/join-utils.ts` with `buildJoinAttributes`, `buildJoinRelationType`, `estimateJoinRows`
- Move `EquiJoinPair` to `join-utils.ts`; re-export from `bloom-join-node.ts`
- Refactor `JoinNode.buildAttributes()` / `getType()` / `estimatedRows` to use shared utils
- Refactor `BloomJoinNode.buildAttributes()` / `getType()` / `estimatedRows` to use shared utils
- Refactor `MergeJoinNode.buildAttributes()` / `getType()` / `estimatedRows` to use shared utils

### Phase 2 — Emitter output helper
- Create `packages/quereus/src/runtime/emit/join-output.ts` with `joinOutputRow`
- Refactor `emitLoopJoin` post-match block to use `joinOutputRow`
- Refactor `emitBloomJoin` post-match block to use `joinOutputRow`
- Refactor `emitMergeJoin` post-match block to use `joinOutputRow`

### Phase 3 — Validate
- `yarn build` passes
- `yarn test` passes (focus on join-related test files)
