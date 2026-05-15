---
description: Add IND-aware existence-folding rewrites to the optimizer — collapse `not exists` over a covering FK to empty, `exists` to a non-null guard (or nothing), and inner-join+aggregate-only-existence to a non-null guard — by promoting FK declarations to first-class inclusion-dependency reasoning the rules can query via a shared util.
files:
  - packages/quereus/src/schema/table.ts
  - packages/quereus/src/planner/util/key-utils.ts
  - packages/quereus/src/planner/util/ind-utils.ts (new)
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts (new)
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts (new)
  - packages/quereus/src/planner/rules/join/rule-fk-covered-aggregate-elim.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/ind-existence.spec.ts (new)
  - docs/optimizer.md
---

## Goal

Use the inclusion dependency `child.fk ⊆ parent.pk` to fold three SQL shapes the optimizer doesn't currently exploit:

1. `select … from child c where not exists (select 1 from parent p where p.pk = c.fk)` ⟶ empty result (when child.fk is non-null and FK-covered).
2. `select … from child c where exists (select 1 from parent p where p.pk = c.fk)` ⟶ `select … from child c` (no parent access; insert `is not null` guard only if FK is nullable).
3. `select count(*) from child c join parent p on p.pk = c.fk` (more generally: any inner join whose parent side is referenced only by existence-only aggregates / non-column-dependent expressions) ⟶ drop the join, keep `where fk is not null`.

These rewrites are particularly valuable for federated schemas where the parent side is a remote vtab; each elimination removes a round-trip.

## Architecture

### Existing surfaces this builds on

- `TableSchema.foreignKeys: ReadonlyArray<ForeignKeyConstraintSchema>` (`packages/quereus/src/schema/table.ts:69-72,363-394`) — already carries `{ columns, referencedTable, referencedColumns, … }`. No need to add a new normalized `inclusionDependencies` array; we expose a permutation-aware lookup helper instead.
- `checkFkPkAlignment` and `findMatchingForeignKey` already do most of the matching logic — the former is in `packages/quereus/src/planner/util/key-utils.ts:372`, the latter is currently **private** inside `packages/quereus/src/planner/rules/join/rule-join-elimination.ts:267`. We promote `findMatchingForeignKey` (rename: `lookupCoveringFK`) into a new shared util.
- `JoinType` already includes `'semi'` and `'anti'` (`packages/quereus/src/planner/nodes/join-node.ts:17`), and `analyzeJoinKeyCoverage` already handles them in `key-utils.ts:271`.
- Subquery decorrelation (`rule-subquery-decorrelation.ts`) already produces semi/anti joins from `EXISTS / NOT EXISTS / IN` (priority 25). New rules must run **after** this — at priority ≥ 26 in the Structural pass.
- No generic "empty relation with arbitrary schema" node exists. `EmptyResultNode` (`packages/quereus/src/planner/nodes/table-access-nodes.ts:289`) is a `TableAccessNode` tied to a single base table — not reusable here. We rewrite anti-join-to-empty as **`Filter(L, LiteralNode(false))`** and rely on existing relational-const-folding to collapse it as far as it can (it already handles `WHERE false` shapes inside scans; if it does not collapse the standalone `Filter(L, false)` at the relational level, the runtime will still short-circuit because the filter yields zero rows). If profiling shows we lose plan-shape clarity here, follow up with a generic `EmptyRelationNode` — but don't introduce that abstraction in this pass.

### New helper: `planner/util/ind-utils.ts`

```typescript
// Look up a foreign key on `childSchema` that references `parentSchema` whose
// (childCols, parentCols) — in some permutation — equals the requested equi-pairs.
// Returns the matching FK plus whether any child column is nullable.
export function lookupCoveringFK(
  childSchema: TableSchema,
  parentSchema: TableSchema,
  childEquiCols: ReadonlyArray<number>,
  parentEquiCols: ReadonlyArray<number>,
): { fk: ForeignKeyConstraintSchema; nullable: boolean } | undefined;

// Convenience: walk down through standard wrappers to find the underlying
// TableReferenceNode/RetrieveNode and extract its TableSchema. (Thin wrapper
// over the existing extractTableSchema in key-utils.ts so call sites in the
// new rules don't import from rule-join-elimination internals.)
export function tableSchemaOf(node: RelationalPlanNode): TableSchema | undefined;
```

