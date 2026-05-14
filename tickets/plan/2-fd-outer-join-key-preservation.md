---
description: Refine outer-join key and FD propagation so the preserved side's keys/FDs survive (today we conservatively clear them)
prereq: fd-property-foundation
files:
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/test/optimizer/keys-propagation.spec.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts
  - docs/optimizer.md
---

## Motivation

`combineJoinKeys` in `planner/util/key-utils.ts:37` returns `[]` for any join type other than inner/cross. Comment: "outer joins conservatively clear keys" — because null-padded rows can break the assumption that a key column is non-null and unique.

That's a correct safety floor but it's too conservative. Two refinements are sound:

1. **Preserved-side keys survive on the join output.** In `A LEFT JOIN B`, every emitted row carries an unmodified copy of `A`'s columns. If `A` had key `K`, the join output is still unique on `K` — null-padding only affects `B`'s columns. The current code drops `A`'s keys for no good reason.

2. **Preserved-side FDs survive on the preserved side's columns.** Same logic: A's FDs over A's columns are preserved row-for-row. B-side FDs are not preserved (a null-padded row violates them).

3. **Bi-directional case**: a FULL OUTER JOIN preserves neither side's keys directly. But there's a third compound case — when the join condition covers a unique key on both sides, the FULL OUTER JOIN output is still bounded in cardinality. Not pursued here.

This ticket fixes (1) and (2) for LEFT/RIGHT outer joins. (3) is deferred.

## Architecture

### Updated `combineJoinKeys` signature

Today's signature:

```typescript
function combineJoinKeys(
  leftKeys: ReadonlyArray<ReadonlyArray<ColRef>>,
  rightKeys: ReadonlyArray<ReadonlyArray<ColRef>>,
  joinType: string,
  leftColumnCount: number,
): ColRef[][]
```

Becomes:

```typescript
function combineJoinKeys(
  leftKeys: ReadonlyArray<ReadonlyArray<ColRef>>,
  rightKeys: ReadonlyArray<ReadonlyArray<ColRef>>,
  joinType: JoinType,
  leftColumnCount: number,
): ColRef[][] {
  switch (joinType) {
    case 'inner':
    case 'cross':
      return /* existing union */;
    case 'left':
      // Preserved side: left. Right-side keys lose validity on null-padded rows.
      return leftKeys.map(k => k.map(c => ({ index: c.index, desc: c.desc })));
    case 'right':
      return rightKeys.map(k => k.map(c => ({ index: c.index + leftColumnCount, desc: c.desc })));
    case 'full':
      return [];
    case 'semi':
    case 'anti':
      return /* existing: left keys only */;
  }
}
```

### `analyzeJoinKeyCoverage` for outer joins

The existing function (`key-utils.ts:76`) hard-codes:

```typescript
if (joinType !== 'inner' && joinType !== 'cross') {
  return { leftKeyCovered: false, rightKeyCovered: false, uniqueKeys: undefined, estimatedRows: undefined };
}
```

For LEFT/RIGHT, refine:

- **LEFT JOIN**: preserved side is left. `leftKeyCovered` reasoning is moot (would only matter for cardinality reduction). `rightKeyCovered` is the relevant case — if equi-join covers a unique key on the right, then each left row matches at most one right row, so the join output is exactly one row per left row. Result: preserve **left** keys, cap `estimatedRows = leftRows`.
- **RIGHT JOIN**: symmetric.
- **FULL OUTER JOIN**: no key coverage logic applies — both sides can be null-padded.

### FD propagation for outer joins

Per the `fd-property-foundation` table:

- LEFT JOIN: every FD from the left side's `fds` where determinants and dependents are all left-side columns ⇒ survives unchanged on the join output. Right-side FDs are dropped because null padding on the right violates them. The equi-join condition does **not** produce an EC on the join output (null vs non-null isn't equal).
- RIGHT JOIN: symmetric.
- FULL OUTER: no FDs preserved.

A subtle case worth getting right: a left-side FD `X → Y` where `Y` includes a right-side column. The right-side column is null on padded rows, so it's not actually functionally determined by `X`. **Drop FDs whose dependents reference null-padded columns.**

### Interaction with `coveredKeysByTable`

`analyzeRowSpecific` and the assertion delta pipeline classify table references as row-specific when a covered key is found in the predicate path. Today, an outer-join branch causes the right-side table to be classified `global` regardless of its predicate. With this refinement, the right-side reference can still be `row` if its predicate covers a key on it — the null-padding only affects join output, not the right-side scan. That's the existing behavior and we don't need to touch it. We're only refining the *combined* join output's keys/FDs.

## Use cases enabled

- DISTINCT elimination above LEFT OUTER JOIN where the left side is unique: `SELECT DISTINCT t.* FROM t LEFT JOIN u ON ...` no longer needs the DISTINCT.
- Cardinality estimates tighten for `LEFT JOIN` with right-side unique key covered.
- Downstream join planning sees that the LEFT JOIN preserves left's key, enabling merge-join recognition on parent joins where the left side's key participates.

## Tests

- `keys-propagation.spec.ts`: add cases for `LEFT JOIN` preserving left PK, `RIGHT JOIN` preserving right PK, `FULL OUTER JOIN` dropping both.
- Add a SQL logic test asserting that a `DISTINCT t.*` above a `LEFT JOIN` is eliminated when `t.pk` is in the projection.
- Cardinality test: `LEFT JOIN` with right-side PK covered shows `estimatedRows = leftRows` (or similar) in `query_plan()` output.
- Negative test: `LEFT JOIN` with neither side's key covered does NOT propagate keys.

## Documentation

- **docs/optimizer.md** — update the "Key inference after projections / joins" subsection to describe the outer-join refinement. Update the `combineJoinKeys` and `analyzeJoinKeyCoverage` API comments in-line.
- No `docs/architecture.md` change required.

## Out of scope

- FULL OUTER JOIN key inference (case 3 above) — deferred to a follow-up.
- Anti-join key handling refinement — current behavior (left keys only) is already correct.
