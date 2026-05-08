---
description: Recognize WHERE x BETWEEN a AND b (and equivalents) over a MonotonicOn input as a range-scan access pattern, threading the bounds into BestAccessPlanRequest.filters
prereq: monotonic-on-characteristic, bestaccessplan-monotonic-ordering
files: packages/quereus/src/planner/rules/access/, packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/vtab/best-access-plan.ts

---

## Architecture

The optimizer already extracts bound constraints (`x >= a`, `x < b`, equivalently `x BETWEEN a AND b`) from `WHERE` clauses and surfaces them through `BestAccessPlanRequest.filters` so vtabs can choose to handle them. Most modern vtab implementations (memory-table, indexed adapters) honor the bounds when they have an index on the column.

What's missing is an explicit handshake for the case where the column is `MonotonicOn` and the bounds form a *contiguous range*: the rule guarantees the access path can serve the predicate as a single seek-and-scan in `O(log N + |result|)` rather than scanning the full domain and filtering. This ticket formalizes the recognition and the rewrite in one place so:

1. The cost model can reliably price the range-scan path against alternatives.
2. Downstream rules (`OrdinalSlice`, `MonotonicMerge`, asof-scan) can compose with the result and reason about the bounds.
3. Modules that advertise `MonotonicOn` are guaranteed to receive bound constraints in a recognizable shape, simplifying their `getBestAccessPlan` implementation.

The rule does not introduce a new plan node — it operates on the existing retrieve / scan structure by ensuring the range is fully threaded through `BestAccessPlanRequest.filters` and marked as `handledFilters[i] = true` in the result. What it adds is the optimizer-side logic that *insists* on this when the input is `MonotonicOn`.

### Recognition patterns

The rule fires on these standard SQL forms when the predicate column is the input's `MonotonicOn` attribute:

| SQL pattern | Bound translation |
| --- | --- |
| `x BETWEEN a AND b` | `x >= a` and `x <= b` |
| `x >= a AND x <= b` | as written |
| `x >= a AND x < b` | as written |
| `x > a AND x <= b` | as written |
| `x > a AND x < b` | as written |
| `x = c` | `x >= c` and `x <= c` (degenerate range) |
| `x IN (c1, c2, …)` over `MonotonicOn` strict | union of point ranges; lowered as a disjunction the access plan may choose to handle, or fall back to multiple seeks |

Half-bounds (`x >= a` alone, `x < b` alone) are already first-class in the constraint extractor; the rule respects them.

### What the rule actually does

In Quereus's current optimizer, `getBestAccessPlan` is consulted for each retrieve node. The rule's job is two-fold:

1. **Pre-call:** Ensure that recognized range predicates over the `MonotonicOn` attribute appear as constraints in the `BestAccessPlanRequest.filters` array, in canonical form. This may already happen via constraint extraction; the rule audits and supplements if not.

2. **Post-call:** If the vtab returns `handledFilters[i] = false` for a bound constraint over a `MonotonicOn` column, the optimizer escalates: either the vtab is mis-advertising (the column is `MonotonicOn` but the access plan can't serve a range; investigate or treat as a soft warning) or the rule should drop the `MonotonicOn` advertisement on the resulting retrieve node (because the path the vtab picked discards the property).

   In well-behaved modules, a `MonotonicOn` advertisement implies range support; the rule's escalation is mostly defensive.

### Output shape

The output retrieve node has:

- `physical.ordering`: monotonic on `x` (preserved from input).
- `physical.monotonicOn`: preserved (the range is a subset of the original totally ordered set; subset of monotonic is monotonic).
- `physical.estimatedRows`: bounded by the range's selectivity if known (the cost model can use range statistics if available; out of scope here, but the framework supports it).

### Composition with other rules

The point of this ticket is composition. Specifically:

- `OrdinalSlice` (separate ticket) on top of a range-bounded retrieve still works — the slice operates on the range's emit order, which remains monotonic.
- `MonotonicMerge` (separate ticket) on two range-bounded retrieves works if both ranges agree on bounds (and the rule may even propagate the intersection — out of scope but feasible later).
- `AsofScan` (separate ticket) on a range-bounded right input is fine; the right cursor is restricted to the range and otherwise behaves identically.

### What this ticket explicitly is not

- **Not a new plan node.** The output is still a retrieve node; only the `BestAccessPlanRequest`/`Result` interaction is touched.
- **Not a generic predicate-pushdown overhaul.** `WHERE` pushdown already works for many shapes; this ticket targets the specific case of bound predicates over `MonotonicOn`.
- **Not a multi-column range generalization.** Compound ranges (`(x, y) BETWEEN (a1, a2) AND (b1, b2)`) are not in scope; lexicographic compound monotonic is a separate concern.

### Diagnostics

When the rule fires, `query_plan()` should annotate the retrieve node with a `rangeBoundedOn` property naming the attribute and the symbolic bounds (e.g., `[a, b]`, `(a, b)`, `[a, ∞)`). This makes EXPLAIN plans self-evident for the common case of "I asked for `x BETWEEN a AND b`; did the rule fire?"

## TODO

### Phase 1: Recognition
- Audit `constraint-extractor.ts` to confirm bound shapes are extracted into `BestAccessPlanRequest.filters` in canonical form for the listed predicates.
- Add any missing shapes (most likely already there).

### Phase 2: Optimizer rule
- Implement `rule-monotonic-range-access` in `planner/rules/access/`. The rule:
  - Confirms input has `MonotonicOn(x)`.
  - Confirms a recognized bound predicate exists on `x`.
  - Ensures the predicate is in `filters` and recognized post-call as `handledFilters[i] = true`.
  - Annotates the retrieve node with the symbolic range for diagnostics.

### Phase 3: Tests
- Plan-shape tests: each recognized shape produces the expected access-plan request and the expected `physical.monotonicOn` on the retrieve.
- SQL logic tests confirming correct results, including edge cases (empty range, single-element range, half-bounds, `IN` lists).
- Diagnostic test: `query_plan()` surfaces the `rangeBoundedOn` property when the rule fires.
