description: Guarded query execution — worst-case regret optimization with runtime plan swapping
dependencies: optimizer framework, statistics infrastructure, runtime execution, key-based cursor positioning
files: src/planner/cost/index.ts, src/planner/stats/, src/planner/framework/pass.ts, src/planner/framework/context.ts, src/planner/framework/registry.ts, src/runtime/scheduler.ts, src/runtime/types.ts, docs/optimizer.md
----

## Philosophy

Traditional query optimization tries to pick the best plan.  This feature reframes the problem: **optimize for worst-case regret, not expected cost.**  Every optimizer decision goes through the filter: "what is the pathological case if I'm wrong?"  If the worst case is considerably worse than average, the optimizer injects a guard with a pre-built alternative plan that uses resume semantics.

This is analogous to JIT compilation.  A JIT doesn't predict which branches are hot — it starts with an interpreter, observes actual behavior, then compiles hot paths.  The key property: **you never pay a catastrophic cost for a wrong prediction.**  Applied to query execution:

- **Tier 0 (conservative)**: Start with the safest plan — lowest worst-case.  Nested-loop with index seeks, small-to-large ordering.  Slow but bounded.
- **Tier 1 (observed)**: After N rows flow through a guard, we know actual cardinalities.  Swap in a better subroutine — hash join, different strategy — without restarting the query.  The guard is a dispatch point.
- **Tier 2 (known)**: For repeated queries or when modules provide real statistics, plan aggressively from the start.  No guard overhead.

Like a JIT, this is **per-node, not per-query**.  One join may still run its conservative Tier 0 while another has already swapped to hash join.  Each guard independently decides when to escalate.

## Key-Based Resumability

Quereus' key-based addressing makes mid-execution plan swapping viable where most databases can't do it:

1. Every virtual table has a deterministic key order — every cursor position is expressible as a key value.
2. Range scans (`key > K`) are a fundamental vtab operation all modules support.

Resume is "the same query with a tighter range."  You're not switching runtimes mid-stream — you're **ending one subroutine and starting a better one that picks up where you left off.**

### Resume at each operator level

**Base table scan**: Ordered by key, last processed key = K.  Resume: `WHERE key > K AND <original predicates>`.

**Nested-loop join (T1 outer, T2 inner)**: Outer cursor at key K1.  Simplest: discard the partial outer row, resume with `T1.key > K1` and full inner scan.  Cost of re-scanning one inner iteration is negligible vs. savings from a better plan.

**Hash join swap-in**: When a guard decides to switch from nested-loop to hash join, the build side is constructed as part of the swap — we build the hash table from the full build-side table, then probe with the resumed outer scan.  The build cost is paid once at swap time.

**Aggregates**: Guards sit below aggregates, so resume predicates apply to the base scans feeding the aggregate.  For decomposable aggregates (SUM, COUNT, MIN, MAX), partial state from before the swap is carried forward and combined with the new execution's result.

## Guard Mechanics

### Placement

The optimizer injects a guard at every decision point where the pathological case is significantly worse than average — specifically where a wrong cardinality estimate could cause catastrophic execution time.  Each guard has:

- The **conservative subroutine** (Tier 0) — runs first
- A **cardinality threshold** — the point at which the conservative plan becomes pathological
- A **pre-built alternative subroutine** (Tier 1) — the plan to swap to, with resume rewrite semantics already applied
- **Cursor position tracking** — last key seen at each base table scan within the guard's subtree

Guards are independent: each only affects its local subtree.  Guard A firing does not invalidate guard B's pre-computed alternative.

### Runtime swap

When a guard's threshold fires:

1. The conservative subroutine stops
2. Cursor positions (last keys) are captured from the base table scans
3. The alternative subroutine is instantiated with resume predicates injected at its base scans
4. If swapping to a hash join, the build-side hash table is constructed at this point
5. **The guard node itself is replaced** with the new subroutine — subsequent rows flow through the new path directly, with zero per-row dispatch overhead (no ongoing condition check)

This is literal node replacement, like a JIT patching a call site.  After the swap, the guard is gone.

### Guard generation at plan time

For each guarded decision, the optimizer produces a paired plan:

```
GuardNode {
  conservative: NestedLoopJoin { outer: ScanA(ordered by key), inner: IndexSeekB }
  threshold: estimatedRows(A) * 5   // fire if 5x more rows than expected
  alternative: HashJoin { build: ScanB, probe: ScanA(WHERE key > $resume_key) }
}
```

The alternative plan is fully built at plan time (or at least its template is).  At runtime, the swap just instantiates it with the captured resume key.

## What This Simplifies

Making wrong decisions recoverable reduces the optimizer's burden to be right:

