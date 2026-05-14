---
description: Optimizer rule that drops trailing ORDER BY keys functionally determined by leading keys
files:
  - packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts (new)
  - packages/quereus/src/planner/rules/sort/ (new folder)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/nodes/sort.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts (new)
  - packages/quereus/test/logic/04-order-by.sqllogic
  - docs/optimizer.md
---

## What to build

A Structural-pass rule `ruleOrderByFdPruning` over `SortNode`. For a sort with
≥ 2 keys, walk the keys front-to-back maintaining `determined = closure({leading bare-column attrIds}, fds, ECs)`.
Drop any trailing key whose expression is a bare `ColumnReferenceNode` and
whose attrId is already in `determined`. If any keys are dropped, return a
new `SortNode` via `withSortKeys` (or a fresh `SortNode` constructor) with
the surviving keys; otherwise return `null`.

Keys whose expression is not a bare `ColumnReferenceNode` are not droppable
(but the rule must still walk past them, treating them as opaque — they
neither contribute to nor consume the determined set, since FDs are over
column attribute ids). NULL handling and direction are non-issues per the
plan ticket (see Motivation/NULL handling sections of the source plan).

### Reasoning space

The FDs and ECs live on `node.source.physical`, expressed in source-attribute
space. Sort preserves attributes (it's a `UnaryRelationalNode` and
`getAttributes()` is its source's), so attribute IDs match without remapping.
Use `expandEcsToFds` from the GROUP BY rule pattern (lift it to
`packages/quereus/src/planner/util/fd-utils.ts` so both rules share it — the
GROUP BY rule currently has its own private copy; promote it and update the
caller). Reuse `computeClosure` from `fd-utils.ts`.

**Caveat — closure is index-based, not attrId-based.** `computeClosure` and
the existing FD machinery operate on numeric "indices" — for `AggregateNode`
output FDs those are output column indices; for source-level FDs on a
relational node they are the indices of the node's attributes (see
`propagateAggregateFds` and friends in `physical-utils.ts`). For SortNode,
`fds`/`equivClasses` from `node.source.physical` are in *source-attribute-index*
space (positions in `source.getAttributes()`), NOT attribute IDs. The
implementer must convert each sort-key's `ColumnReferenceNode.attributeId`
to its source-attribute index via
`source.getAttributes().findIndex(a => a.id === attrId)` before feeding it
to the closure. Mirror exactly how `sort.ts`'s `computePhysical` does
`leadIdx` lookup at lines 86–87.

### Registration

Register in `optimizer.ts` at Structural pass, priority just after
`groupby-fd-simplification` (23) — pick 26 (after `subquery-decorrelation`
at 25, since this rule is independent of those; ordering across these
Structural priorities is not load-bearing for this rule). Confirm by
inspection that nothing in Structural depends on SortNode shape changing
later in the pass; if anything does, slot accordingly.

Crucially: **must run before `monotonic-limit-pushdown` (PostOptimization
priority 8)** so single-key reductions can enable the pushdown. That ordering
is automatic since Structural runs before PostOptimization.

### Sort-key matcher subtlety

The plan ticket's note about "skipping" non-trivial expressions deserves
a concrete rule. Adopt this semantics: a leading non-bare-column key
**still contributes nothing to `determined`** (we can't prove what expression
values "determine" without expression-FDs). Trailing non-bare-column keys
likewise cannot be dropped. Walk all keys, but only bare-column keys
participate in both directions of the FD reasoning. Document this in the
rule's leading comment.

### Watch-outs

- Honour the `>= 2 sort keys` guard.
- If after pruning the survivor count is 0, that should be impossible (the
  first key never gets dropped — its attrId starts outside `determined`).
  Defensive-check and return `null` rather than emitting a 0-key SortNode.
- Preserve `direction` and `nulls` for each surviving key.
- Don't eliminate the SortNode entirely (out of scope per plan).
- Adopt the same logger style as the GROUP BY rule
  (`createLogger('optimizer:rule:orderby-fd-pruning')`) and log dropped key
  count.

## Tests

- `packages/quereus/test/optimizer/rule-orderby-fd-pruning.spec.ts` (new):
  - PK-driven: `ORDER BY pk, name` over `pk PRIMARY KEY` → `ORDER BY pk`.
  - EC-driven: `SELECT … FROM t WHERE a = b ORDER BY a, b` → `ORDER BY a`.
  - No-FD baseline: `ORDER BY a, b` over independent cols → unchanged.
  - Expression key: `ORDER BY pk, name || 'x'` → unchanged (non-bare key).
  - Three-key partial drop: `ORDER BY pk, name, email` over `pk PK` → `ORDER BY pk`.
  - Mixed: `ORDER BY a, b DESC` where `a → b` → `ORDER BY a` (direction
    irrelevance).
  - Direction-mixed-leading: `ORDER BY a DESC, b ASC` where `a → b` → `ORDER BY a DESC`.
  - Single-key: `ORDER BY a` — no-op even if `a` determines other unselected cols.
  - Attribute IDs preserved (rule doesn't mutate attributes — sort doesn't own them — but assert
    against `source.getAttributes()` identity).
- `packages/quereus/test/logic/04-order-by.sqllogic`: append two cases
  (PK-driven and `WHERE a = b`-driven) asserting result rows match the
  pre-pruned reference output.
- Interaction smoke (in the optimizer spec): build a plan
  `LimitOffset(Sort(MonotonicLeaf, [leafKey, otherKey]))` where the leaf's PK
  determines `otherKey`. After full optimization, assert the plan contains
  an `OrdinalSlice` (i.e., `monotonic-limit-pushdown` fired after this rule
  pruned).

## TODO

- Read `rule-groupby-fd-simplification.ts` and `fd-utils.ts` to align on
  `expandEcsToFds`/`computeClosure` usage.
- Promote `expandEcsToFds` from the aggregate rule into `fd-utils.ts` and
  update the aggregate rule to import it; verify the existing aggregate
  rule tests still pass.
- Create `packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts`.
- Register the rule in `optimizer.ts` (Structural pass, priority 26).
- Verify ordering against other Structural rules.
- Add unit tests under `test/optimizer/rule-orderby-fd-pruning.spec.ts`.
- Append PK-driven and EC-driven cases to `test/logic/04-order-by.sqllogic`.
- Add an interaction case asserting `monotonic-limit-pushdown` fires after
  pruning reduces a multi-key sort to a leaf-monotonic single-key sort.
- Update `docs/optimizer.md` rule catalog; cross-link from the LIMIT/OFFSET
  pushdown section.
- Run `yarn workspace @quereus/quereus run lint` and
  `yarn workspace @quereus/quereus run test`.
- Hand off to review with a summary of the new rule, the
  `expandEcsToFds` lift, anywhere existing tests churned (golden-plan
  fixtures asserting multi-key sorts are likely candidates — re-check
  any `04-order-by` / monotonic-limit-pushdown plan goldens).
