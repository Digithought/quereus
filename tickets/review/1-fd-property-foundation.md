---
description: Review the functional-dependency foundation — new optional `fds` and `equivClasses` physical properties, propagation rules across all relational operators, and helper utilities (no consumers yet)
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts (new)
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/alias-node.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/set-operation-node.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts (new)
  - docs/architecture.md
  - docs/optimizer.md
---

## What landed

Added a first-class **functional dependency (FD)** property surface to every relational physical plan node, with **no consumers yet**. Existing `uniqueKeys` consumers (`rule-distinct-elimination`, `analyzeJoinKeyCoverage`, `CatalogStatsProvider.joinSelectivity`, change-detection classification) are unchanged.

### Data shape

`PhysicalProperties` (in `plan-node.ts`) now has two new optional fields alongside `uniqueKeys`:

```typescript
export interface FunctionalDependency {
  readonly determinants: readonly number[]; // empty = "constant"
  readonly dependents: readonly number[];   // non-empty
}

interface PhysicalProperties {
  // ...
  fds?: ReadonlyArray<FunctionalDependency>;
  equivClasses?: ReadonlyArray<ReadonlyArray<number>>;
}
```

Column indices are output-column indices, consistent with `uniqueKeys`. Superkeys imply `key → all-columns`; `fds` carries the additional dependencies. The list is non-canonical — consumers run `computeClosure` to derive what a set of attributes implies.

### Helpers (`packages/quereus/src/planner/util/fd-utils.ts`)

- `computeClosure(attrs, fds)` — iterative fixed-point.
- `determines(attrs, target, fds)` — closure-based check.
- `minimalCover(attrs, fds)` — greedy minimization.
- `mergeFds(a, b, opts?)`, `addFd(fds, next, opts?)` — subsumption-aware merge with cap enforcement (default `MAX_FDS_PER_NODE = 64`). Cap behavior drops FDs whose determinants are not a subset of any `uniqueKeys` entry; truncations logged at debug under `quereus:planner:fd`.
- `projectFds(fds, mapping)` — drop FDs that lose any determinant or dependent column.
- `shiftFds(fds, offset)` / `shiftEquivClasses(classes, offset)` — column index translation for joins.
- `mergeEquivClasses(a, b)` / `addEquivalence(classes, a, b)` — transitive-closure union of overlapping classes.
- `superkeyToFd(key, columnCount)` — build `key → others` from a superkey.
- `extractEqualityFds(predicate, attrIdToIndex)` — predicate walker used by `FilterNode` to extract `col = literal` → `∅ → col` and `col1 = col2` → bi-FDs + EC pair.

### Per-operator propagation

| Operator | Behavior |
| -------- | -------- |
| `TableReferenceNode` | Seed `key → others` for every declared key (PK + UNIQUE). |
| `SeqScanNode` / `IndexScanNode` / `IndexSeekNode` | Pass child FDs/ECs through unchanged. |
| `FilterNode` | Inherit child; add FDs/ECs from equality conjuncts (`col = literal`, `col1 = col2`). |
| `ProjectNode` / `ReturningNode` | Project FDs/ECs through the source→output mapping built from bare column-reference projections. |
| `AliasNode` / `DistinctNode` | Pass-through. |
| `AggregateNode` / `StreamAggregateNode` / `HashAggregateNode` | A source FD `X → Y` survives iff `X ∪ Y` are all column-reference GROUP BY columns; project to output indices. ECs project the same way. Shared helper `propagateAggregateFds` in `aggregate-node.ts`. |
| `JoinNode` / `BloomJoinNode` / `MergeJoinNode` | Inner/cross: union + equi-pair bi-FDs + EC merge. Left/right outer: keep preserved side only, no equi-pair FDs. Full outer: drop both. Semi/anti: keep left only. Shared helper `propagateJoinFds` in `join-utils.ts`. |
| `AsofScanNode` | Inherit left's FDs/ECs only — asof is at-most-one match + NULL-pad in outer mode; the asof condition is not an equality. |
| `SetOperationNode` | Conservative: drop FDs/ECs entirely. |
| `WindowNode` | Pass source FDs/ECs through unchanged. |

