description: Systematic review of planner scopes, analysis passes, and statistics
dependencies: none
files:
  packages/quereus/src/planner/scopes/aliased.ts
  packages/quereus/src/planner/scopes/base.ts
  packages/quereus/src/planner/scopes/empty.ts
  packages/quereus/src/planner/scopes/global.ts
  packages/quereus/src/planner/scopes/multi.ts
  packages/quereus/src/planner/scopes/param.ts
  packages/quereus/src/planner/scopes/registered.ts
  packages/quereus/src/planner/scopes/scope.ts
  packages/quereus/src/planner/scopes/shadow.ts
  packages/quereus/src/planner/analysis/binding-collector.ts
  packages/quereus/src/planner/analysis/const-evaluator.ts
  packages/quereus/src/planner/analysis/const-pass.ts
  packages/quereus/src/planner/analysis/constraint-extractor.ts
  packages/quereus/src/planner/analysis/expression-fingerprint.ts
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/src/planner/stats/analyze.ts
  packages/quereus/src/planner/stats/basic-estimates.ts
  packages/quereus/src/planner/stats/catalog-stats.ts
  packages/quereus/src/planner/stats/histogram.ts
  packages/quereus/src/planner/stats/index.ts
----
Review planner scopes (name resolution), analysis passes (const evaluation, predicate normalization, constraint extraction), and statistics (histograms, cardinality estimation).

Key areas of concern:
- Scope resolution correctness (ambiguous names, shadowing, qualified names)
- Binding collector completeness (all column references found)
- Const evaluator correctness and safety
- Predicate normalizer — CNF/DNF conversion correctness
- Constraint extractor accuracy
- Expression fingerprint collision avoidance
- Histogram accuracy and bucket boundary handling
- Cardinality estimation edge cases (skew, correlation)

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
