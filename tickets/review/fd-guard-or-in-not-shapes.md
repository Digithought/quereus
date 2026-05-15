---
description: Extended guard-clause vocabulary to accept OR-form, IN-list, and `NOT col` predicates on both producer (partial UNIQUE) and consumer (`predicateImpliesGuard`) sides. Reviews should focus on soundness of the discharge rules, edge cases in IN/NOT recognition, and the runtime-side IN support in the memory-vtab partial-index predicate compiler.
files:
  packages/quereus/src/planner/nodes/plan-node.ts
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/src/planner/analysis/predicate-shape.ts
  packages/quereus/src/planner/analysis/check-extraction.ts
  packages/quereus/src/vtab/memory/utils/predicate.ts
  packages/quereus/test/optimizer/conditional-fds.spec.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  docs/optimizer.md
---

## Summary

Implemented Option 1 from the plan ticket: extended `GuardClause` with one new
variant (`or-of`) and pre-normalized `IN (lit, …)` and `NOT col` at recognition
time into clauses the existing vocabulary already covers. Producer and consumer
apply the same normalization so they remain in lockstep.

## What landed

### Phase 1 — Vocabulary + projection plumbing

- `packages/quereus/src/planner/nodes/plan-node.ts`: added `or-of` to the
  `GuardClause` union with a doc note explaining the flattening / normalization
  invariants.
- `packages/quereus/src/planner/util/fd-utils.ts`:
  - `guardClauseEquals`: added an `or-of` case with order-insensitive
    sub-clause comparison (same `used[]` technique as `guardsEqual`).
  - Refactored `projectGuard` to delegate to a `projectClause` helper that
    recurses through `or-of` sub-clauses; conservatively drops the whole
    `or-of` if any nested column drops out of the mapping.
  - Refactored `shiftGuard` similarly via a `shiftClause` helper that recurses
    through `or-of`.
- `packages/quereus/src/planner/analysis/predicate-shape.ts`: moved
  `flattenDisjunction` here from `check-extraction.ts` (one new export) so
  both CHECK and partial-UC recognizers share it.
- `packages/quereus/src/planner/analysis/check-extraction.ts`: removed the
  local `flattenDisjunction` definition and imports the shared one.

### Phase 2 — Producer (partial UNIQUE)

- `packages/quereus/src/planner/analysis/partial-unique-extraction.ts`:
  - Doc comment expanded to cover the new shapes and soundness notes.
  - `recognizeClause` now accepts:
    - `NOT col` → `eq-literal { col, value: 0 }`, but **only** on
      declared-NOT-NULL columns (NOT-NULL gate is syntactic).
    - `col IN (lit, …)` → `or-of [eq-literal …]` (singleton collapses).
    - top-level `OR` → `or-of [recognize(d), …]` (singleton collapses;
      nested `or-of` is flattened).
  - New helpers `recognizeIn` and `recognizeOr`. IN-with-subquery, non-literal
    IN values, and any disjunct that can't itself be recognized all return
    `undefined`, dropping the whole FD (the soundness rule unchanged).
  - `recognizeClause` now takes an `isColumnNotNullDeclared` predicate so it
    can gate `NOT col`.

### Phase 3 — Consumer (`predicateImpliesGuard`)

- `packages/quereus/src/planner/util/fd-utils.ts`:
  - `PredicateFacts` gained a new field: `inListEqs: Map<col, Set<value>>`.
  - `buildPredicateFacts`:
    - Walks `InNode` (when `source` is undefined and all `values` are
      literal-only via the existing `literalSqlValueOf`). When the same column
      has IN-lists in multiple conjuncts, the intersection is captured
      (`AND` semantics). Singleton IN also pins `literalEqs`.
    - On `UnaryOpNode` with `operator === 'NOT'` and a column-reference
      operand, pins `literalEqs(col, 0)` *and* `isNotNullCols.add(col)`.
      (`NOT col` excludes NULL — useful for cross-shape discharge.)
  - `clauseEntailed` gained the `or-of` case: any sub-clause directly
    entailed → OR entailed; otherwise the pure-IN specialization
    (`inListEntailed`) checks that every sub-clause is `eq-literal` on the
    same column, then asks whether the filter pins that column to a subset
    of the OR-set via `literalEqs`, `inListEqs`, EC peers, or
    `ConstantBinding`.
  - New helpers `inListEntailed` and `candidateColumns` (EC + binding
    expansion).

