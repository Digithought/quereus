---
description: Review IND-aware existence-folding rewrites — anti-join-to-empty, semi-join trivial, and FK-covered aggregate-over-join elimination — that exploit `child.fk ⊆ parent.pk` to drop parent-side access for EXISTS / NOT EXISTS / count(*) shapes.
files:
  - packages/quereus/src/planner/util/ind-utils.ts (new)
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts (new)
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts (new)
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts (refactored — extracted `lookupCoveringFK`/`isRowPreservingPathToTable` to ind-utils; added `ruleJoinEliminationUnderAggregate` entrypoint; `isAndOfColumnEqualities` exported for reuse)
  - packages/quereus/src/planner/optimizer.ts (registered three new rule handles at Structural priority 26)
  - packages/quereus/test/optimizer/ind-existence.spec.ts (new — 10 tests)
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts (one existing test relaxed — SEMI/ANTI portion now uses non-FK schema since the new rules legitimately fold the FK case)
  - docs/optimizer.md (new "Inclusion-dependency reasoning" subsection added at the end of "FK→PK inference" block)
---

## What was built

Three new Structural-pass rules at priority 26 (after `subquery-decorrelation` at 25). All three share `planner/util/ind-utils.ts`, which exports:
- `lookupCoveringFK(child, parent, childEquiCols, parentEquiCols)` — returns `{ fk, nullable }` if the equi-pairs match a declared FK on `child` referencing `parent`'s PK (in some column permutation); `nullable` is true iff any FK child column is nullable. Mirrors `checkFkPkAlignment` from `key-utils.ts` but returns the matched FK so callers can inspect nullability.
- `isRowPreservingPathToTable(node)` — true when the relational subtree is a chain of wrappers (`TableReference`, bare-source `Retrieve`, `Alias`, `Sort`) that preserves the underlying table's full row set. Required for any IND fold whose correctness depends on the parent side being unfiltered.
- `tableSchemaOf(node)` — thin wrapper over `extractTableSchema` from `key-utils.ts`, exported under an IND-rules-friendly name so call sites avoid pulling key-coverage internals.

`isAndOfColumnEqualities` was promoted to `export` from `rule-join-elimination.ts` and reused by the two new rules (instead of relocating it; both old and new rules use it, and pulling it out would have created a small redundant file).

### Rules

1. **`rule-anti-join-fk-empty`** (`rules/subquery/rule-anti-join-fk-empty.ts`, on `PlanNodeType.Join`):
   - Pattern: `AntiJoin(L, R, p)` with `p` an AND-of-column-equalities, FK coverage on L→R, every FK col `notNull`, R row-preserving.
   - Rewrite: `Filter(L, LiteralNode(false))`. (See "Known gap" below.)
2. **`rule-semi-join-fk-trivial`** (`rules/subquery/rule-semi-join-fk-trivial.ts`, on `PlanNodeType.Join`):
   - Pattern: `SemiJoin(L, R, p)` with the same checks but FK may be nullable.
   - Rewrite (non-null FK): replace the join with `L`.
   - Rewrite (nullable FK): `Filter(L, fk_col IS NOT NULL AND …)`.
3. **`ruleJoinEliminationUnderAggregate`** (extension of `rules/join/rule-join-elimination.ts`, on `PlanNodeType.Aggregate`):
   - Mechanically: collect attribute IDs referenced by group-by exprs + aggregate exprs, walk the wrapper chain to find the join, then reuse `tryEliminate` (inner-join + FK + row-preserving). Rebuild chain on preserved side and wrap in a new `AggregateNode` whose attribute IDs are preserved.
   - Includes the `count(*) from child join parent` case: `count(*)` references no source attrs, so `usesRight` is false and the FK-covered R drops out.

All three abstain when: the FK is undeclared, equi-pairs don't fully cover the FK, the parent side has a row-reducing wrapper, or — for anti-join/inner-eliminable — any FK column is nullable.

## Validation

