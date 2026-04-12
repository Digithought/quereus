# Progressive Query Optimization

This document describes the progressive, JIT-inspired query optimization strategy used by Quereus. It assumes familiarity with `docs/optimizer.md` (pass framework, rule system, cost model) and `docs/runtime.md` (instruction emission, scheduler, streaming execution).

The progressive optimizer addresses a fundamental tension: **time spent optimizing vs. time saved executing**, in an environment where statistics collection is itself expensive. Quereus targets distributed deployments where BTree nodes are stored across a DHT — every I/O operation may traverse the network, making full-table scans for statistics collection prohibitively costly. The optimizer must produce good plans with zero pre-collected statistics, then improve plans cheaply using feedback from essential query execution.

---

## 1. Design Principles

| Principle | Implication |
|---|---|
| **Stats are hints, not prerequisites** | Missing statistics produce graceful degradation to heuristics, not bad plans. |
| **Never block on optimization** | Every query has a runnable plan immediately. Optimization improves it, never gates it. |
| **Robust worst-case** | Heuristic defaults avoid catastrophic plans (O(n*m) joins, full scans on PK lookups) without any data. |
| **Cheap instrumentation** | Runtime monitoring piggybacks on existing pipeline breakers. No new materialization points for observation. |
| **Monotonic improvement** | Plan quality only improves over a query's lifetime. Cooling periods prevent thrashing. |
| **Streaming-first** | Consistent with the core architecture: favor pipeline-able operators, detect problems early, replace plans between executions without wasting materialized data. |

---

## 2. Optimization Tiers

The optimizer assigns each query execution an optimization tier based on available information and execution history. Tiers are not mutually exclusive — a query progresses through tiers as information accumulates.

### Tier 0: Heuristic Plan

The baseline tier. No cost model evaluation, no statistics lookup. Applies only transformations that are correct and beneficial regardless of data distribution:

- **Predicate pushdown** — always reduces work
- **Index seek on equality match** — when an equality predicate matches an available index, prefer the seek. Avoids the worst-case scan-when-PK-lookup-exists
- **Hash join over nested loop** for non-trivial inputs — O(n+m) vs O(n*m) worst case
- **Projection pruning** — reduces intermediate row width
- **Subquery decorrelation** — eliminates N+1 execution patterns
- **Filter merge** — consolidates adjacent filters
- **Distinct elimination** — removes DISTINCT when source is already unique

These transformations define the **worst-case floor**. The plan is not optimal, but it avoids catastrophic choices. Tier 0 is the appropriate level for DDL statements, simple lookups, ad-hoc queries, and the first execution of any query pattern where no statistics are cached.

Implementation: the PassManager runs passes 0–1 (constant folding, structural transformations) plus a restricted pass 2 that applies heuristic-only physical selection — index seek for matched equality, hash join for multi-row joins, stream aggregate when input is ordered, hash aggregate otherwise.

### Tier 1: Cost-Based Plan

The full multi-pass optimization pipeline, corresponding to the current optimizer described in `docs/optimizer.md`. This tier runs when cached statistics are available — either from vtab-supplied metadata or from the runtime stats overlay. All five passes execute: constant folding, structural transformations, physical selection, post-optimization, and validation.

Key constraint: Tier 1 **never blocks waiting for statistics**. It uses whatever is cached at the time of optimization. When stats are missing for a particular table or predicate, the cost model falls back to heuristic defaults for that specific decision, while using available stats everywhere else. This produces a plan that is partially cost-optimized and partially heuristic — strictly better than Tier 0.

Tier selection favors Tier 1 when vtab-supplied statistics are available at no I/O cost. `MemoryTable`, for instance, provides exact row counts and distinct-value estimates from BTree metadata via `getStatistics()`. For these modules, Tier 1 runs even on first execution. The tier system respects the cost of stat collection: free stats trigger Tier 1; expensive stats stay at Tier 0 until execution feedback accumulates.

### Tier 2: Feedback-Refined Plan

After query execution, runtime cardinality monitors compare actual row counts against plan estimates. When actual counts diverge significantly from estimates (threshold: >10x), the runtime stats overlay is updated and the plan is marked for re-optimization on next use.

Re-optimization is selective: structural passes (predicate pushdown, projection pruning, subquery decorrelation) are skipped because they are correct regardless of cardinality. Only pass 2 (physical selection) re-runs with the updated stats context. This is cheaper than full optimization and targets exactly the decisions that depend on cardinality — access path choice, join strategy, aggregate strategy.

