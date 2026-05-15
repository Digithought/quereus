---
description: Constraint-satisfiability pass that folds unsatisfiable conjunctions of CHECK-derived domains, `where` predicates, and inner-join `on` predicates to `Filter(child, false)`. Hard-bounded scope — per-column interval arithmetic on numeric/temporal types, equality reasoning, IN-list intersection — explicitly NOT a SAT/SMT solver.
prereq: optimizer-empty-relation-node
files:
  - packages/quereus/src/planner/analysis/sat-checker.ts                   # NEW — checkSatisfiability + per-column accumulator
  - packages/quereus/src/planner/analysis/predicate-conjuncts.ts            # reuse splitConjuncts
  - packages/quereus/src/planner/util/fd-utils.ts                           # DomainConstraint re-export (already present)
  - packages/quereus/src/planner/nodes/plan-node.ts                         # DomainConstraint type (no changes expected)
  - packages/quereus/src/planner/nodes/filter.ts                            # consumer of the rule (no changes expected — operates from outside)
  - packages/quereus/src/planner/nodes/join-node.ts                         # consumer for inner-join on
  - packages/quereus/src/planner/nodes/scalar.ts                            # LiteralNode for the false constant
  - packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts  # NEW — filter rule
  - packages/quereus/src/planner/rules/predicate/rule-join-on-contradiction.ts # NEW — inner-join on rule
  - packages/quereus/src/planner/optimizer.ts                                # register both rules (Structural pass, priority 27)
  - packages/quereus/src/util/comparison.ts                                  # compareSqlValues (existing — used as-is)
  - packages/quereus/test/optimizer/predicate-contradiction.spec.ts          # NEW — unit + e2e tests
  - packages/quereus/test/performance-sentinels.spec.ts                      # add planning-time sentinel
  - docs/optimizer.md                                                        # NEW subsection: "Predicate contradiction detection"
---

## Goal

After `optimizer-check-derived-fds-and-domains` (complete), every relation
already advertises `PhysicalProperties.domainConstraints` propagated from
declared `CHECK`. The optimizer can now *consume* that signal: take the
conjunction of (filter predicate ∧ domains ∧ constant bindings) and decide
whether it is provably unsatisfiable. When yes, rewrite to a constant-false
filter so existing dead-branch elimination collapses the subtree.

Scope is **tight** by design — see plan ticket. The checker handles
single-column intervals (numeric + temporal), single-column enum/IN
intersection, equality contradictions, and domain-vs-predicate intersection.
Any clause outside this scope is treated as "potentially satisfiable"
(`unknown`) — never a false positive.

## Architecture

### Helper module: `planner/analysis/sat-checker.ts`

```ts
import type { ScalarPlanNode, DomainConstraint, ConstantBinding } from '../nodes/plan-node.js';
import type { SqlValue } from '../../common/types.js';

export type SatResult = 'sat' | 'unsat' | 'unknown';

interface ColumnAccumulator {
  // Range bounds. Absent ends are unbounded.
  minValue?: SqlValue;
  minInclusive: boolean;        // ignored when minValue absent
  maxValue?: SqlValue;
  maxInclusive: boolean;
  // Enum membership: undefined means "no membership constraint yet"; an empty
  // array signals already-collapsed (caller short-circuits to 'unsat').
  allowedValues?: SqlValue[];
  // Disequalities `x != v`; only used to pinch off otherwise-satisfiable ranges.
  excluded: SqlValue[];
  // Out-of-scope clauses touching this column. We still keep tracking the
  // in-scope facts, but never declare 'sat' if this flag is set on any column
  // that contributed to a near-collapse.
  sawUnknown: boolean;
}

/**
 * Returns 'unsat' iff the conjunction provably has no satisfying assignment
 * within the supported fragment. Returns 'unknown' when it can't decide
 * (out-of-scope clauses dominate). Never returns false 'unsat'.
 *
 * `attributes` maps attribute IDs visible at the call site to physical column
 * indices in the domain/binding tables; or pass an identity mapper if the
 * caller already aligned them.
 */
export function checkSatisfiability(
  conjuncts: ReadonlyArray<ScalarPlanNode>,
  domains: ReadonlyArray<DomainConstraint>,
  bindings: ReadonlyArray<ConstantBinding>,
  attrIndex: (attrId: number) => number | undefined,
): SatResult;
```

Internal algorithm — single pass over conjuncts + domains + bindings:

1. Seed per-column accumulators from `domains` (range fields populate
   minValue/maxValue + inclusivity; enum populates allowedValues).
