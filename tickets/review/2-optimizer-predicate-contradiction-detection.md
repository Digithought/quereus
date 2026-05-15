---
description: Review of predicate-contradiction-detection optimizer rule that folds unsatisfiable Filter predicates (combined with source domainConstraints + literal constantBindings) to EmptyRelationNode.
prereq: optimizer-empty-relation-node, optimizer-check-derived-fds-and-domains
files:
  - packages/quereus/src/planner/analysis/sat-checker.ts                            # NEW — checkSatisfiability + ColumnAccumulator
  - packages/quereus/src/planner/rules/predicate/rule-filter-contradiction.ts        # NEW — filter rule
  - packages/quereus/src/planner/optimizer.ts                                        # registration: Structural pass, priority 27
  - packages/quereus/test/optimizer/predicate-contradiction.spec.ts                  # NEW — 17 unit + 6 e2e tests
  - packages/quereus/test/performance-sentinels.spec.ts                              # NEW sentinel: planning a 50-col WHERE
  - docs/optimizer.md                                                                # NEW subsection "Predicate contradiction detection"
---

## What landed

A two-file optimizer rule that detects when a `FilterNode`'s predicate is
provably unsatisfiable given the source's declared facts, and rewrites the
node to `EmptyRelationNode(filter.getAttributes(), filter.getType())`. The
existing const-fold cascade (Structural priority 27 — Project / Sort /
LimitOffset / Distinct / inner-or-cross-or-semi-anti Join) then collapses
the surrounding subtree.

The reasoning is a single-pass per-column accumulator (`sat-checker.ts`)
over the AND-conjuncts of the predicate, the source's
`PhysicalProperties.domainConstraints`, and the source's literal
`ConstantBinding`s. It tracks:

  - tightest range bounds (with inclusive/exclusive arithmetic),
  - allowed-value set (from IN-lists + enum domains),
  - excluded values (from `!=` / `<>`),
  - a per-column `sawUnknown` flag for clauses outside the recognized
    fragment (LIKE, function calls, OR-trees, IS NULL, NOT, parameter
    bindings, cross-column comparisons, …).

The decision rule: return `unsat` when an in-scope subset proves a
contradiction (empty range, empty allowed-values after intersection,
allowed-value pinched by an exclusion). Otherwise `sat` if no column was
flagged unknown, else `unknown`. The rule only fires on `unsat` — `sat` /
`unknown` leave the plan unchanged. **No false `unsat` is possible by
construction.**

### Where it integrates

  - Reads `child.physical.domainConstraints` (populated by the CHECK
    extraction landed in ticket #1) and `child.physical.constantBindings`.
  - Uses `splitConjuncts` from `predicate-conjuncts.ts` (existing shared
    helper) and `flipComparison` from `predicate-shape.ts` (existing).
  - Uses `compareSqlValues` from `util/comparison.ts`, with the source
    column's declared `collationName` when present (text-comparison
    correctness for NOCASE / RTRIM columns).
  - Registered in `optimizer.ts` at Structural pass priority 27, alongside
    `rule-empty-relation-folding`. The new rule is registered **before**
    `fold-filter-empty` so the registry's priority-stable insertion places
    it earlier in the Filter rule list. Either ordering is correct: the
    new rule returns `EmptyRelationNode` directly, not `Filter(_, false)`,
    so cascade is unnecessary.

### Decisions worth flagging to the reviewer

  - **Emits `EmptyRelationNode` directly** (not `Filter(child, false)`).
    The plan ticket's text predates the landed `optimizer-empty-relation-node`
    work and described `Filter(child, false)` as the conservative shape to
    use until that prereq landed. Both prereqs are in `tickets/complete/`
    now, so the cleaner shape works directly — and matches the existing
    `rule-anti-join-fk-empty.ts` precedent (priority 26). Reviewer should
    confirm the schema-polymorphic Empty does what every immediate parent
    expects.
  - **Inner-join `on`-clause variant is NOT registered.** The ticket's
    decision section described this as deferred behind the empty-relation
    prereq, but said even if the prereq lands the filter rule alone covers
    the canonical case (predicate-pushdown moves WHERE conjuncts onto the
    lowest possible Filter). Shipping the join-on variant adds value only
    for `on`-clauses that can't be pushed (typically references-both-sides
    predicates). I left it out per the plan; if the reviewer wants it
    enabled, the same checker can be reused — see "Out of scope" below.
  - **OR / CASE remain out of scope.** Splitting on OR demands
    case-decomposition (every branch must independently fail). The plan
    ticket explicitly rules that out. OR sub-trees set `sawUnknown` on
    every column they reference.
  - **Parameter bindings contribute nothing.** A `ConstantBinding` with
    `kind: 'parameter'` is constant within one execution but unknown at
    plan time — using it to prove `unsat` would be wrong. The unit test
    `parameter binding contributes no facts` pins this.
  - **NULL handling is conservative.** Any literal `NULL` in a comparison
    yields UNKNOWN at runtime, not FALSE, so the conjunct is treated as
    out-of-scope (`sawUnknown`). `IS NULL` / `IS NOT NULL` are similarly
    out-of-scope for v1 because `DomainConstraint` doesn't yet express
    "NULL allowed". The negative test `WHERE x >= 5 AND x <= 5` proves
    we don't over-conclude on edge cases.
  - **Per-column `sawUnknown`** (not global). A LIKE on column `b` must
    not block a range contradiction on column `a`. Pinned by the unit
    test `mixed: in-scope contradiction wins over unrelated unknown`.