The result is that a query pattern improves automatically across executions. The first execution uses Tier 0/1 estimates. If those prove wrong, the second execution uses actual observed cardinalities. No manual intervention, no ANALYZE, no dedicated stats-collection queries.

### Tier 3: Mid-Execution Adaptation

At pipeline breakers — sort, hash join build, hash aggregate — the actual input row count is known before downstream processing begins. When it diverges >10x from the estimate, the downstream plan is likely suboptimal (e.g., a nested loop chosen for an estimated 10-row inner may face 100,000 rows).

Options, in order of complexity:

1. **Record and continue**: Note the misestimate for Tier 2 feedback. Finish current execution with the existing plan. Cheapest to implement; relies on next-execution correction.
2. **Operator swap**: At the checkpoint, substitute a different physical operator (e.g., switch from nested loop to hash join for the remaining subtree). Feasible because the streaming architecture (`AsyncIterable` cursors) means consumers are decoupled from producer implementation.
3. **Partial re-plan**: Pause, re-plan the remaining subtree with actual cardinality from the checkpoint, resume. Most effective but architecturally complex.

---

## 3. Stats Hierarchy

Statistics flow through a three-layer provider chain:

```
RuntimeStatsOverlay  →  CatalogStatsProvider  →  NaiveStatsProvider
  (execution feedback)    (ANALYZE / vtab)        (heuristic defaults)
```

Each layer implements the `StatsProvider` interface (`src/planner/stats/index.ts`). Queries cascade: if the overlay has an observation for a table/predicate, it is used. Otherwise the catalog provider checks `TableSchema.statistics` (populated by ANALYZE or vtab `getStatistics()`). If nothing is available, naive heuristics apply.

### Runtime Stats Overlay

An in-memory, session-scoped cache of per-table and per-predicate observations collected during execution:

| Observation | Source | Granularity |
|---|---|---|
| Table row count | Scan output counter | Per table |
| Predicate selectivity | Filter input/output ratio | Per table + predicate fingerprint |
| Join output cardinality | Join output counter | Per join + condition fingerprint |

The overlay requires no persistence — it rebuilds naturally from query execution within a session. It is bounded (LRU eviction per table) to prevent unbounded memory growth in embedded environments with many unique queries.

The overlay supplements but does not replace catalog stats. When a vtab module provides exact metadata (e.g., `MemoryTable` BTree stats), those stats are preferred. The overlay is most valuable for tables where statistics collection is expensive (DHT-backed storage, federated tables) and the only affordable source of cardinality information is the execution itself.

---

## 4. Query Fingerprint Registry

The fingerprint registry is a Database-level structure that tracks query patterns across `Statement` instances. It enables cross-execution learning — two different `Statement` objects executing the same query shape with different parameter values share execution feedback and tier decisions.

```ts
interface FingerprintEntry {
  fingerprint: string;           // AST structural hash (ignoring literals/parameter values)
  executionCount: number;
  cumulativeTimeMs: number;
  lastEstimatedRows: number;     // from plan's PhysicalProperties.estimatedRows
  lastActualRows: number;        // from runtime cardinality counter
  currentTier: 0 | 1 | 2;
  needsReoptimization: boolean;
  lastOptimizedAt: number;       // execution count at last optimization (cooling)
}
```

The fingerprint is a structural hash of the AST that normalizes away literal values and parameter bindings. The existing `expression-fingerprint.ts` module provides the foundation for structural hashing of plan and AST nodes.

### Tier Selection

```
on compile(query):
  entry = registry.getOrCreate(fingerprint(query.ast))

  if entry has cached plan and not entry.needsReoptimization:
    return cached plan

  if entry.needsReoptimization:
    return reoptimizePhysical(entry.cachedPlan, runtimeOverlay)    // Tier 2

  if vtabStatsAvailable(query.tables):
    return optimizeFull(query)                                      // Tier 1

  if entry.executionCount > PROMOTION_THRESHOLD:
    return optimizeFull(query)                                      // promote to Tier 1

  return optimizeHeuristic(query)                                   // Tier 0
```

The registry is bounded by LRU eviction. Embedded processes may execute many unique ad-hoc queries; unbounded accumulation is not acceptable.

### Cooling

After re-optimization, a cooling period prevents thrashing. The plan is not re-evaluated for at least N additional executions of the same fingerprint, even if new feedback arrives. This ensures plan stability while still converging on good plans over time.

---

## 5. Runtime Cardinality Monitors

Lightweight counters are embedded in the emit layer at existing pipeline breakers — points where the operator already touches every row:

