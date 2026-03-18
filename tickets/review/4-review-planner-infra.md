description: Systematic review of planner infrastructure (framework, cost, cache, validation, debug)
dependencies: none
files:
  packages/quereus/src/planner/framework/characteristics.ts
  packages/quereus/src/planner/framework/context.ts
  packages/quereus/src/planner/framework/pass.ts
  packages/quereus/src/planner/framework/physical-utils.ts
  packages/quereus/src/planner/framework/registry.ts
  packages/quereus/src/planner/framework/trace.ts
  packages/quereus/src/planner/cost/index.ts
  packages/quereus/src/planner/debug/logger-utils.ts
  packages/quereus/src/planner/cache/correlation-detector.ts
  packages/quereus/src/planner/cache/materialization-advisory.ts
  packages/quereus/src/planner/cache/reference-graph.ts
  packages/quereus/src/planner/validation/determinism-validator.ts
  packages/quereus/src/planner/validation/plan-validator.ts
  packages/quereus/src/planner/util/key-utils.ts
  packages/quereus/src/planner/debug.ts
  packages/quereus/src/planner/optimizer.ts
  packages/quereus/src/planner/optimizer-tuning.ts
  packages/quereus/src/planner/planning-context.ts
  packages/quereus/src/planner/resolve.ts
  packages/quereus/src/planner/type-utils.ts
----
Review planner infrastructure: optimizer framework (passes, registry, context), cost model, plan caching (correlation detection, materialization advisory, reference graph), plan validation, and debug utilities.

Key areas of concern:
- Optimizer pass ordering and convergence
- Cost model accuracy and edge cases
- Correlation detection correctness
- Materialization advisory decision quality
- Plan validator completeness (catches invalid plans)
- Determinism validator accuracy
- Reference graph correctness for dependency tracking

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