## How to validate

  - `yarn workspace @quereus/quereus run lint` — clean.
  - `yarn test` (from repo root) — 3127 passing, including 23 new tests
    in `test/optimizer/predicate-contradiction.spec.ts`.
  - Build (`tsc --noEmit`) — clean.

### Test floor (not a ceiling — reviewer should poke at gaps)

Unit (`checkSatisfiability`, 17 tests):

  - Range collapse, equality conflict, enum × enum disjoint, enum × range
    disjoint, inclusive boundary contradiction, inclusive boundary
    positive (sat), disequality + point, out-of-scope only (unknown),
    mixed in-scope + unknown, domain × predicate, temporal (ISO date
    strings via `compareSqlValues`), binding × predicate, parameter
    binding inertness, flipped comparison normalization, generic sat, NULL
    literal safety, NOT (...) out-of-scope safety.

End-to-end (Database planning + execution, 6 tests):

  - `CHECK(qty >= 0) + WHERE qty < 0` → EMPTYRELATION op, zero rows, no SeqScan.
  - `CHECK(status IN ('a','i')) + WHERE status = 'x'` → empty.
  - `WHERE x BETWEEN 0 AND 5 AND x BETWEEN 10 AND 20` → empty.
  - **Negative**: `WHERE x >= 5 AND x <= 5` returns the matching row (no fold).
  - **Negative**: `CHECK(qty>=0) + WHERE qty<0 AND name LIKE '%foo'` still folds
    (unknown clause does not block in-scope contradiction).
  - **Negative**: non-contradicting WHERE leaves the plan intact.

Planning-time sentinel: 50-column wide SELECT with 50-conjunct non-
contradicting WHERE plans 50 times under 2 s. Verifies the checker is
linear in conjuncts × mentioned columns, not super-linear.

### Known gaps for the reviewer to push on

  - **No tests for partial-domain-vs-predicate combinations.** E.g.,
    domain `[0, ∞)` ∩ `x = -5` is tested via the broader e2e fold, but I
    don't have a unit test that walks `column = literal` against a
    half-bounded domain at the checker level. The boundary collapse logic
    is correct (see `withinRange`) but explicit coverage would harden it.
  - **No test for IN-list with NULL entries.** `intersectAllowed` filters
    NULLs out before intersecting (NULL-in-IN doesn't match anything via
    `=`). Behavior is correct; not explicitly pinned.
  - **No test for the `MAX_CONJUNCTS = 64` / `MAX_VALUES_PER_COL = 64`
    caps**. They mirror existing `MAX_FDS_PER_NODE` style caps; pathological
    plans bail out to `unknown`. A pathological-input test would be cheap.
  - **No test that a `Filter(_, lit-false)` input is correctly skipped by
    our rule** (the guard at the top of `ruleFilterContradiction`). The
    cascade still produces EMPTYRELATION via the existing fold rule, so
    the user-visible behavior is unaffected, but the guard isn't directly
    pinned.
  - **No cascade-shape test**: e.g., `Project(Sort(Filter(t, unsat)))` →
    EMPTYRELATION at the top. The const-fold pass tests in
    `empty-relation.spec.ts` exercise that machinery, and the e2e tests
    above show the cascade firing, but a multi-level cascade specifically
    via the contradiction rule isn't pinned.
  - **The new planning-time sentinel** uses `db.prepare` + `finalize`
    in a hot loop. If `db.prepare` short-circuits beyond what I expect
    (e.g., re-uses a parse cache), the sentinel may not exercise the
    optimizer 50 times. Worth confirming.

## Out of scope (carry-forward, not started here)

These were explicit in the original ticket and remain unimplemented:

  - Inner-join `on`-clause contradiction rule. Reusable infra is already
    in `sat-checker.ts` — the new rule would build a unified attrId-index
    over `[left attrs] ++ [right attrs]`, conjoin both sides' domains and
    bindings, and (since EmptyRelationNode is now landed) emit
    `EmptyRelationNode(join.getAttributes(), join.getType())`. Worth a
    follow-up ticket.
  - LIKE pattern intersection, cross-column arithmetic, outer-join `on`
    contradiction → null-padded scan rewrite, DPLL / SAT over Boolean
    structure (OR/CASE branches), in-source domain intersection (merging
    overlapping range/enum domains on the same column).

## End
