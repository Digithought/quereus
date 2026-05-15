---
description: Constraint-satisfiability pass that folds unsatisfiable conjunctions of `check`, `where`, and join-`on` predicates to a constant-false filter (which existing dead-branch elimination then collapses to empty). Scope is hard-bounded — interval arithmetic over numeric/temporal types, equality reasoning, IN-list intersection — explicitly NOT a full SMT solver.
prereq: optimizer-check-derived-fds-and-domains
files:
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/analysis/
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/rules/predicate/
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/test/optimizer/predicate-contradiction.spec.ts
  - docs/optimizer.md
---

## Problem

When a `check` constraint and a `where` clause cannot be simultaneously satisfied, the query is provably empty before any rows are read:

- Table with `check (qty >= 0)`, query `where qty < 0` — empty.
- Table with `check (status in ('a','i'))`, query `where status = 'x'` — empty.
- Single query with `where x between 0 and 5 and x between 10 and 20` — empty.
- `where x = 5 and x = 7` — empty.
- Self-contradicting `or` branches (`where (x = 5 or x = 6) and x = 7`) — branch reduces.

Today none of these fire. After `optimizer-check-derived-fds-and-domains` lands, the optimizer has the raw material (domain constraints + extracted FDs) but no machine that intersects domains with predicate clauses to detect emptiness.

This ticket adds a tightly-scoped satisfiability checker. The goal is not to be complete — it is to handle the common cases cheaply and recognize its own limits, returning "unknown" everywhere else.

## Architecture

### Scope discipline

The checker handles, and only handles:

1. **Interval intersection** on numeric and temporal columns:
   - `x op v` where `op ∈ {<, <=, =, >=, >, between, !=}` and `v` is a literal.
   - `x op y` where both are columns in the same EC pinned to literals (via `constantBindings`).
   - Interval arithmetic: produce `[min, max]` per column from the conjunction; if min > max (with inclusivity rules) → unsat.
2. **Enum / IN-list intersection**:
   - Maintain a candidate value set per column (intersect of all `IN`/`= literal` clauses).
   - If empty → unsat.
3. **Equality contradiction** between literal-bound columns:
   - `x = 5` and `x = 7` → unsat directly.
4. **Domain-vs-predicate intersection**:
   - Read `domainConstraints` from the input relation (added by ticket #1).
   - Treat them as additional clauses in the conjunction.

Explicitly **out**:
- Boolean SAT over arbitrary structure (no DPLL).
- Cross-column arithmetic (no `x + y < 10` reasoning).
- Function calls beyond const-folded literals (rely on the existing const evaluator).
- Inequalities on text/blob (only equality / membership).
- LIKE pattern reasoning.

When a clause falls outside scope, it is conservatively treated as "potentially satisfiable" — never a false positive.

### Where it runs

Two integration points:

1. **Filter rewrite rule** (`rules/predicate/rule-filter-contradiction-detection.ts`):
   - For each `FilterNode`, build the conjunction = filter predicate ∧ child's `domainConstraints` ∧ any constant bindings closed over ECs.
   - Run the checker. If `unsat`, replace the `FilterNode` with a constant-false filter (or directly with an empty-relation node if the existing infrastructure has one).
   - Existing dead-branch elimination collapses upward through joins/projections.

2. **Join-on rewrite** (same rule or sibling): apply to the `on` predicate of `JoinNode` together with both children's domains. Inner-join contradictions → empty. Outer-join contradictions don't make the whole join empty — they degrade to a left/right scan with null padding for the dropped side; defer that subtlety to a follow-up if the simple inner-join case lands clean.

### Helper surface

```typescript
type SatResult = 'sat' | 'unsat' | 'unknown';

function checkSatisfiability(
  conjunction: PredicateExpression[],
  domains: ReadonlyArray<DomainConstraint>,
  bindings: ReadonlyArray<ConstantBinding>,
  ecs: ReadonlyArray<ReadonlyArray<number>>,
): SatResult;
```

Internally:
- Per-column accumulator: `{ range: {min?, max?, minIncl, maxIncl}, allowedValues?: SqlValue[], excludedValues: SqlValue[] }`.
- Process clauses in one pass; merge into accumulators; return `unsat` as soon as any accumulator collapses.
- Out-of-scope clauses bump `sawUnknown = true`; final result is `unsat` if any accumulator is empty, else `'sat' | 'unknown'` based on `sawUnknown`. (Either treats correctly downstream: only `unsat` triggers rewrite.)

### Type-aware comparison

Use the existing `compareSqlValues` utility for range comparisons; respect collations for text columns when intersecting enum sets. The temporal types (`DATE`, `TIME`, `DATETIME`) compare via the existing physical type system — no new comparison logic.

## Test outline (`test/optimizer/predicate-contradiction.spec.ts`)

Unit on `checkSatisfiability`:
- Single column range collapse: `[5,10] ∩ [20,30]` → unsat.
- Single column equality conflict: `x = 5 ∧ x = 7` → unsat.
- Enum intersection empty: `x in (1,2,3) ∧ x in (4,5,6)` → unsat.
- Enum + range disjoint: `x in (1,2,3) ∧ x > 10` → unsat.
- Inclusive vs exclusive boundary: `x > 5 ∧ x <= 5` → unsat; `x >= 5 ∧ x <= 5` → sat.
- Out-of-scope: `like '%foo'` plus a satisfiable conjunction → `unknown` (not `unsat`).
- Domain feed: domain `[0, ∞)` ∩ predicate `< 0` → unsat.
- Temporal: `created_at < '2024-01-01' ∧ created_at > '2025-01-01'` → unsat.

End-to-end via SQL logic + plan-shape:
- Table with `check (qty >= 0)`, `select * from t where qty < 0` → plans to empty; zero rows.
- Table with `check (status in ('a','i'))`, `select * from t where status = 'x'` → empty.
- Self-contradicting `where`: `select * from t where x between 0 and 5 and x between 10 and 20` → empty.
- Inner-join contradiction on join-on clause → empty.
- Negative: query that mixes a contradiction-eligible clause with an unknown one (e.g., `qty < 0 and name like '%foo'`) — still detects the contradiction, plans to empty.
- Negative: satisfiable boundary (`where x >= 5 and x <= 5`) — does NOT fold; returns the matching row.

Performance sentinel: the checker must not regress planning time on a 50-column wide-SELECT benchmark; add a sentinel in `test/performance-sentinels.spec.ts` (use existing pattern).

## Out of scope

- LIKE pattern intersection (`like 'foo%' ∩ like 'bar%'`).
- Cross-column linear arithmetic.
- Outer-join contradiction → null-padded scan rewrite (defer).
- DPLL / SAT solving over Boolean structure.
- User-defined function reasoning beyond pre-folded constants.

## TODO (carry to implement)

- Implement `checkSatisfiability` and per-column accumulator types in `planner/analysis/sat-checker.ts`.
- Hook into `FilterNode.computePhysical` (or as a rule under `rules/predicate/`) to detect and rewrite.
- Handle inner `JoinNode.on` similarly.
- Reuse `compareSqlValues` for type-aware comparison.
- Add a constant-false-filter / empty-relation rewrite path (verify whether one already exists in dead-branch elimination — reuse it).
- Tests per outline above; add planning-time sentinel.
- Update `docs/optimizer.md` with a "Predicate contradiction detection" subsection naming explicit scope limits.