Move `findMatchingForeignKey` out of `rule-join-elimination.ts` into this file under the new name and reuse it from there. `checkFkPkAlignment` stays in `key-utils.ts` (it's about join-key coverage, not specifically existence reasoning) but `lookupCoveringFK` returns the actual matched FK so the caller can read its nullability.

### Rules

All three rules below register in the Structural pass at **priority 26+** (after `subquery-decorrelation` at 25 — they consume its output shapes). Plan-shape-wise, they all assume post-decorrelation joins; `Apply` nodes and undecorrelated subqueries are skipped conservatively.

**1. `rule-anti-join-fk-empty`** (file: `rules/subquery/rule-anti-join-fk-empty.ts`, on `PlanNodeType.Join`)

Pattern: `Join(L, R, p)` with `joinType === 'anti'`, where:
- `p` is an AND-of-column-equalities (reuse the existing `isAndOfColumnEqualities` from join-elimination — promote to a shared util or duplicate the small predicate).
- `extractEquiPairsFromCondition` returns the `(l_cols, r_cols)` pairs.
- `lookupCoveringFK(tableSchemaOf(L), tableSchemaOf(R), l_cols, r_cols)` finds a non-nullable FK (every child column has `notNull: true`).
- `R` is a row-preserving path to the parent table (reuse `isRowPreservingPathToTable` from join-elimination; promote to ind-utils or share).

Rewrite: replace the entire `Join` with `Filter(L, LiteralNode(false))`. Preserves L's attribute IDs so callers above don't break.

**2. `rule-semi-join-fk-trivial`** (file: `rules/subquery/rule-semi-join-fk-trivial.ts`, on `PlanNodeType.Join`)

Pattern: same as above but `joinType === 'semi'`, with FK coverage. The FK may be nullable.

Rewrite:
- If any FK child column is nullable: `Filter(L, fk_cols IS NOT NULL)` (combined with AND for composite FKs). Use the AST builder shape consistent with how existing rules build predicates.
- If every FK child column is `notNull`: replace the `Join` with `L` directly.

Either way, the parent side never executes.

**3. `rule-fk-covered-aggregate-elim`** (file: `rules/join/rule-fk-covered-aggregate-elim.ts`, on `PlanNodeType.Aggregate`)

Pattern: `Aggregate(group=[…], aggs=[…], source = chain → Join(L, R, p))` where:
- The join is `inner`, condition is AND-of-equalities, FK coverage of `(L.fk → R.pk)` holds.
- L's child FK is `notNull` (same INNER guard the existing elimination already enforces).
- The `Aggregate`'s group keys + aggregate arguments + the chain's predicates/sort keys reference **only** L's attribute set. (i.e., R's attrs are never referenced above the join, not even by aggregates like `count(*)` over the join result — wait: `count(*)` is fine here because cardinality-preservation guarantees `|L join R| == |L where fk is not null|`. This is the new piece.)

This is essentially: extend the existing `rule-join-elimination` row-walker (`walkChain` + the Project-side check) to fire under `Aggregate` whose payload only depends on L. Mechanically: collect `demanded` attribute IDs from the Aggregate's group keys + all aggregate `getAttrIds()`, then run the same chain-walker against `source`.

Implementation choice: **extend `rule-join-elimination.ts`** to also dispatch on `PlanNodeType.Aggregate` rather than adding a separate file, since the chain-walker + FK-alignment + INNER-NOT-NULL logic is shared. Register a second `RuleHandle` over `PlanNodeType.Aggregate` pointing at a new exported entrypoint `ruleJoinEliminationUnderAggregate` that adapts the existing flow.

(If during implementation the Aggregate path turns out to diverge significantly — e.g. different rebuilder, different demanded-attr collection — pull it into its own file `rule-fk-covered-aggregate-elim.ts`. Decide at the diff size.)

### `JoinNode.preservesLeftCardinality` — defer

The plan mentions threading a `preservesLeftCardinality?` annotation onto `JoinNode` as an enabler for downstream rules. Inspect: no current consumer; the optimizer already gets the cardinality bound via `analyzeJoinKeyCoverage`'s `estimatedRows`. Adding the annotation now would be dead-load. **Skip in this pass.** When a future rule (count-pushdown, DISTINCT elimination) actually needs the bit, add it then with a known consumer. Park a one-line backlog ticket noting the gap.

### Run-after-decorrelation ordering

Add to `optimizer.ts` after the `subquery-decorrelation` registration block (around line 235-241). Priority 26 for all three. The Structural pass's fixed-point loop handles convergence — a Filter rewrite from rule 2 can re-trigger predicate-pushdown on the next iteration, which is desirable for federated push-down.

## Test outline (`packages/quereus/test/optimizer/ind-existence.spec.ts`)

Follow the shape of `rule-join-elimination.spec.ts`: read `query_plan(?)`, count join ops, assert row results match. Schema setup mirrors the existing test:

```sql
create table parent (id integer primary key, label text) using memory;
create table child (id integer primary key, parent_id integer not null references parent(id), payload text) using memory;
create table child_nullable (id integer primary key, parent_id integer references parent(id)) using memory;
```

Cases:

