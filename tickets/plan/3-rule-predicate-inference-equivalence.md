---
description: Optimizer rule that propagates equality predicates through equivalence classes to derive additional sargable predicates
prereq: fd-property-foundation, fd-from-equivalence-classes
files:
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts (new)
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/test/optimizer/rule-predicate-inference-equivalence.spec.ts
  - packages/quereus/test/logic/02-filters.sqllogic
  - docs/optimizer.md
---

## Motivation

When the planner knows `a = b` and separately knows `a = 5`, basic transitivity gives `b = 5`. The added predicate is sargable on `b` independently — it can be pushed into `b`'s table's access plan even when the join would otherwise be the only path that bound `b`'s value.

This is one of the highest-leverage classical optimizations: it lets each side of an equi-join filter independently before the join, slashing the cardinality of both inputs.

```sql
-- Original
SELECT * FROM t JOIN u ON t.k = u.k WHERE t.k = 5;

-- After inference
SELECT * FROM t JOIN u ON t.k = u.k WHERE t.k = 5 AND u.k = 5;
-- u.k = 5 is sargable on u alone, lets u's access plan seek directly.
```

Same payoff for the multi-table chain:

```sql
SELECT * FROM a JOIN b ON a.x = b.x JOIN c ON b.x = c.x WHERE a.x = 7;
-- Inferred: b.x = 7 AND c.x = 7
```

The optimizer currently does none of this. Adding it makes a large class of queries dramatically faster, especially in federation scenarios where each table's access cost is dominated by row count.

## Architecture

### Rule placement

`rulePredicateInferenceEquivalence` in `planner/rules/predicate/`. Registered in the Structural pass at priority ~22 (after EC derivation in the join/filter physical computation, after predicate pushdown at 20 — pushdown moves predicates DOWN through commuting nodes, this rule generates new predicates from the equivalence layer; it must run after predicate pushdown so the pushdown can then carry the new predicates into the leaves on its next iteration).

A simpler ordering: run this rule once, then re-run predicate pushdown. In the existing pass framework, a structural pass runs to fixed-point on the rule set, so the order just needs to make the inferred predicates *visible* to pushdown — placing this rule's priority just below predicate-pushdown's accomplishes that on the next iteration.

### Algorithm

For a `FilterNode(predicate, source)`:

1. Extract equality constants from the predicate: each `col = literal` or `col = parameter` produces a `{col → constant}` binding.
2. Pull `equivClasses` from the source's physical properties.
3. For each binding `{col → constant}`, look up `col`'s equivalence class. If the class has other members, emit `othercol = constant` predicates for each.
4. AND the inferred predicates into the existing predicate. Skip generation if the inferred predicate is structurally identical to one already present (avoid infinite loop on re-application).
5. Rebuild the `FilterNode` with the augmented predicate.

The same logic applies to `JoinNode` `ON`-clause predicates: equality constants in the ON clause combined with equi-join pairs from the same condition produce inferred equalities. Practically, when join-side ECs are computed in `JoinNode.computePhysical`, the ON-clause already participates. The rule's job is specifically to *materialize* the inferred predicates so downstream rules (pushdown, vtab access plan) can see them.

### Termination

The rule is monotone: it only adds predicates, never removes them. Each application produces predicates that, on the next pass, the source's `equivClasses` already accounts for — so re-application is idempotent. The "skip generation if identical" check is the fixpoint guard.

### Constant binding propagation across joins

When the join condition is `t.x = u.y` and `t` has `t.x = 5`, the join output has both `t.x` and `u.y` bound to 5. The EC machinery (`fd-from-equivalence-classes`) handles the class merging at the join's `computePhysical`. This rule consumes that merged EC: above the join, a predicate on `u.y` can be inferred as `u.y = 5`.

But pushing `u.y = 5` BELOW the join — to `u`'s access plan — requires the predicate to exist as a Filter on the `u` side before the join. The rule must therefore:

- Detect that an inferred equality `u.y = 5` can be pushed down to the `u` branch (i.e., `u.y` is a column of `u` alone).
- Inject a `FilterNode` on the `u` branch carrying just `u.y = 5`, leaving the original join intact.

This is the more powerful form of the rule. The simpler form (just emit the predicate at the same level it was inferred) is also useful but less impactful. Implementation should aim for the powerful form; the simple form is a fallback.

### Branch injection details

For a `JoinNode(left, right, condition, joinType)`:

1. Compute join-output ECs (from `fd-from-equivalence-classes`).
2. Identify each constant binding above or in the join's `ON` clause. For each binding `(col, value)`:
   - If `col` belongs to an EC that crosses the join boundary (has members in both `left` and `right`), inject the constant binding on the side that doesn't already carry it.
3. The injected `FilterNode` wraps the appropriate branch with `col_in_branch = value`.
4. The original ON clause is unchanged.

For LEFT JOIN: only the left side can have constants pushed in. The right side's null-padded rows mean a constant on `u.y` is satisfied by the original equi-join *or* by null padding. Pushing `u.y = value` to the right branch eliminates rows that would otherwise be null-padded — that changes the result. So inferred predicates on the non-preserved side of an outer join are **not** safely pushed to that branch (they can still be retained at the join level).

### Interaction with parameter bindings

Parameters are constants within a single execution. The rule handles them: `WHERE t.x = ?` with EC `{t.x, u.y}` infers `u.y = ?` (same parameter). This is particularly valuable for prepared statements: the inferred predicate uses the same parameter slot, so it doesn't introduce a new bind value.

### Interaction with `extractConstraints`

The existing constraint extractor (`analysis/constraint-extractor.ts`) feeds the vtab access plan. After this rule runs, the new predicates flow naturally through the extractor — no extractor changes required, just additional input.

## Use cases enabled

- Equi-join with a constant filter on one side: the constant filter applies to both sides, slashing both scan costs.
- Multi-table join chains share constants through the join graph.
- Federation: each remote table receives the inferred predicate independently, reducing network traffic.
- Prepared statements benefit even more — the parameter is bound once and the inference applies on every execution.

## Tests

- Unit test: `WHERE t.k = u.k AND t.k = 5` produces inferred `u.k = 5` as a separate predicate.
- Unit test: `t LEFT JOIN u ON t.k = u.k WHERE t.k = 5` — inferred `u.k = 5` is NOT pushed to the right branch but IS available as an attribute of the join output.
- Unit test: multi-hop chain `a JOIN b ON a.x=b.x JOIN c ON b.x=c.x WHERE a.x=7` produces both `b.x = 7` and `c.x = 7`.
- Plan-shape test: each side of the equi-join has its inferred constant predicate pushed into the leaf's access plan.
- Logic test: identical results before/after the rule.
- Parameter test: `WHERE t.k = u.k AND t.k = ?` produces inferred `u.k = ?` with the same parameter slot.

## Documentation

- **docs/optimizer.md** — add a rule catalog entry under "Predicate". Add a paragraph in the EC framework section showing the chain-of-inference example.
- No `docs/architecture.md` change required.

## Out of scope

- IS NULL inference (`a IS NULL ∧ a = b` does NOT imply `b IS NULL` under SQL semantics — `a = b` returns NULL when either is null, so the predicate cannot fire on null `a`). Three-valued logic gymnastics, deferred.
- Range inference (`a > 5 ∧ a = b` ⇒ `b > 5`). Sound but requires extending the predicate-inference machinery to non-equality comparisons. Worthwhile follow-up.
