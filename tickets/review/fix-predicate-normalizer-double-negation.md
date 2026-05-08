description: Predicate normalizer double-negation (and any NOT wrapping) was effectively dropped at SQL execution time. Fixed by normalizing FilterNode.getPredicates() output, mirroring JoinNode.
files:
  packages/quereus/src/planner/nodes/filter.ts (the fix)
  packages/quereus/src/planner/nodes/join-node.ts (consistency reference)
  packages/quereus/src/planner/analysis/predicate-normalizer.ts (unchanged — already correct)
  packages/quereus/src/planner/analysis/constraint-extractor.ts (consumer of getPredicates via walkPlanForPredicates)
  packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts (`trySortAbsorbViaIndexOrdering` consumes constraints from the plan walk)
  packages/quereus/test/optimizer/predicate-normalizer.spec.ts (the failing tests, now passing)
----

## What the bug was

`FilterNode.getPredicates()` (the `PredicateSourceCapable` interface implementation
used by plan-walk consumers like `extractConstraintsForTable`) returned the raw
unwrapped predicate, so any `NOT (...)`, `NOT NOT (...)` etc. predicate would
be visible to the constraint extractor as a `UnaryOp(NOT, ...)` node — which the
extractor cannot turn into a constraint and routes to "residual."

For queries with `ORDER BY`, `trySortAbsorbViaIndexOrdering` walks the plan
collecting constraints from FilterNodes on the path to a Retrieve. With NOT-
wrapped predicates, this walk returned **zero** constraints. With zero
constraints, the rule's residual-predicate computation did nothing, so it
produced an `index-style` `moduleCtx` with `residualPredicate = undefined`.
`ruleSelectAccessPath`'s index-style branch only re-attaches a Filter when
`moduleCtx.residualPredicate` is truthy — so the predicate was silently lost
between the planner and the physical leaf, and the WHERE clause had no effect.

`JoinNode.getPredicates()` already normalized its output for exactly this
reason; FilterNode just hadn't been brought into line.

## The fix

Make `FilterNode.getPredicates()` return `normalizePredicate(this.predicate)`
in line with `JoinNode.getPredicates()`. The normalizer's existing logic
(unchanged) collapses `NOT NOT P → P`, inverts comparison operators under a
single `NOT`, and pushes `NOT` through De Morgan AND/OR.

Note: `FilterNode.getPredicate()` (the `PredicateCapable` single-predicate
accessor used for plan rewriting) intentionally still returns the raw
predicate — rewriters that mutate the tree shouldn't see a normalized copy.
Only the analysis-facing `getPredicates()` plural form is normalized.

## How to verify

Run `yarn workspace @quereus/quereus test`:

- Before: 5 failing in `test/optimizer/predicate-normalizer.spec.ts`
  (`NOT NOT (a > 10)` and the four `NOT (a >|>=|<|<=) lit` inversion tests
  all returned all 5 rows instead of the filtered subset).
- After: 2526 passing, 0 failing.

The failing-then-passing cases all involve a WHERE clause with a `NOT`-wrapped
comparison and an `ORDER BY` (or any other shape that pulls
`extractConstraintsForTable` into the path). Direct AST tests in
`test/planner/predicate-normalizer.spec.ts` were already green and remain so —
this fix is at the boundary between FilterNode and the constraint-extraction
plan walk, not in the normalizer itself.

Three-valued-logic check: `NOT (a IS NULL)` test in the same suite continues
to pass; row 5 (`a IS NULL`) is still correctly excluded by the inverted
predicates because the runtime NOT preserves NULL semantics regardless of
how the planner extracts constraints.

## Reviewer focus

- `packages/quereus/src/planner/nodes/filter.ts` line ~141 — the diff is
  three lines. Confirm the contract change matches `JoinNode.getPredicates()`
  pattern (same file, scan around the `getPredicates()` method).
- Confirm no caller depends on `getPredicates()` returning the raw
  predicate (analysis layer only — rewriting layer uses the singular
  `getPredicate()`).
- Performance: `normalizePredicate` allocates new nodes only when it actually
  rewrites, so unmodified predicates are returned by reference. The plan walk
  already iterates predicates linearly; the cost is bounded by the predicate
  size, which is small.