2. Seed accumulators from `bindings` (treat as `x = v` → range collapses to
   [v,v] AND allowedValues = [v]).
3. For each conjunct:
   - If it is `ColumnRef op literal` or `literal op ColumnRef` (the flipped
     form already handled by `flipComparison` in `check-extraction.ts` — reuse
     the same helper) with `op ∈ {=, ==, <, <=, >, >=, !=}` → fold into the
     column's accumulator.
   - `BETWEEN literal AND literal` → merges as `>= lo AND <= hi`.
   - `IN (lit, lit, …)` → intersect `allowedValues` (or seed it).
   - `NOT IN (lit, …)` → append to `excluded`.
   - `IS NULL` / `IS NOT NULL` → out-of-scope for the v1 (set
     `sawUnknown`); domain constraints don't yet express null-allowed.
   - Anything else (LIKE, function calls, cross-column comparisons, OR-trees,
     CASE) → set `sawUnknown` on the columns it mentions; don't try to
     reason. **Do not split OR branches** — they need full case analysis,
     which is explicitly out-of-scope.
4. After accumulation, per column: collapse range with allowedValues:
   - Drop allowed values that fall outside [min, max].
   - If `allowedValues` is now empty → `unsat`.
   - If min > max (strict comparison with inclusivity rules) → `unsat`.
   - If `allowedValues` is `[v]` and `excluded` contains `v` → `unsat`.
   - If range is a point (min == max, both inclusive) and `excluded` contains
     it → `unsat`.
5. If no column collapses → `'sat'` when no `sawUnknown` anywhere, else
   `'unknown'`. (For our rewrite, only `'unsat'` matters — `'sat'`/`'unknown'`
   both leave the plan as-is.)

Inclusivity arithmetic: `min > max` clearly unsat; `min == max` unsat iff
either side is exclusive. Use `compareSqlValues` from
`packages/quereus/src/util/comparison.ts` for the three-way result.

Type-aware comparison: `compareSqlValues` already handles SQLite-style type
affinity for numerics and temporal types compare via the existing physical
type system. For text enums, intersect using SQL `=` semantics (the same
helper accepts collations — pass through whatever the column's declared
collation is when accessible, default to BINARY otherwise).

### Filter rule: `rules/predicate/rule-filter-contradiction.ts`

```ts
export function ruleFilterContradiction(node: PlanNode, _ctx: OptContext): PlanNode | null {
  if (!(node instanceof FilterNode)) return null;
  const child = node.source;
  const conjuncts = splitConjuncts(node.predicate);
  const domains = child.physical.domainConstraints ?? [];
  const bindings = child.physical.constantBindings ?? [];
  // Build attrId → column index map from child.getAttributes()
  const attrIdx = buildAttrIndex(child.getAttributes());
  const result = checkSatisfiability(conjuncts, domains, bindings, attrIdx);
  if (result !== 'unsat') return null;

  // Emit Filter(child, false). Once optimizer-empty-relation-node lands and
  // the const-fold pass collapses Filter(_, false) → EmptyRelationNode, we
  // get the dead-tree elimination for free. Until then this still skips row
  // emission via the runtime's lit-false short-circuit.
  const lit = new LiteralNode(node.scope, { type: 'literal', value: false });
  return new FilterNode(node.scope, child, lit);
}
```

