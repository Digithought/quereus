---
description: Review rulePredicateInferenceEquivalence — a Structural-pass rule that materialises inferred equality predicates from the cross of predicate-derived constant bindings and the source's equivalence classes, including branch injection below inner/cross joins.
files:
  - packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts (new)
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/rule-predicate-inference-equivalence.spec.ts (new)
  - packages/quereus/test/logic/02-filters.sqllogic (new)
  - docs/optimizer.md
---

## What landed

`rulePredicateInferenceEquivalence` (Structural pass, priority 22 on `Filter`). Crosses
the predicate-derived `constantBindings` returned by `extractEqualityFds` with the
filter source's `physical.equivClasses`. For every EC member of a bound column that
the predicate doesn't itself pin, the rule synthesises a `col = value` conjunct and
folds it into the outer Filter. When the filter's source is an `inner`/`cross`
`JoinNode`, single-side inferred conjuncts are additionally injected as `FilterNode`
wrappers on the matching branch so subsequent `predicate-pushdown` iterations can
carry them into the branch's vtab access plan.

Registered alongside the existing predicate rules in
`Optimizer.registerRulesToPasses`. No collision with `scalar-cse` (same priority 22,
different node type — `Project`).

Inferred predicates are synthesised through a `ColumnReferenceNode` + (`LiteralNode`
or `ParameterReferenceNode`) + `BinaryOpNode('=')` wrapper, populated from the
relevant `Attribute` (including `relationName` so `formatExpression` shows the
qualified `u.k` form in plan output).

## Files

- `packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts` (new)
- `packages/quereus/src/planner/optimizer.ts` — import + registration block at priority 22
- `packages/quereus/test/optimizer/rule-predicate-inference-equivalence.spec.ts` (new) — 11 specs covering simple form, branch injection, LEFT-JOIN suppression, parameter propagation, multi-hop chain, no-op cases, idempotence, mixed predicate, and an INDEXSEEK-uplift comparison
- `packages/quereus/test/logic/02-filters.sqllogic` (new) — 4 behavioural blocks (literal, parameter, LEFT-join safety, multi-hop)
- `docs/optimizer.md` — rule catalog entry under § Predicate; consumer call-out at the bottom of § Functional Dependency Tracking

## Validation

- `yarn workspace @quereus/quereus run lint` — passes
- `yarn workspace @quereus/quereus run test` — 2864 passing / 2 pending / 0 failing
  - includes the new optimizer spec and logic file
  - `test:store` not exercised — see § Known gaps

## How to test by hand

```sql
create table t (id integer primary key, k integer);
create table u (id integer primary key, k integer);

-- Inspect plan: the u-side gets a `Filter(u.k = 5)` wrapper that subsequent
-- pushdown lands on the leaf, while the outer Filter still carries the
-- augmented `WHERE t.k = 5 and u.k = 5`.
select op, detail from query_plan('select * from t join u on t.k = u.k where t.k = 5');

-- Same with a parameter binding — inferred conjunct must reference the same
-- parameter slot.
select op, detail from query_plan('select * from t join u on t.k = u.k where t.k = ?');

-- LEFT JOIN: outer Filter retains t.k = 5; no inferred filter on u.
select op, detail from query_plan('select * from t left join u on t.k = u.k where t.k = 5');
```

## Known gaps / things to scrutinise

- **`SetOfBranchConjuncts` vs original conjuncts.** The rule only injects *inferred*
  conjuncts on branches; the rule does NOT also split the predicate's original
  single-side conjuncts (e.g., `t.k = 5` in the canonical example) onto their
  respective branches. The original side typically still benefits from index
  selection when the outer Filter sits directly above a single-table source, but in
  the `Filter(t.k = 5 and u.k = 5) over JoinNode(t, u)` plan shape the t-side
  conjunct stays in the outer Filter (because `rulePredicatePushdown` doesn't cross
  `JoinNode`). The INDEXSEEK-uplift test handles this explicitly: it disables the
  rule, measures seek count, re-enables, measures again, and asserts the rule
  caused an uplift — rather than asserting both sides become INDEXSEEK. A reviewer
  who thinks the original conjunct should also be branch-injected: that's outside
  this ticket's scope; the proper home is a predicate-pushdown extension that
  crosses inner joins.

- **Idempotence test relaxed.** Because the rule emits the inferred conjunct in two
  places (outer Filter and the right-branch Filter), the "u.k = 5 appears exactly
  once" assertion was rewritten to "appears at most twice" with a separate "at
  least once" check. This still catches a true non-idempotent re-fire (which would
  produce ≥3 occurrences). A reviewer who prefers a tighter assertion could check
  by counting BinaryOp nodes with a fingerprint rather than substring matches.

- **`extractConstraints` round-trip.** The rule's "already bound" set comes from
  `extractEqualityFds(predicate, attrIdToIndex).constantBindings`. A predicate that
  *implies* `col = V` through a non-equality shape (e.g., `col IN (V)` or a
  collapsed OR-to-IN form) will still receive an inferred `col = V`. That's
  redundant but correct; if it shows up as a measurable cost, the right fix is
  extending `extractEqualityFds` to recognise more shapes — not the inference rule.

- **Selectivity.** Inferred conjuncts don't update `estimatedRows`. The Filter's
  heuristic 0.5 selectivity applies to the augmented predicate just as it did to
  the original. Tightening the estimate is a follow-up.

- **Range / IS NULL inference deliberately out of scope** per the plan ticket.
  Confirm the rule code doesn't accidentally handle them — it only emits literal /
  parameter equalities from `ConstantBinding` values.

- **Store-mode coverage.** Implementation was validated against the default memory
  vtab module (`yarn test`). `yarn test:store` not run — if the reviewer wants
  belt-and-braces coverage of the LevelDB path, it's worth a single sweep.

- **LEFT JOIN safety.** The rule defensively refuses branch injection on
  `left`/`right`/`full`. The simple form also won't materialise right-side
  inferences on a LEFT join because `propagateJoinFds` drops right-side ECs from
  the join's output — so the EC visible at the filter's source already excludes the
  unsafe member. The defensive branch-injection refusal is a second guard rail. A
  reviewer who thinks left-branch injection on LEFT JOIN is safe (it is, for
  preserved-side conjuncts): that's the natural extension and not in this ticket's
  scope.

- **Spec assertions are substring-based on plan `detail` strings.** Robust enough
  for the failure modes that matter, but a future plan-formatter change could
  break the assertions. A reviewer who would prefer structural inspection can
  rewrite against `physical.constantBindings` like the existing `fd-equivalence`
  spec does, at the cost of less direct correspondence to user-visible plan text.

## End