| Operator | Why it's free | What it measures |
|---|---|---|
| Sort | Already materializes all input rows | Input cardinality |
| Hash join (build side) | Already materializes into hash table | Build-side cardinality |
| Hash aggregate | Already hashes every input row | Input cardinality, output group count |
| Filter | One counter increment per passing row | Actual selectivity (output / input) |
| Scan (seq/index) | One counter increment per yielded row | Table cardinality for this access path |

Each counter is a single integer increment per row, piggy-backed on an operation that already processes that row. The overhead is negligible — a benchmark target of <1% throughput impact.

Counters are collected after execution completes, in the `finally` block of `Statement._iterateRowsRawInternal`. If the query's fingerprint entry shows the counters diverge >10x from estimates, the runtime stats overlay is updated and `needsReoptimization` is set on the fingerprint entry.

Counters integrate with the existing `runtime_metrics` option. When metrics are enabled, the counters are always active. When disabled, counter overhead is zero — the instrumented code paths are not compiled into the instruction tree.

---

## 6. Plan Invalidation

Plan invalidation is layered:

### Hard Invalidation (schema changes)

The existing `DependencyTracker` in `EmissionContext` records schema dependencies during plan emission — tables, functions, vtab modules, collations. Schema change events (DDL) trigger `needsCompile = true` on affected `Statement` instances, forcing full re-planning from the AST. This mechanism is unchanged.

### Soft Invalidation (stats feedback)

When the runtime stats overlay is updated for a table, plans depending on that table are soft-invalidated. Soft invalidation sets `needsReoptimization` on the fingerprint entry rather than `needsCompile` on individual statements. The next execution of any statement matching that fingerprint re-runs physical selection with updated stats, skipping structural passes.

Soft invalidation is conservative: it only triggers when runtime counters show >10x divergence from estimates, ensuring that minor cardinality variations (well within the noise of heuristic planning) do not cause unnecessary re-optimization.

---

## 7. Integration with the Pass Framework

The progressive optimizer extends the existing multi-pass framework rather than replacing it.

### Heuristic-Only Mode (Tier 0)

A restricted optimization mode that runs:
- **Pass 0**: Constant folding (always beneficial, no stats dependency)
- **Pass 1**: Structural transformations (predicate pushdown, projection pruning, scalar CSE, subquery decorrelation — all correct regardless of cardinality)
- **Pass 2 (restricted)**: Heuristic physical selection only — no cost comparisons, just safe defaults (index seek on equality, hash join for multi-row, hash aggregate for unsorted input)
- **Pass 4**: Validation

Pass 3 (post-optimization: materialization advisory, CTE caching) is skipped — these decisions benefit from cardinality estimates and are not always-beneficial heuristics.

### Physical Re-optimization Mode (Tier 2)

Starts from the existing optimized plan and re-runs only:
- **Pass 2**: Physical selection with the updated stats context (runtime overlay)
- **Pass 3**: Post-optimization (materialization thresholds may change with new cardinality data)
- **Pass 4**: Validation

Structural passes are skipped because predicate pushdown, projection pruning, and CSE are cardinality-independent.

### vtab Stats Availability

The tier selection logic queries each table's vtab module for stats availability before choosing a tier. Modules that implement `getStatistics()` with low cost (e.g., `MemoryTable` reading BTree metadata) allow Tier 1 on first execution. Modules that would require I/O for statistics (DHT-backed, federated) do not, keeping first execution at Tier 0.

This distinction is important: a query joining a local `MemoryTable` with a DHT-backed table uses Tier 1 stats for the local table and Tier 0 heuristics for the remote table — the best available information for each source without unnecessary I/O.

---

## 8. Key Files

| File | Role |
|---|---|
| `src/planner/framework/pass.ts` | Pass manager, traversal, rule dispatch |
| `src/planner/framework/context.ts` | `OptContext` — carries stats, tuning, visited tracking |
| `src/planner/cost/index.ts` | Cost model functions |
| `src/planner/stats/index.ts` | `StatsProvider` interface |
| `src/planner/stats/catalog-stats.ts` | Catalog stats, histogram support, FK inference |
| `src/planner/analysis/expression-fingerprint.ts` | Structural hashing for CSE (foundation for query fingerprinting) |
| `src/runtime/emission-context.ts` | `EmissionContext`, `DependencyTracker` for plan invalidation |
| `src/runtime/emitters.ts` | Instruction emission dispatch (instrumentation integration point) |
| `src/core/statement.ts` | `Statement` — plan lifecycle, compile, execute, invalidation |
| `src/planner/optimizer.ts` | Optimizer entry point, rule registration |
| `src/planner/optimizer-tuning.ts` | Tuning knobs (depth limits, disabled rules, tour counts) |