**Join ordering**: Today QuickPick runs multiple random TSP tours because a bad order is catastrophic.  With guards, a bad initial order self-corrects after a bounded number of rows.  Fewer tours needed, or a simple heuristic order suffices.

**Cost model**: The cost constants (`COST_CONSTANTS` in `cost/index.ts`) are uncalibrated magic numbers.  With guards, costs only need to be directionally correct enough to pick a reasonable Tier 0 plan.  Could simplify to categorical comparisons (index < scan, small build < large build) rather than precise numeric costs.

**Cardinality estimation**: `NaiveStatsProvider` guesses 1000 rows / 30% selectivity for everything.  Today, being wrong by 1000x means an irreparably bad plan.  With guards, being wrong by 1000x means a bounded amount of wasted work before correction.  The pretense of precise estimation for unknown tables becomes unnecessary.

**Physical operator selection**: Instead of choosing hash vs. merge vs. nested-loop up front, always start with the safest option (nested-loop with index seeks).  The guard monitors and escalates to hash join when justified.  The operator "choice" becomes an escalation path, not a static decision.

## Concrete Example

```
Query:  SELECT * FROM remote_orders o JOIN local_products p ON o.product_id = p.id

-- remote_orders has no stats (federated table, NaiveStatsProvider guesses 1000 rows)
-- local_products is small and local

Tier 0 plan (conservative):
  GuardNode (threshold: 5000 rows from remote_orders)
  ├── conservative: NestedLoop
  │     ├── Scan remote_orders (outer, ordered by key)
  │     └── IndexSeek local_products (inner, per outer row)
  └── alternative: HashJoin (resume)
        ├── Build: Scan local_products → hash table
        └── Probe: Scan remote_orders WHERE key > $resume_key

Execution:
  1. NestedLoop starts, scanning remote_orders row by row
  2. After 5000 rows, guard fires — remote_orders is clearly large
  3. Guard captures: last remote_orders key = K
  4. Builds hash table from local_products (small, fast)
  5. Replaces guard node with: HashJoin probing remote_orders WHERE key > K
  6. Remaining rows flow through hash join — no per-row guard check
  7. Final result = concat(first 5000 NL rows, remaining HJ rows)
```

## Ticket Decomposition

This should be broken into a series of implementation tickets:

### Phase 1: Guard infrastructure
- `GuardNode` plan node type with conservative/alternative subroutine slots
- Cursor position tracking at base table scans (last-key-seen bookkeeping)
- Runtime guard firing mechanism: threshold check, cursor position capture, node replacement
- Resume predicate injection: rewriting base table scans with `key > $resume_key`

### Phase 2: Guard generation in the optimizer
- "Regret analysis" at each physical operator decision: compute worst-case cost ratio between conservative and aggressive plans
- Generate paired plans (conservative + alternative with resume template) when regret exceeds threshold
- Integration with existing physical selection pass (`ruleJoinPhysicalSelection`)

### Phase 3: Operator escalation paths
- Nested-loop → hash join swap (the primary case)
- Nested-loop → merge join swap (when both sides are ordered)
- Scan strategy swaps (full scan → index scan when selectivity is discovered to be high)

### Phase 4: Feedback integration
- `FeedbackStatsProvider` that wraps inner provider, caches observed cardinalities keyed by (table, predicate signature)
- Tier 2 path: skip guards entirely when confident stats are available
- Module feedback: feed observed cardinalities back to vtab modules that want them

### Phase 5: Optimizer simplification
- Reduce QuickPick tour count / simplify join ordering heuristics
- Simplify cost model to categorical comparisons where guards cover the risk
- Remove or relax cardinality estimation precision for unknown tables

### Testing strategy

- Synthetic vtab module that returns controllable row counts with configurable (wrong) stats — verify guard fires and plan swaps correctly
- Correctness: result set must be identical regardless of whether guard fires or not (with and without resume)
- Verify zero per-row overhead after guard swap (node replacement, not conditional dispatch)
- Regression: ensure guarded plans on well-estimated tables don't fire guards (no unnecessary swaps)
- Stress: very large cardinality misestimates (1000x) to verify bounded waste before correction

### References

- `src/planner/cost/index.ts` — cost model and constants
- `src/planner/stats/` — StatsProvider interface, NaiveStatsProvider, BasicRowEstimator
- `src/planner/framework/pass.ts` — optimizer pass framework
- `src/planner/framework/context.ts` — OptContext with diagnostics
- `src/planner/framework/registry.ts` — rule registry
- `src/planner/rules/join/` — join physical selection rules
- `src/runtime/scheduler.ts` — instruction execution, runtime stats collection
- `src/runtime/types.ts` — Instruction type, InstructionRuntimeStats
- `docs/optimizer.md` — optimizer architecture, QuickPick, future directions