The physical access nodes (`SeqScanNode`, `IndexScanNode`, `IndexSeekNode`) were also updated to propagate FDs from their `TableReferenceNode` child — without this the FD on the leaf would be lost above the access path.

### Tests (`packages/quereus/test/optimizer/fd-propagation.spec.ts`)

41 tests organized in two top-level `describe` blocks:

- **`fd-utils` unit tests** — direct tests of each exported helper: `computeClosure` (incl. transitive and constants), `determines`, `minimalCover`, `mergeEquivClasses` (overlap union, disjoint classes, singleton drop), `addEquivalence`, `projectFds`, `addFd`/`mergeFds` (subsumption), `shiftFds` / `shiftEquivClasses`, `superkeyToFd`, and `extractEqualityFds` (constant-equality, column-equality, AND-decomposition, non-equality ignore).
- **Per-operator propagation tests** — use `query_plan(?)` to inspect the `physical` JSON of each operator: TableReference (PK + UNIQUE), Filter (`col = literal`, `col1 = col2`, non-equality ignored), Project (bare-column survives, expression drops), Alias, Distinct, aggregates (GROUP BY restriction), inner join (bi-FDs + EC merge), LEFT outer join (right + equi dropped), UNION ALL (no FDs), Window (pass-through).

## How to validate

```bash
yarn workspace @quereus/quereus run build     # passes
yarn workspace @quereus/quereus run lint      # passes
yarn test                                     # passes (2754 + 41 new = 2795 total)
```

Skipped `yarn test:store` — this ticket adds physical-property metadata only; no execution-path changes.

## Use cases for validation

- **Verify backwards compatibility:** existing `uniqueKeys` tests in `keys-propagation.spec.ts` and `ordering-propagation.spec.ts` still pass — no consumer migrates yet.
- **Inspect FDs/ECs via `query_plan`:** the `physical` column now exposes `fds` and `equivClasses` as JSON arrays. For a query like `SELECT * FROM t WHERE a = b`, expect `fds` containing `{determinants: [a], dependents: [b]}` + the reverse, and `equivClasses` containing `[a, b]`.
- **Confirm cap behavior:** create a wide table with many UNIQUE constraints to push FD count up; verify that `quereus:planner:fd` debug log fires and the per-node list stays at ≤ 64.
- **Confirm closure semantics:** `computeClosure({a}, [{a→b}, {b→c}])` should return `{a, b, c}` (covered by unit test).

## Reviewer focus

1. **`fd-utils.ts`:** correctness of `computeClosure` fixed-point, `addFd` subsumption rules, cap enforcement, and the `extractEqualityFds` predicate walker (especially the literal-only constant check — parameters/subqueries intentionally excluded).
2. **Join propagation (`join-utils.ts`):** the outer-join rule drops right's FDs and equi-pair FDs as specified, full outer drops both sides.
3. **Aggregate propagation:** verify the column-mapping path drops non-trivial GROUP BY expressions correctly.
4. **No semantic drift:** existing `uniqueKeys` / `ordering` / `monotonicOn` propagation should be byte-identical to pre-change for every operator.
5. **Docs:** propagation table in `docs/optimizer.md` matches the actual implementation.

## Out of scope (deferred — follow-up tickets per plan)

- Migration of `uniqueKeys` consumers to read `fds`.
- Injective-expression projection FDs.
- FK→PK derived FDs on the child side of a join.
- Outer-join key-preservation refinements beyond the conservative rule.
- All "consumer" tickets (groupby simplification, orderby pruning, join elimination, predicate inference through ECs, change-detection FD classification, view maintenance with FD binding keys).