- **NOT EXISTS folds to empty (non-null FK)**: `select * from child c where not exists (select 1 from parent p where p.id = c.parent_id)` — plan has zero joins, zero rows in result regardless of data, and (preferably) no `TableReference` for `parent`.
- **EXISTS folds (non-null FK)**: same shape with `exists` — plan has zero joins, no parent access, result = all child rows.
- **EXISTS folds with IS NOT NULL (nullable FK)**: same against `child_nullable` — plan has zero joins, output equals `child_nullable` rows where `parent_id` is not null. Insert one row with null FK to verify.
- **NOT EXISTS does NOT fold with nullable FK**: against `child_nullable`, NOT EXISTS still returns the null-FK row (and there's no FK row in parent, so it'd survive the antijoin anyway). Plan should retain the antijoin (or at minimum, the result must be correct — assert on results, not plan).
- **`count(*)` over inner join folds**: `select count(*) from child c join parent p on p.id = c.parent_id` — plan has zero joins; result equals `count(*)` from `child where parent_id is not null`. With a nullable variant on `child_nullable`, verify the IS NOT NULL guard appears (or result is correct).
- **Multi-column FK**: schemas with composite PK/FK; verify both rules fire with the column-set permutation in either declaration order.
- **Negative — no FK declared**: drop the `references` clause; assert plan still contains the antijoin (rule didn't fire) and result is correct.
- **Composite chain**: `not exists (select 1 from parent p where p.id = c.parent_id) and not exists (select 1 from grandparent g where g.id = p.gp_id)` — outer NOT EXISTS still folds even though inner has nested EXISTS (rules cascade through Structural's fixed-point loop).

Aim for full SQL-logic-style assertions on both plan shape (`joinCount(rows) === 0`, no `TableReference` for the parent) and result correctness.

## Doc update

Add an "Inclusion-dependency reasoning" subsection to `docs/optimizer.md` (after the `## FK→PK` content around lines 1286-1290). Cover:

- The three rewrites and their preconditions (FK coverage, nullability handling, row-preserving path to the parent base table).
- How they interact with `rule-subquery-decorrelation` (run after, consume semi/anti) and with `rule-join-elimination` (the Aggregate path extends it).
- Federated-vtab payoff: each fold removes a remote round-trip.

## Out of scope (carry to backlog if not already there)

- Generic `EmptyRelationNode` for arbitrary schemas — only worth introducing if rule 1's `Filter(L, false)` rewrite proves opaque to downstream passes.
- `JoinNode.preservesLeftCardinality?` annotation — add when a consumer materializes.
- Cross-table assertion-derived INDs (handled by `optimizer-assertion-as-rewrite-premise`).
- IND propagation through derived/projected relations — rules look up against the original `TableReferenceNode` only.
- Bounded-cardinality inference from IND chains + stats.
- Conditional INDs (discriminator-gated FKs).

## TODO

Phase 1 — shared util
- Create `packages/quereus/src/planner/util/ind-utils.ts` with `lookupCoveringFK` and `tableSchemaOf`.
- Move `findMatchingForeignKey` and `isRowPreservingPathToTable` from `rule-join-elimination.ts` into `ind-utils.ts` (renamed as needed). Update import in `rule-join-elimination.ts`.
- Promote `isAndOfColumnEqualities` to `planner/analysis/predicate-conjuncts.ts` (or a sibling) — both old and new rules use it.

Phase 2 — anti-join → empty
- Implement `rule-anti-join-fk-empty.ts`.
- Register at priority 26 in `optimizer.ts` Structural pass.
- Verify the `Filter(L, LiteralNode(false))` rewrite preserves L's attribute IDs and survives the rest of the pass without breaking const-folding.

Phase 3 — semi-join → trivial
- Implement `rule-semi-join-fk-trivial.ts` (nullability-aware: emit `IS NOT NULL` predicate only for nullable FKs).
- Register at priority 26.
- Build the AST `is not null` predicate in the canonical way (look at existing `IsNullNode` or filter-builder helpers).

Phase 4 — aggregate-over-FK-join
- Extend `rule-join-elimination.ts` to also dispatch on `PlanNodeType.Aggregate` (add `ruleJoinEliminationUnderAggregate` entry) **OR** create `rule-fk-covered-aggregate-elim.ts` if the divergence is large.
- Register the second `RuleHandle` at priority 26 (after decorrelation, ordering relative to the other two does not matter).

Phase 5 — tests
- Add `test/optimizer/ind-existence.spec.ts` with every case above.
- Run `yarn workspace @quereus/quereus test` and ensure no regressions in `rule-join-elimination.spec.ts`, `predicate-pushdown.spec.ts`, `fd-propagation.spec.ts`.

Phase 6 — docs
- Update `docs/optimizer.md` with the subsection described above.

Phase 7 — handoff
- Move ticket to `review/`; honestly note any cases the antijoin-empty rewrite leaves as `Filter(L, false)` rather than a true empty node (so the reviewer can decide whether a follow-up `EmptyRelationNode` ticket is worth filing).
