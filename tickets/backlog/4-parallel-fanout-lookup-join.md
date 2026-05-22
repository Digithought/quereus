description: FanOutLookupJoin physical node — for one outer row, fire N parameterized child sub-plans concurrently and assemble a wide result row. Generalizes the "N LEFT JOINs to one lookup table from one driving table" pattern; the biggest payoff operator in the parallel-* track.
prereq: parallel-driver-context-fork, parallel-vtab-concurrency-mode
files: packages/quereus/src/planner/nodes/, packages/quereus/src/runtime/emit/, packages/quereus/src/planner/rules/join/, packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/util/ind-utils.ts, packages/quereus/src/planner/cost/index.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/src/runtime/parallel-driver.ts
----

## Goal

A physical operator `FanOutLookupJoin(outer, children[], mode, attributeMap)`:

- One outer iterator.
- Per outer row, broadcast the row's bindings to N parameterized child sub-plans. Each child is shaped exactly like a `Retrieve` with declared `bindings`.
- Drive the N children concurrently via `ParallelDriver` on per-branch forked contexts.
- Combine per outer row according to `mode`:
  - `atMostOne` — FD-checked; emit NULLs on empty (LEFT semantics) or drop the outer row (INNER semantics) per branch's join type.
  - `array` — pack the branch's rows into a single JSON-array column.
  - `cross` — Cartesian per outer row (each combination of branch rows emitted).

## Use case

The motivating case from the design conversation: 5 LEFT JOINs from `orders` to `customers / products / shippers / warehouses / tax_zones`, each on FK→PK. Today these emit 5 nested-loop joins; over remote vtabs that's 5N sequential round-trips per outer row. With `FanOutLookupJoin` it's 5 concurrent round-trips per outer row (or fewer, capped by `tuning.parallel.concurrency`).

## Recognition rule

Lives next to `ruleJoinElimination` in `rules/join/`. Reuses `lookupCoveringFK` and the chain-walker pattern from `rule-join-elimination.ts`. Match pattern: Project (or Aggregate) over a chain of LEFT/INNER joins where:

- Each non-preserved side is a parameterized lookup with FK→PK alignment (same predicate as `tryEliminate`).
- The `ON` clause is a pure AND-of-column-equalities — no residual non-equi predicates (same restriction as `isAndOfColumnEqualities`).
- The chain has ≥ `tuning.parallel.minBranches` such joins from one common outer.

Cluster the matched joins into one `FanOutLookupJoin` whose children are the original right-side sub-trees, rewriting attribute references to point at the new flat schema.

## Cost-model integration

Two new tuning knobs in `OptimizerTuning`:

- `tuning.parallel.minBranches` (default 2) — don't form a fan-out below this.
- `tuning.parallel.branchSetupCost` — per-branch fixed overhead; charged against the latency win.

Two new physical-property fields on relational nodes:

- `concurrencySafe: boolean` — defaults true for read-only memory-vtab subtrees; false where the subtree mutates state or holds a non-reentrant cursor.
- `expectedLatencyMs: number` — cost-model-derived; 0 for memory-vtab paths; non-zero for remote-vtab paths once their cost model declares it.

The rule fires only when projected savings — `(N − concurrencyCap) × expectedLatencyMs` — exceed `N × branchSetupCost`. For local-only plans (`expectedLatencyMs = 0`), the rule must never fire.

## Properties

- **FD propagation.**
  - `atMostOne` mode: per-branch FDs are union'd into the join output; each branch contributes `∅ → branch_cols` for any LEFT branch (since the branch's matched-row identity is at-most-one per outer).
  - `array` mode: branch becomes a single JSON column; FDs reduce to `outer_keys → branch_array_col`.
  - `cross` mode: product of branch FDs as in today's `JoinNode`.
- **Ordering.** Outer ordering preserved (rows emitted in outer order). `cross` mode requires per-branch ordering documented if multiple rows per outer.
- **Nullability.**
  - `atMostOne` over a LEFT-joinable branch keeps nullable; over INNER, an empty branch drops the outer row (semantics identical to the chain of nested-loop joins it replaces).
- **Tracing.** Each branch is a sub-program; existing `Instruction.programs?: Scheduler[]` carries them so the tracer surfaces per-branch row events with branch index.

## Open questions for the plan agent

- **Connection allocation.** With memory vtab `fully-reentrant`, all branches share one connection. With future `reentrant-reads` plugins, the driver needs a policy — share until contention, then allocate? Acquire fresh per branch always? Decide in plan.
- **`Aggregate` entry point.** `ruleJoinEliminationUnderAggregate` already handles the aggregate-over-chain case; whether `FanOutLookupJoin` should fold into that path (Aggregate over fan-out) or only fire on Project entrypoints is a plan decision.
- **Plan-shape regression risk.** This rule rewrites very common join chains; golden-plan churn will be substantial. Plan a single sweep to update goldens rather than dribbling.

## Out of scope

- Lateral fan-out (`cross apply`-style) where branch cardinality is fully data-driven beyond `atMostOne`. Track as a future ticket if a real use case appears.
- Adaptive concurrency based on observed branch latency. Static cap only in v1.
- Statistics-driven branch-ordering optimizations (issue the slowest branch first).