If `node.predicate` is *already* `LiteralNode(false)`, skip (no-op).
If `node.predicate` is `LiteralNode(true)` or other always-true, do nothing
here (not our problem — there's already const-eval handling for that case).

### Join rule: `rules/predicate/rule-join-on-contradiction.ts`

Same approach, but:

- Only inner joins. `joinType === 'inner'` (or `'cross'` with non-null
  condition); skip `'left' | 'right' | 'full' | 'semi' | 'anti'` — they have
  null-padding semantics that change the unsat conclusion (defer per plan).
- Conjunction = `splitConjuncts(node.condition)` (when present) ∧
  domains-from-both-sides ∧ bindings-from-both-sides.
- Attribute indexing crosses both sides: build a unified attrId → unified
  column index, where left attrs map to `[0..L)` and right attrs map to
  `[L..L+R)`. **Treat both sides' domains and bindings independently** but in
  the same unified accumulator namespace (the inner-join output stream
  exposes both, so domain-vs-predicate intersection is well-defined).
- Rewrite to `Filter(LeftChild, false)` with the *original join's*
  attributes, OR — easier and matches the anti-join-fk-empty precedent —
  rewrite to `Filter(joinNode.left, false)` and rely on dead-tree
  elimination to discard the right side. **Decision: match anti-join-empty
  pattern exactly** — return `Filter(node.left, LiteralNode(false))`. This
  preserves left-side attribute IDs which is what most consumers need. If
  later we find consumers that rely on right-side attribute IDs, this
  becomes a candidate fix once `EmptyRelationNode` lands.

  Tradeoff documented: for cross/inner joins, the right side's attributes
  disappear at the rewrite, which means any parent operator referencing
  right-side attribute IDs would break. **Mitigation: only fire when the
  Join's parent is also collapsible** is too restrictive; instead, defer this
  rule entirely until `EmptyRelationNode` exists (it preserves the full
  output schema). **Plan: ship the FilterNode rule first; gate the join-on
  rule behind the `EmptyRelationNode` prereq (backlog ticket
  `optimizer-empty-relation-node`).**

### Registration

In `planner/optimizer.ts` `registerRulesToPasses()`, after the IND rules
(priority 26):

```ts
this.passManager.addRuleToPass(PassId.Structural, {
  id: 'filter-contradiction',
  nodeType: PlanNodeType.Filter,
  phase: 'rewrite',
  fn: ruleFilterContradiction,
  priority: 27,
});

// Inner-join on-clause contradiction. Requires EmptyRelationNode to preserve
// the join's output schema after rewrite, so this is deferred behind that
// prereq — see follow-up ticket. For now the registration block stays
// commented and an end-to-end test verifies the filter rule covers the most
// common case (predicate is already pushed to a Filter above the table by
// predicate-pushdown).
```

Why priority 27: `predicate-pushdown` (20) has consolidated the predicate
onto the lowest-possible Filter, `filter-merge` (21) collapsed adjacent
Filters, `predicate-inference-equivalence` (22) has added EC-inferred
conjuncts to maximize the chance the contradiction is visible. The IND rules
(26) may have rewritten anti/semi joins to filters; running 27 catches *those*
too.

## Tests

### `test/optimizer/predicate-contradiction.spec.ts`

Unit tests on `checkSatisfiability` (synthetic conjuncts + domains —
construct LiteralNode/ColumnRef/BinaryOpNode trees directly):

- Range collapse: `x ∈ [5,10] ∧ x ∈ [20,30]` → unsat.
- Equality conflict: `x = 5 ∧ x = 7` → unsat.
- Enum × enum disjoint: `x IN (1,2,3) ∧ x IN (4,5,6)` → unsat.
- Enum × range disjoint: `x IN (1,2,3) ∧ x > 10` → unsat.
- Inclusive boundary: `x > 5 ∧ x <= 5` → unsat.
- Inclusive boundary positive: `x >= 5 ∧ x <= 5` → sat.
- Disequality + point: `x = 5 ∧ x != 5` → unsat.
- Out-of-scope only: `x like '%foo'` alone → unknown.
- Mixed: contradiction-eligible clause + unknown clause → unsat (the
  unknown clause does *not* block the in-scope contradiction).
- Domain feed: domain `[0, ∞)` ∩ predicate `x < 0` → unsat.
- Temporal: `created_at < '2024-01-01' ∧ created_at > '2025-01-01'` →
  unsat (relies on `compareSqlValues` text-ordering for ISO dates —
  acceptable since the column would carry a temporal type/affinity).
- Binding feed: constantBinding `{col: 0, value: 5}` + predicate `x = 7` →
  unsat.

End-to-end via SQL (use the existing logic-test harness pattern under
`packages/quereus/test/logic/` for sqllogic, but a focused Mocha spec under
`test/optimizer/` is appropriate when checking plan shape):

- `CREATE TABLE t (qty INT CHECK (qty >= 0))` then
  `SELECT * FROM t WHERE qty < 0` → plan-shape: top Filter's predicate is a
  LiteralNode(false); execution returns zero rows.
- `CHECK (status IN ('a','i'))` + `WHERE status = 'x'` → empty.
- `WHERE x BETWEEN 0 AND 5 AND x BETWEEN 10 AND 20` → empty.
- **Negative**: `WHERE x >= 5 AND x <= 5` returns matching rows
  (boundary still satisfiable).
- **Negative**: `WHERE qty < 0 AND name LIKE '%foo'` against a `qty >= 0`
  domain — still folds (the unknown clause is ignored, the in-scope
  contradiction fires).

### `test/performance-sentinels.spec.ts`

Add a sentinel: a 50-column wide SELECT with a non-contradicting WHERE
clause must plan in under the existing budget for that fixture. The checker
should be `O(conjuncts × columns_mentioned)` with a tiny constant — verify
no super-linear regression. Use the existing sentinel pattern from the file.

## Documentation

`docs/optimizer.md` — add a subsection "Predicate contradiction detection"
that:

1. States explicit scope: single-column numeric/temporal interval
   arithmetic, enum/IN intersection, equality contradiction,
   domain-vs-predicate intersection.
2. States explicit non-scope: OR/CASE branch analysis, cross-column
   arithmetic, LIKE patterns, user-function reasoning,
   outer-join contradiction (defer).
3. Names the prereq (`domainConstraints` propagation, ticket #1) and
   the follow-up (`optimizer-empty-relation-node` for join-on support).
4. Worked example: `CHECK (qty >= 0) AND WHERE qty < 0` → empty.

## Decisions & tradeoffs

- **Join-on rule deferred behind `optimizer-empty-relation-node`.** The
  filter rule alone catches the canonical cases — `predicate-pushdown`
  already moves WHERE clauses to the lowest-possible Filter, which is what
  the rule scans. For inner-join `on` clauses that *can't* be pushed (rare —
  typically only when they reference both sides), users can still author the
  equivalent WHERE and hit the filter rule. Gating join-on means we don't
  ship a rewrite that silently truncates the right-side schema.
- **Filter(child, false) over a hypothetical EmptyRelationNode.** Matches
  the `rule-anti-join-fk-empty` precedent (priority 26). The runtime
  already short-circuits a lit-false filter; the only cost vs.
  EmptyRelationNode is iterating the child cursor once (zero rows emitted).
  The follow-up `optimizer-empty-relation-node` ticket replaces this for
  both rules in one pass.
- **OR is out of scope.** Splitting on OR would mean case-analysis (every
  branch must be unsat for the whole to be unsat), which is a true SAT
  problem. Plan ticket says no, so we don't.
- **`compareSqlValues` for comparisons.** Already used across the codebase
  and respects SQLite affinity. Collations on TEXT columns are passed
  through when the column carries one; we don't invent collation logic.
- **`sawUnknown` is per-column, not global.** A LIKE pattern on column `b`
  must not stop us folding a range contradiction on column `a`. The plan
  ticket calls this out as the desired behavior; the per-column flag
  enforces it.
- **`Filter(_, LiteralNode(false))` already in tree → no-op.** Don't
  thrash on already-folded plans (also guards against re-rewriting our own
  output on the next fixed-point iteration).

## TODO

- Implement `planner/analysis/sat-checker.ts` with `checkSatisfiability`,
  `ColumnAccumulator`, and the single-pass collector.
  - Reuse `flipComparison` from `check-extraction.ts` if it's exported; else
    inline a tiny equivalent (don't expand the analysis surface unless the
    helper is genuinely shared).
  - Reuse `splitConjuncts` from `predicate-conjuncts.ts`.
  - Use `compareSqlValues` from `util/comparison.ts`.
  - Cap iterations / accumulator sizes consistently with existing
    `MAX_FDS_PER_NODE` style caps (use the same constant or a sibling).
- Implement `rules/predicate/rule-filter-contradiction.ts`.
  - Guard: skip when predicate is already `LiteralNode(false)`.
  - Build `attrId → column index` from `child.getAttributes()`.
  - On `'unsat'`, return `new FilterNode(node.scope, child,
    new LiteralNode(node.scope, { type: 'literal', value: false }))`.
- Register in `optimizer.ts` at Structural pass, priority 27.
  - Leave the join rule registration commented with a TODO referencing the
    `optimizer-empty-relation-node` prereq.
- Tests in `test/optimizer/predicate-contradiction.spec.ts` per outline.
- Planning-time sentinel in `test/performance-sentinels.spec.ts`.
- Update `docs/optimizer.md` with the new subsection.
- Run `yarn workspace @quereus/quereus run lint` and `yarn test` from repo
  root; both must be clean. (Skip `yarn test:store` — orthogonal.)

## Out of scope (carry-forward to follow-up tickets)

- Inner-join `on` rule: blocked on `optimizer-empty-relation-node` (backlog).
- LIKE pattern intersection.
- Cross-column linear arithmetic.
- Outer-join `on` contradiction → null-padded scan rewrite.
- DPLL / SAT solving over Boolean structure (OR/CASE branches).
- Domain intersection (overlapping range/enum domains on the same column at
  the source) — already deferred from ticket #1; technically the sat checker
  reads them as separate clauses so a contradiction *between* two domains
  also fires here, but we don't *merge* them into a tighter single domain
  for downstream consumers.
