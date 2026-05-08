---
description: Review the MonotonicOn(attrId) plan characteristic — type, PhysicalProperties field, helpers, and propagation rules across the relational node set
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/framework/physical-utils.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/distinct-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/alias-node.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/test/optimizer/monotonic-on.spec.ts
---

## What landed

Added `MonotonicOnInfo` as a first-class plan characteristic on `PhysicalProperties`,
plus a propagation layer carrying it through the relational node set. The leaf-side
advertisement (vtab access plans) is the companion ticket
`1-bestaccessplan-monotonic-ordering`; this ticket only installs the carrier and the
propagation logic above the leaves. The Sort node serves as the in-tree establishment
point so the property is testable end-to-end without the leaf-side ticket having
landed.

### Carrier (Phase 1)

- New interface `MonotonicOnInfo { attrId: number; strict: boolean; direction: 'asc'|'desc' }`
  exported from `plan-node.ts` and added as `monotonicOn?: readonly MonotonicOnInfo[]`
  on `PhysicalProperties`. Strictly implies `ordering`; nodes may populate either.
- `PlanNodeCharacteristics.getMonotonicOn(node)` and `.isMonotonicOn(node, attrId)`
  accessors mirror the existing `ordering` ones.
- Three helpers in `framework/physical-utils.ts`:
  - `projectMonotonicOnByAttrId(monotonicOn, preservedAttrIds)`
  - `intersectMonotonicOn(left, right)`
  - `deriveOrderingFromMonotonicOn(monotonicOn, attrs)`
- EXPLAIN serialization is automatic (the existing `safeJsonStringify(node.physical)`
  in `func/builtins/explain.ts` picks up the new field).

### Propagation (Phase 2)

| Node | Rule applied |
| --- | --- |
| `Sort` | Establishes monotonicOn on the leading sort key when it is a trivial ColumnReference. Strict iff source.uniqueKeys contains `[<that-column-index>]`. Direction comes from the sort key. |
| `Distinct` | Strengthens source's monotonicOn entries to `strict: true`. Does not establish on its own. |
| `Filter` | Preserves source's monotonicOn unchanged. |
| `LimitOffset` | Preserves. |
| `Project` | Filters source's monotonicOn to attrIds preserved as trivial ColumnReferences in the projection. Drops on any non-trivial expression (per the ticket's note about the future `4-expression-properties-injective-monotone` work). |
| `Alias` | Preserves (attribute IDs are stable across alias). |
| `JoinNode` | New helper `propagateJoinMonotonicOn` in `join-utils.ts`. Cross/full → drop. Semi/anti → preserve left. Inner/left/right: for each equi-pair `(l.X, r.X)` where both inputs have matching-direction monotonicOn on their X, the non-null-extended side(s) propagate that attrId with strictness = `l.strict ∧ r.strict`. |
| `MergeJoin` | Same helper. The merge-join semantics physically guarantee what the helper produces. |
| `SetOperation` | Adds an explicit `computePhysical` returning `monotonicOn: undefined` with an inline TODO comment for the deferred UNION-ALL-with-disjoint-X-ranges special case. |
| `HashAggregate`, `StreamAggregate` | Explicit `monotonicOn: undefined` (the grouped relation is a set). |
| `WindowFunction` | Adds a new `computePhysical` that preserves source's monotonicOn (within a partition the row order is preserved). Previously the node had no `computePhysical` override at all. |

Anything else (bloom-join, hash-join, table-access, etc.) defaults to dropping
because they don't include `monotonicOn` in their `computePhysical` return.

### Test surface (Phase 3)

`packages/quereus/test/optimizer/monotonic-on.spec.ts`, 16 cases covering:

- Sort establishment (strict vs non-strict, direction).
- Distinct strengthens to strict.
- Filter / LimitOffset / Alias preserve.
- Project preserves attrId-stable; drops on attrId removed; drops on non-trivial expression.
- Inner join on monotonic equi-pair propagates with strict-AND.
- Cross join drops.
- UNION / UNION ALL drop.
- GROUP BY drops.
- Window preserves source.
- EXPLAIN's `physical` JSON column contains `"monotonicOn"` when set.

A few notes on the tests so a reviewer can rerun the same scenarios:

- The strict-Sort test uses `ORDER BY id DESC` on a PK so the ascending PK index
  doesn't elide the Sort. Direct `ORDER BY id` collapses to an `IndexScan`.
- The non-strict tests use a memory table `nu (k INTEGER PRIMARY KEY, x INTEGER)`,
  ordering on `x`. The PK is on `k`, so the Sort survives and source uniqueKeys
  don't cover the sorted column.
- The Filter test wraps the inner SELECT in `LIMIT 100` to block predicate pushdown,
  keeping the FilterNode above the Sort in the final plan.
- The inner-join test uses two non-unique columns on each side, and verifies the
  output attrIds are propagated with `strict: false` on both.

## How to validate

- `cd packages/quereus && npx mocha "test/optimizer/monotonic-on.spec.ts"` — the
  16 new cases.
- `yarn test` from repo root — full suite (2542 passing, 2 pending) was green.
- `cd packages/quereus && yarn lint` — clean.
- `yarn build` from repo root — clean (full monorepo).

## Review focus areas

- The join propagation lives in `propagateJoinMonotonicOn` (`join-utils.ts`).
  Worth a careful read against the ticket's outer-join NULL-extension rule and the
  semi/anti-from-left rule. The helper is shared between `JoinNode.computePhysical`
  (logical) and `MergeJoinNode.computePhysical` (physical) — same algorithm, both
  call sites.
- `JoinNode` already had `extractEquiPairsFromCondition` returning *column-index*
  pairs; the new code maps them to attribute-id pairs using `leftAttrs[p.left].id`
  / `rightAttrs[p.right].id`. The ID stability assumption matches what the rest
  of the file already relies on for unique-key analysis.
- `Sort.computePhysical` checks for `uniqueKeys` of length 1 with the sorted column
  index — multi-column unique keys do not produce strict monotonicity for a
  single-column sort, per the ticket's spec.
- `Project.computePhysical` adds `preservedAttrIds` collection inside the
  existing forEach over projections. The set captures attrIds emitted via
  `ColumnReferenceNode`, exactly the "trivial column reference" condition.
- `WindowNode` had no `computePhysical` before; the new one also restores
  `ordering` and `uniqueKeys` propagation from the source, which a reviewer may
  want to spot-check against the existing window-function tests.

## Deferred / out-of-scope (already documented in code)

- UNION ALL with disjoint X-ranges → can preserve `MonotonicOn(X)`. Inline TODO
  in `set-operation-node.ts`.
- Project through injective/monotone expressions → blocked on the
  `4-expression-properties-injective-monotone` work; current code drops on any
  non-trivial expression.
- Vtab access-plan advertisement → `1-bestaccessplan-monotonic-ordering`. Until
  it lands, leaf-monotonicity tests use Sort as the establishment point.