- `yarn workspace @quereus/quereus test` — **2974 passing, 2 pending, no new failures** (full sweep).
- New test file `test/optimizer/ind-existence.spec.ts` — **10 / 10 pass**, exercises:
  - NOT EXISTS → empty (non-null FK)
  - EXISTS → all child rows (non-null FK; plan has no parent access)
  - EXISTS → filtered child rows (nullable FK; plan has no parent access)
  - NOT EXISTS retained for nullable FK (correctness assertion only — orphan FK row survives)
  - `count(*)` over inner FK join → child rowcount (non-null FK), and `count(child WHERE fk IS NOT NULL)` for nullable variant
  - No-FK negative case
  - Composite-FK both equi-pair declaration orders
  - Chained NOT EXISTS still folds outermost (Structural fixed-point)
  - Parent-side filter prevents the fold (row-preserving guard)
- `rule-join-elimination.spec.ts` was updated to reflect the new SEMI-join behavior: the old "SEMI joins are not eliminated" assertion was rewritten to use a non-FK schema (since the new rule legitimately folds the FK-covered case). All 12 of that file's tests still pass.

## Known gap (flagged honestly per implement-stage guidelines)

**Anti-join-to-empty emits `Filter(L, false)` rather than a true empty relation.** No generic `EmptyRelationNode` exists in the codebase, and constructing one only for this case would add surface area for ~one consumer. The `Filter(L, false)` form preserves L's attribute IDs (which keeps downstream rules and callers stable) and is correct at runtime — the predicate evaluates to constant false and the filter yields zero rows. However:
- I did NOT verify that downstream passes (relational const-folding, predicate-inference, etc.) further collapse `Filter(L, false)` to a node with no underlying L work. The ticket notes the codebase's existing const-folding "already handles `WHERE false` shapes inside scans" but does not explicitly fold a standalone `Filter(L, false)`; in the worst case L is still iterated and every row is discarded by the false predicate. For federated vtabs this still removes the parent round-trip (the win the ticket targeted) but doesn't fully short-circuit L.
- If a reviewer thinks this matters, the right follow-up is a backlog ticket for a generic `EmptyRelationNode` (or a small const-fold pass that recognizes `Filter(x, lit-false)` and replaces the surrounding subtree with an explicit empty source).

## Other items left for backlog / future work (carry forward as specified)

- `JoinNode.preservesLeftCardinality?` annotation — deferred. No consumer needs it yet; add when a downstream rule (count pushdown, DISTINCT elimination over FK joins) materializes.
- IND propagation through derived/projected relations — rules look at the original `TableReferenceNode` only. Wrapping in `Project` (column reordering/dropping) breaks the table-column-index→attribute mapping that the FK alignment check relies on. Not in scope here.
- Conditional INDs, bounded-cardinality inference from IND chains + stats, cross-table assertion-derived INDs — all parked.

## Suggested review focus

- Correctness of `lookupCoveringFK` permutation matching when FK columns are in a different order than `parent.primaryKeyDefinition`. The unit test "folds composite-FK EXISTS regardless of equi-pair declaration order" exercises this in both directions; a focused read of the helper plus that test is the fastest sanity check.
- Correctness of the IS NOT NULL predicate construction in `rule-semi-join-fk-trivial.ts`. The columnIndex used in the `ColumnReferenceNode` is the position in `leftAttrs`, which equals the row position L produces. This holds for the row-preserving cases the rule accepts; verify against any plan shapes a reviewer can imagine where it might not.
- The new `ruleJoinEliminationUnderAggregate` reuses `tryEliminate` from the same file. Confirm the `preserveAttributeIds` argument on the rebuilt `AggregateNode` is correct (passes `node.getAttributes()` so callers above the aggregate continue to find the same output attribute IDs).
- The Structural pass runs to a fixed point — verify (with a debugger or a logged trace) that the chained NOT EXISTS test actually converges in one optimization pass and doesn't oscillate.
