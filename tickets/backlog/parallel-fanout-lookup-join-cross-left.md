description: Add a `cross-left` FanOutLookupJoin branch mode so a LEFT 1:n (not-at-most-one) chain can fold into the fan-out instead of bailing to a nested-loop left join.
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, docs/optimizer.md, docs/runtime.md
----

## Problem

`ruleFanOutLookupJoin` recognizes three branch shapes today: `atMostOne-left`,
`atMostOne-inner`, and (as of `parallel-fanout-lookup-join-cross-rule`) `cross`
— a data-driven 1:n equi-lookup on an INNER/CROSS join.

A **LEFT** join whose non-preserved side is a parameterized equi-lookup that is
*not* provably at-most-one (no FK, or FK→non-unique) is currently **out of
scope**: `recognizeBranch` returns `null` for `joinType === 'left'` on the cross
path, which bails the entire cluster back to a nested-loop left join. See the
`return null` after the cross block in `recognizeBranch`
(`rule-fanout-lookup-join.ts`) and the doc note under "Fan-out lookup join
(FK→PK + 1:n cross)" in `docs/optimizer.md`.

## Why it's hard / what's needed

A LEFT 1:n branch has two semantics the existing `cross` mode does not provide:

1. **Null-preservation when empty.** If the lookup yields zero rows for an outer
   row, the outer row must still appear once with the branch columns NULL-filled
   (LEFT semantics). The `cross` emit path instead *drops* the outer row on an
   empty branch (inner-drop) — see `runtime/emit/fanout-lookup-join.ts`
   (`isAtMostOne` / the empty-buffer handling).
2. **Nullable-widening of the branch output attributes.** The rule's
   `preserveAttrs` only widens `atMostOne-left` outputs to nullable; a new
   `cross-left` mode must be added to that widening predicate (and the matching
   `buildAttributes`/`getType` widening in `FanOutLookupJoinNode`), so the wide
   row's branch columns are typed nullable.

This implies a new `FanOutBranchMode` value (`'cross-left'`) threaded through:
- `recognizeBranch` (emit it for `joinType === 'left'` + not-aligned + AND-of-equalities),
- the cross memory guard (`crossGuardsPass` — a `cross-left` branch still
  contributes a 1:n factor to the product and must be gated the same way),
- `FanOutLookupJoinNode` attribute/type widening + `computeEstimatedRows`,
- the emit cross-product assembly (empty branch ⇒ one NULL-padded factor row,
  like `atMostOne-left`, instead of inner-drop).

## Acceptance

- A `select … from p left join c on p.id = c.pid` chain (c has no FK / non-unique
  match) with ≥`minBranches` and remote-ish latency folds into a single
  `FanOutLookupJoin` with a `cross-left` branch.
- Outer rows with no matching child appear once with NULL branch columns
  (multiset equality vs the nested-loop left-join baseline, including the
  empty-match rows).
- Mixed chains (`atMostOne-left` + `cross` + `cross-left`) fold correctly.
- Memory guards (`maxCrossBranchRows` / `maxCrossProduct`) apply to `cross-left`
  branches identically to `cross`.
