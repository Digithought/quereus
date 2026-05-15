---
description: Once the soundness fix (`fd-partial-unique-index-treated-as-unconditional-key`) lands, partial UNIQUE indexes contribute nothing to the FD layer. They could — a partial UNIQUE on `(c) where P` proves `c → all-other-cols` for any sub-relation whose row predicate implies `P`. Capture that as a *conditional* FD and discharge it when the surrounding query's normalized predicate subsumes the partial-index predicate. Realizes the optimizer benefit that motivated allowing partial UNIQUEs in the first place.
files:
  packages/quereus/src/planner/type-utils.ts
  packages/quereus/src/planner/nodes/reference.ts
  packages/quereus/src/planner/nodes/plan-node.ts          # FunctionalDependency type
  packages/quereus/src/planner/util/fd-utils.ts            # isSuperkey / hasAnyKey / addFd
  packages/quereus/src/planner/util/predicate-conjuncts.ts # candidate site for implication check
  packages/quereus/src/planner/rules/distinct/rule-distinct-elimination.ts
  packages/quereus/src/planner/rules/predicate/             # rule-predicate-inference-equivalence and friends
  packages/quereus/src/planner/rules/join/                  # rule-join-elimination (FK→PK)
  packages/quereus/src/schema/table.ts                     # UniqueConstraintSchema.predicate
---

## Why

A partial UNIQUE index `create unique index ix on t(c) where P` legitimately
implies functional dependency `c → all-other-cols-of-t` over any view of `t`
whose rows all satisfy `P`. Today (after the soundness fix) we throw that
information away. Queries like `select distinct c from t where P` cannot
eliminate the DISTINCT even though it is provably redundant, and analogous
opportunities exist for GROUP BY simplification, ORDER BY pruning, and
FK→PK join elimination.

## Shape of the change

Two interacting pieces:

1. **Carry the condition.** Either:
   - **(a)** Extend `FunctionalDependency` (`plan-node.ts`) with an optional
     `condition?: ScalarPlanNode` field — encodes "this FD holds wherever
     `condition` evaluates to TRUE." `addFd` / `isSuperkey` / `hasAnyKey`
     treat conditional FDs as not-yet-applicable until lifted.
   - **(b)** Keep `FunctionalDependency` unconditional and carry partial
     UNIQUEs separately on `RelationType` (or on the table-reference node)
     as `conditionalKeys: { columns: number[]; predicate: ScalarPlanNode }[]`,
     converting to FDs only at the point the condition is discharged.

   (b) keeps the existing FD shape simple; (a) is more uniform but touches
   every FD consumer. Lean toward (b) unless implementing this exposes a
   real reason to need conditions on arbitrary derived FDs.

2. **Discharge the condition.** When a `Filter` node sits above the table
   reference (or any relational node carrying conditional FDs), check
   whether the filter's normalized predicate **implies** the conditional
   predicate. If yes, emit an unconditional FD/key on the filter's output.

   Predicate implication is undecidable in general. Ship a syntactic
   check first:
     - Reuse `predicate-conjuncts.ts` to decompose both predicates into a
       conjunction set.
     - The conditional FD discharges if every conjunct of the partial-index
       predicate appears (modulo trivial normalization — column-name
       canonicalization, commutativity of `=` / `is`) in the filter's
       conjunct set.
     - This handles the common cases (`status = 'active'`, `deleted_at is null`,
       `archived = 0 and score > 80.0` where the query repeats the same
       AND-of-equalities). Full semantic implication (reasoning about
       inequalities, IN-lists, etc.) is a follow-up.

## Where conditional FDs come into play

After step 1: every downstream consumer that today reads `physical.fds`
must either (a) ignore conditional FDs entirely, or (b) only consume them
through the discharge path. Audit list:

- `rule-distinct-elimination` (logical-keys branch *and* FD branch)
- `rule-groupby-fd-simplification`
- `rule-orderby-fd-pruning`
- `rule-join-elimination` (FK→PK matching)
- `rule-predicate-inference-equivalence`
- Anything else querying `RelationType.keys` directly (grep
  `\.keys` under `planner/`).

## Tests to add

- `select distinct c from t where status = 'active'` over the partial-UNIQUE
  schema: DISTINCT **should** be eliminated (positive case for the
  discharge path).
- `select distinct c from t` (no filter, or filter that doesn't imply the
  partial predicate): DISTINCT **must NOT** be eliminated (already covered
  by the soundness-fix tests; assert it still holds).
- Mix: `where status = 'active' and other_col = 5` — still discharges,
  because the filter's conjunct set is a superset of `{status = 'active'}`.
- GROUP BY analogue: `select c, max(other) from t where P group by c` —
  group key is provably a superkey, redundant aggregations can be reduced
  per the existing groupby-fd-simplification rule.
- LEFT JOIN elimination analogue: `a left join t on a.c = t.c where t.status = 'active' is true on a's view…`
  — design carefully; the join-elim rule only applies when the right-side
  uniqueness is *guaranteed* for the rows reachable through the join,
  which may not be the same scope.

## Risks / things to watch

- **Implication soundness.** Syntactic matching must canonicalize column
  references via attribute IDs, not names, to avoid mismatches when the
  filter's predicate has been rewritten by other rules. The existing
  `predicate-conjuncts.ts` machinery already canonicalizes — reuse it.
- **Cost.** Discharge check runs once per Filter/Project boundary during
  optimization; cache the implication result on the filter node.
- **Plan stability.** Adding a new DISTINCT-elimination path may shift
  plan shapes used by other tests — expect to update some optimizer-plan
  fixtures.

## Prereq

Land `fd-partial-unique-index-treated-as-unconditional-key` first (in
implement/). That ticket guarantees soundness; this one re-opens the
optimization on solid ground.
