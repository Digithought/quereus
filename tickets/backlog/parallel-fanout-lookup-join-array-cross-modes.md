description: Extend `FanOutLookupJoinNode` (initial v1 lands `atMostOne` only) with `array` and `cross` per-branch modes. `array` packs a branch's row set into a single JSON-array column. `cross` produces the per-branch Cartesian product as today's chain of nested-loop joins would.
prereq: parallel-fanout-lookup-join-node, parallel-fanout-lookup-join-rule
files: packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts
----

## Scope

Two additional modes for `FanOutBranchSpec.mode`:

- **`array`** — a branch becomes a single output column containing a JSON array of the branch's rows. FDs reduce to `outer_keys → branch_array_col` (one value per outer row by construction). Use case: one-to-many lookups that the caller wants to aggregate without an explicit GROUP BY downstream.
- **`cross`** — a branch contributes the full Cartesian product per outer row, matching the existing nested-loop join semantics for a non-`atMostOne` chain. The fan-out node emits one row per (outer, b0_row, b1_row, …) tuple. FDs are the product of per-branch FDs as in today's `JoinNode`.

Both modes share the v1 emitter scaffold (fork + drive + per-branch buffer); the difference is in the per-outer-row composition step:

- `array`: serialize the buffer to JSON, emit a single column.
- `cross`: emit the n-ary Cartesian product across the per-branch buffers (with at-least-one row per buffer to avoid empty-buffer collapse — semantics need a decision here: treat empty branch as INNER-drop, or as a single NULL-padded synthetic row? Mirror the chain of nested-loop joins it would have replaced.)

## Recognition

The v1 rule (`rule-fanout-lookup-join`) clusters FK→PK-aligned at-most-one branches only — that's the safe shape because the runtime can validate the at-most-one invariant. Recognizing `array` and `cross` clusters requires a separate matching pass:

- `array` recognition: typically only useful when a downstream consumer is asking for JSON aggregation explicitly. Without an explicit downstream pattern, the rule has no signal to choose `array` over `cross` over keeping the nested-loop join. Defer until a use case is concrete.
- `cross` recognition: every branch is a parameterized lookup with **no** FK→PK alignment (so cardinality is data-driven). The cost gate's `expectedLatencyMs` win is identical to the at-most-one case, but the Cartesian-product output row count can be unbounded — needs a per-branch row-estimate guard and a maximum-product cap before clustering.

## Out of scope

- Lateral fan-out (`cross apply`-style) where branch cardinality is fully data-driven beyond `atMostOne` *and* cardinality cannot be bounded. The plan ticket already parks this as future work.
- Adaptive ordering of branches by observed latency (issue slowest first).
- Branch-level row-limit propagation (e.g. a downstream `LIMIT 100` informing each `cross` branch to stop early).

## Open questions

- **`array` JSON shape.** Per-row objects keyed by column name, or per-row arrays in column order? Lean toward objects for self-describing output. Confirm with one consumer use case before choosing.
- **`cross` empty-branch semantics.** Inner-join drop, or NULL-pad like LEFT? The chain it replaces would behave like an inner cross join (any empty branch → no output rows for that outer), so default to drop. Document and lock with a test.

## End
