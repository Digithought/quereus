description: The fan-out lookup-join rule wraps each scalar-aggregate subquery branch root in a single-column ProjectNode to pin its attribute count. That wrap was originally needed because the physical StreamAggregate over-advertised source columns (attribute count grew 1→N). That defect is fixed (scalar-agg-subquery-star-column-naming) — aggregates now advertise exactly their logical schema, so the subquery root is already single-column and the Project is a (likely) redundant identity projection. Evaluate removing it.
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, docs/optimizer.md
----

## Context

`ruleFanOutLookupJoin` (`rule-fanout-lookup-join.ts`, ~lines 276-298) wraps every
recognized scalar-aggregate subquery branch's `subqueryRoot` in a
`ProjectNode` selecting `valueAttr` (the column-0 scalar value), so the branch
contributes exactly one column to the fan-out wide row.

The historical justification (documented in the now-corrected comments and in
`docs/optimizer.md`) was that a no-`GROUP BY` aggregate's **physical**
`StreamAggregate`/`HashAggregate` exposed the inner source columns in addition
to the aggregate value — so the root's attribute count grew from 1 (logical) to
N (physical) after `ruleAggregatePhysical` ran, and an unwrapped branch would
misalign the wide row.

The `scalar-agg-subquery-star-column-naming` fix removed that inflation:
physical aggregates now advertise **exactly** the logical `AggregateNode`
schema (GROUP BY + aggregate columns). A no-`GROUP BY` scalar aggregate is
therefore already single-column in both logical and physical form, and
`valueAttr` is its column-0 attribute. The Project now wraps a 1-column input
to produce a 1-column output with the same attribute id/alias — an identity
projection.

## What to evaluate / specify

- Whether the Project wrap can be dropped entirely (drive the branch off
  `subqueryRoot` verbatim, as spine branches do for their lookup), relying on
  the aggregate already being single-column with `valueAttr` as its column-0
  attribute.
- Interactions to verify before removing:
  - `substituteSubqueries` rewrite (the outer projection's `ScalarSubqueryNode`
    → `ColumnReferenceNode` into the wide row) — it must still target the right
    attribute id.
  - The wide-row index math (`wideIndex += b.lookup.getAttributes().length` and
    the branch `outputAttrs`/`preserveAttributeIds` layout).
  - Nullable-widening for left-preserving branches.
  - Golden-plan tests (`test/plan/`) — removing a ProjectNode changes plan
    shape; expect golden updates.
  - Whether a later projection-pruning pass already elides this identity Project
    at runtime (in which case the only payoff is logical-tree simplification).

This is an optimization / simplification, not a correctness bug — the current
wrap is harmless. Low priority.