### Runtime fallout — memory-vtab partial-index predicate compiler

- `packages/quereus/src/vtab/memory/utils/predicate.ts`:
  - Added an `in` case to `compileExpression` (and a new `compileIn` helper)
    so CREATE UNIQUE INDEX with `WHERE col IN (lit, …)` now compiles. Without
    this the new sqllogic and end-to-end test cases would have failed at
    `CREATE UNIQUE INDEX`. Three-valued semantics match the existing pattern
    (no match + NULL ⇒ NULL).

### Phase 4 — Tests

`packages/quereus/test/optimizer/conditional-fds.spec.ts` gained:

- `predicateImpliesGuard` cases for the new `or-of` shape:
  - IN-list filter → OR-set guard discharges.
  - Singleton `=` filter as a subset of the OR-set discharges.
  - Filter literal outside OR-set does NOT discharge.
  - IN filter with one literal outside the OR-set does NOT discharge.
  - Mixed `is-null OR eq-literal` guard: each disjunct individually
    discharges; unrelated filter does not.
  - `NOT col` filter discharges `eq-literal { col, 0 }` guard.
  - `col = 0` filter likewise (symmetric).
  - EC-peer discharge: column pinned via EC pulls through the `or-of`.
  - Conservative pin: a top-level `OR` *predicate* contributes no facts
    (the AND-walker behaviour is unchanged).
- Producer recognizer cases:
  - `IN (a, b)` → `or-of` with two `eq-literal`s.
  - `IN (a)` collapses to bare `eq-literal`.
  - `IN (?)` (parameter) → recognizer bails.
  - Top-level OR → `or-of`.
  - 3-way OR → flat 3-element `or-of`.
  - `NOT col` on declared NOT NULL → `eq-literal { col, 0 }`.
  - `NOT col` on nominally-nullable column → rejected.
  - OR with one unrecognized disjunct → whole predicate dropped.
- fd-utils equality / projection:
  - `addFd` treats two `or-of` clauses with the same sub-clauses in
    different orders as equal.
  - `addFd` keeps `or-of [A,B]` and `or-of [A,C]` side-by-side.
  - `projectFds` drops an `or-of` guarded FD when any nested column is
    unmapped; remaps when all survive.
  - `shiftFds` shifts nested sub-clause columns.
- End-to-end:
  - Partial UNIQUE `WHERE status IN ('active', 'pending')`: subset filter
    activates; wrong literal does not; mixed superset filter does not.
  - Partial UNIQUE `WHERE deleted_at IS NULL OR status = 'archived'`:
    either disjunct in the filter activates; unrelated filter does not.
  - Partial UNIQUE `WHERE NOT archived` (declared NOT NULL int): filter
    `archived = 0` and `NOT archived` both activate; `archived = 1` does
    not.

`packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic` gained sections
7i / 7j / 7k that exercise IN, NOT, and OR partial UNIQUE shapes end-to-end
(positive INSERT-conflict + DISTINCT correctness + outside-scope dupes).

### Phase 5 — Docs

`docs/optimizer.md`:

- `GuardClause` type signature updated.
- The Partial UNIQUE conjunct table now includes `NOT col`, `col IN (…)`, and
  top-level OR, with a paragraph explaining the `or-of` flattening / singleton
  collapse rules and the soundness note about the `NOT col` → `col = 0` rewrite
  under three-valued logic.
- `predicateImpliesGuard` summary updated to describe the new IN / NOT /
  `or-of` discharge paths.

## Validation

- `yarn workspace @quereus/quereus run lint` — passes (no output, exit 0).
- `yarn workspace @quereus/quereus run test --grep "conditional-fds|predicateImpliesGuard|Conditional FDs|fd-utils|Partial UNIQUE|extractPartialUniqueGuardedFds|extractCheckConstraints"` — 139 passing, 0 failing.
- `yarn workspace @quereus/quereus run test --grep "10.5.1"` — 1 passing
  (sqllogic file covers all sections).
- `yarn workspace @quereus/quereus run test` — 3060 passing, 2 pending, 0
  failing.
- `yarn test` — same: 3060 passing, 2 pending, 0 failing.

Not run (out of agent scope per ticket): `yarn test:store` and `yarn test:full`.

## Things the reviewer should poke at

### Soundness probes

