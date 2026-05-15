---
description: Once the conservative fix lands and the FD layer ignores partial UNIQUE indexes, recover the legitimate optimization opportunity: a partial UNIQUE on `(c) where P` is a valid unconditional FD `c → all-other-cols` *for any sub-relation whose row predicate implies `P`*. Plumbing FDs with an optional condition (or carrying conditional keys alongside unconditional ones) plus a predicate-implication check at consumption sites unlocks DISTINCT elimination, GROUP BY simplification, FK→partial-PK join elimination, etc., for queries whose WHERE clause subsumes the partial-index predicate.
prereq: fd-partial-unique-index-treated-as-unconditional-key
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/src/planner/nodes/filter.ts
  packages/quereus/src/planner/analysis/predicate-conjuncts.ts
  packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts
  packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts
  packages/quereus/src/planner/rules/sort/rule-orderby-fd-pruning.ts
  packages/quereus/src/planner/rules/join/rule-join-elimination.ts
  packages/quereus/src/planner/rules/predicate/rule-predicate-inference-equivalence.ts
  packages/quereus/src/schema/table.ts
---

## Optimization opportunity

A partial UNIQUE index `create unique index ix on t(c) where P` proves that
`c` is unique *only over rows satisfying `P`*. The conservative fix
(`fd-partial-unique-index-treated-as-unconditional-key`) drops the
constraint from the FD layer entirely, sacrificing real wins:

```sql
-- Today (post-conservative-fix): DISTINCT not eliminated even though it's redundant.
select distinct c from t where status = 'active';

-- Today: cannot prove the FK→partial-UNIQUE join is reducible.
select a.*, t.c
from a join t on a.t_id = t.id
where t.status = 'active';   -- t.c determined by t.id under this filter

-- Today: GROUP BY c, status not simplifiable to GROUP BY id when filter implies P.
select c, status, sum(amt) from t where status = 'active' group by c, status;
```

In each case, the query's WHERE clause implies the partial-index predicate.
A "sufficiently smart" optimizer should lift the conditional FD to
unconditional within that scope.

## Use cases

- **Active/inactive, archived/live, deleted/visible** patterns: partial
  UNIQUE on the visible subset is the standard SQL idiom for "uniqueness
  among the rows that matter," and queries against the visible subset are
  the common case.
- **Tenant-scoped uniqueness** with a global table:
  `create unique index ix on t(slug) where tenant_id = current_tenant()`
  paired with `select distinct slug from t where tenant_id = ?`.
- **Soft-delete tables**: partial UNIQUE excluding tombstones; routine
  reads filter out tombstones and want the same shape.

## Specification

A partial UNIQUE on columns `K` with predicate `P` should expose:

- A *conditional FD* `K → all-other-cols [given P]` attached to the table
  reference's physical properties.
- A *conditional key* entry on the relation type (or a separate
  `conditionalKeys` field), carrying both `K` and the predicate `P`.

Discharge rule: at any point in the plan tree where a `Filter` (or other
predicate-bearing operator) sits above the table reference, if the
filter's normalized conjunction implies `P`, then the conditional FD
becomes unconditional in the scope above the filter. The lifted FD
participates in all downstream rules without further qualification.

### Predicate implication

Full semantic implication is undecidable in general. Ship in stages:

1. **Syntactic match** — the predicate-conjuncts util
   (`predicate-conjuncts.ts`, already on this branch) decomposes both
   filter and partial-index predicate into normalized conjunctions; lift
   when every conjunct of `P` appears verbatim in the filter
   (modulo column-ref normalization, equivalence-class substitution).
2. **Equality-class aware** — extend the syntactic match to use the
   same equivalence-class machinery the planner already maintains, so
   `status = 'active'` in the filter discharges `'active' = status` in
   the predicate.
3. **Range subsumption** — the index has `where age >= 18`; the filter
   has `where age >= 21`. The filter implies the index predicate.
   Requires a small interval/comparison reasoner.
4. **Boolean implication beyond conjunction** — out of scope for v1.

Stages 1–2 capture the common `where status = 'active'` style cases; stage
3 captures the common range-soft-deletion-window cases; stage 4 is rarely
worth the complexity.

## Data-shape sketch

Two viable shapes; pick during plan stage:

```ts
// (a) Augment FunctionalDependency.
interface FunctionalDependency {
  determinants: number[];
  dependents: number[];
  condition?: ScalarPlanNode;   // when set, FD holds only where condition is true
}

// (b) Carry conditional keys separately on RelationType / PhysicalProperties.
interface ConditionalKey {
  columns: number[];
  predicate: ScalarPlanNode;
}
type RelationType = { ...; keys: ColRef[][]; conditionalKeys?: ConditionalKey[] };
```

(a) keeps all FD-aware code on one surface but forces every consumer to
think about `condition`. (b) keeps unconditional FDs simple and isolates
the discharge logic to the few rules that want to capitalize.

(b) is probably the cleaner starting point, with the discharge step
materializing unconditional FDs/keys above any qualifying Filter.

## Tests to drive the design

- Conservative-fix regression tests still pass.
- `select distinct c from t where status = 'active'` — DISTINCT *is*
  eliminated (filter implies the partial-index predicate).
- `select distinct c from t where status = 'inactive'` — DISTINCT is
  *not* eliminated.
- `select distinct c from t` (no filter) — DISTINCT is *not* eliminated.
- Same matrix for GROUP BY simplification, ORDER BY trailing-key pruning,
  and FK→PK join elimination using a partial UNIQUE.
- Equivalence-class discharge: filter `where 'active' = status` discharges
  index `where status = 'active'`.

## Out of scope

- Full semantic predicate implication (SAT-style); range subsumption is
  the practical ceiling for this ticket.
- Capitalizing on partial *non-UNIQUE* indexes — they don't carry an FD
  to lift in the first place.
- Multi-index intersection (e.g. two partial UNIQUEs whose predicates
  jointly cover the table). Each is independently discharged today.