1. **`NOT col` rewrite on nullable columns.** Producer rejects `NOT col` on
   nominally-nullable columns to avoid double-counting the NULL-exclusion
   across the NOT-NULL gate and the rewrite. Consumer-side, `buildPredicateFacts`
   *does* set `isNotNullCols.add(col)` for `WHERE NOT col` — this is sound
   because `WHERE NOT col` excludes NULL rows anyway, but it means a `NOT col`
   filter on a nullable column will discharge `is-null negated:true` guards.
   Worth thinking about whether any downstream consumer reads `isNotNullCols`
   for purposes beyond guard discharge that the new addition could mislead.

2. **IN-list intersection.** When `buildPredicateFacts` sees the same column
   in multiple IN-list conjuncts, it intersects the sets (AND semantics:
   `col IN (a,b) AND col IN (b,c)` ⇒ `{b}`). Confirm the intersection
   captures the right `Set<SqlValue>` equality semantics — currently uses
   `sqlValueEquals` (handles Uint8Array but not deep object equality;
   matches the existing `literalEqs` behavior). Any unusual `SqlValue`
   subtypes (e.g. structured values) should be considered.

3. **`IN (NULL, 'a')` recognition.** The producer recognizer admits literal
   `NULL` because `literalValue` returns the `SqlValue` for any non-Promise
   literal expression. That seems fine — NULL is a literal `SqlValue` — and
   the resulting `eq-literal { column, value: null }` will only discharge if
   the filter actually pins the column to `NULL`, which equality predicates
   don't do (they use IS / IS NOT NULL instead). Worth confirming the
   end-to-end behaviour matches expectations: producer accepts; consumer
   discharges only when `IS NULL` would, which seems sound but subtle.

4. **`or-of` subsumption in `addFd`.** Two `or-of` guards with the same
   sub-clauses in different orders are compared equal by `guardClauseEquals`
   → fdsEqual subsumes them. Two `or-of` guards with different sub-clauses
   coexist. That matches the existing behavior for non-`or-of` guards but is
   worth confirming on the merge path inside `mergeFds`.

5. **Out-of-scope shapes inside CHECK implication.** The ticket explicitly
   keeps IN / NOT / OR shapes inside `recognizeNegatedGuard` (CHECK
   implication) out of scope. The behavior there is unchanged — those
   disjuncts still cause `handleImplication` to bail. A backlog ticket
   (`fd-check-implication-or-in-shapes`) is suggested in the doc comment if
   a use case shows up.

### Implementation gaps / known limits

- The plan ticket called out a "Reviewer probe" about `WHERE NOT col` on a
  nullable column: per the recommendation (option (c)), the producer rejects
  this — implemented. If you decide option (a) — teach the NOT-NULL gate
  about `NOT col` — that's a follow-up.
- Standalone `col` (truthy test, no NOT) is still unrecognized at the
  producer. Only `NOT col` is.
- Function-call or cast-wrapped column references inside IN / NOT shapes
  remain unrecognized (out of scope, filed as backlog).
- The memory-vtab partial-index predicate compiler now handles literal-only
  IN; it does NOT handle IN subqueries or non-literal value expressions in
  the IN list. Anyone building partial indexes with those shapes will get a
  `QuereusError` at `CREATE UNIQUE INDEX` time (the same shape as before for
  any unsupported expression).

### Test floor, not ceiling

The new tests cover the happy paths and the named-edge cases from the
ticket. Reviewer probes that might warrant more tests:

- `col IN (NULL, lit)` end-to-end (recognizer accepts; consumer behavior?).
- Multi-conjunct partial predicates that mix IN with `IS NOT NULL` or
  `eq-column` (composite-UC variants).
- IN-list inside a top-level OR (e.g. `WHERE status IN (...) OR deleted_at IS NULL`).
  The recognizer accepts because each disjunct is recognized — confirm the
  end-to-end discharge.
- An `or-of` with `eq-column` and `is-null` mixed sub-clauses (currently
  only the pure-IN specialization gets the subset-pinning logic; mixed-shape
  `or-of` only discharges sub-clause-by-sub-clause).

## Out of scope

Per the implement ticket, the following are deferred and **not** implemented:

- IN / NOT / OR inside CHECK implication disjuncts.
- Standalone `col` truthiness predicates.
- Function-call / cast-wrapped column references in IN / NOT shapes.
- General CNF/DNF rewriting beyond the four bullets in the implement plan.
