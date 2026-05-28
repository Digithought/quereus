description: Removed the redundant single-column `ProjectNode` wrap on subquery branches in `ruleFanOutLookupJoin`. Aggregate nodes advertise exactly their logical groupBy+aggregate schema in both logical and physical form (since the `scalar-agg-subquery-star-column-naming` fix), so a no-GROUP-BY scalar-aggregate subquery root is already single-column. The Project wrap was an identity projection adding nothing. Branch now drives off `subqueryRoot` verbatim, mirroring how the file header always described it.
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, docs/optimizer.md
----

## What changed

`packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts`

- The `for (const b of subqueryBranches)` assembly loop (was ~lines 275-300) no
  longer constructs a `ProjectNode` + intermediate `ColumnReferenceNode`. The
  branch spec is now built directly from `b.subqueryRoot`:
  ```typescript
  branchSpecs.push({
      child: b.subqueryRoot,
      mode: b.mode,
      outputAttrs: b.subqueryRoot.getAttributes(),
      concurrencySafe: b.concurrencySafe,
  });
  ```
- Doc-comment on `RecognizedSubqueryBranch` updated to drop the "defensive
  identity pin" framing and state the new reality: branch child is
  `subqueryRoot` verbatim, `valueAttr` is its column-0 attribute.
- No other changes — `substituteSubqueries`, the wide-row index math, the
  `preserveAttributeIds` nullable-widening logic, and the cost gate were all
  invariant under the change (the subquery branch's wide-row contribution is
  still exactly one column, and the attribute IDs are unchanged because they
  were already the same `Attribute` objects forwarded through the Project's
  `attributeId: valueAttr.id` argument).

`docs/optimizer.md`

- The "Aggregate nodes advertise exactly their logical schema… The assembly
  nonetheless wraps the subquery root in a stable single-column `ProjectNode`…
  This is now a defensive identity pin…" paragraph was rewritten to drop the
  defensive-pin language and the back-pointer to this ticket. The new prose
  states that the branch `child` is the subquery root verbatim.

## Why this is safe

Three reasons the wrap was redundant after `scalar-agg-subquery-star-column-naming`:

1. **Single-column guarantee at recognition.** `recognizeSubqueryBranch`
   gates on `scalarSubquery.subquery.getAttributes().length !== 1`, so every
   recognized subquery root advertises exactly one attribute, and that
   attribute IS `valueAttr` (it is `subAttrs[0]`).
2. **Physical aggregates preserve the logical schema.** `ruleAggregatePhysical`
   passes `node.getAttributes().slice()` as `preserveAttributeIds` to
   `StreamAggregateNode` / `HashAggregateNode`. Both physical nodes' `buildAttributes`
   return that slice when `preserveAttributeIds` is set (no source-column
   appending). So when the Physical pass later replaces a logical
   `AggregateNode` under the fan-out branch, the new physical node has the
   same single attribute with the same ID — the FanOutLookupJoin's
   `withChildren` validator (`outputAttrs.length === child.getAttributes().length`)
   stays green.
3. **The runtime emit yields one column.** `emitStreamAggregate`'s no-GROUP-BY
   path (line 309 of `runtime/emit/aggregate.ts`) yields `aggregateRow`
   (length = `plan.aggregates.length` = 1 for a scalar aggregate),
   *not* the `fullRow` that includes source columns. Wide-row composition
   in `composeOuterRows` pushes exactly the yielded slice, so the wide-row
   contribution is 1 column whether or not the Project wraps the aggregate.

The Project's `attributeId: b.valueAttr.id` argument meant its output
attribute was the same `Attribute` object as the aggregate's output, so even
the "identity pin" framing was loose — there was no second `Attribute` object
to pin to. The Project genuinely was an identity projection.

## What the reviewer should verify

- **Plan shape change for high-latency vtab cases.** The fanout-lookup-join
  rule is cost-gated on `expectedLatencyMs > 0`, so memory-vtab golden plans
  are unaffected (and indeed, the golden-plan sweep was unchanged by this
  edit). But any fixture or synthetic vtab that *does* declare per-call
  latency and triggers fan-out subquery clustering will see one fewer
  `Project` node in its plan — the branch child is now the
  `StreamAggregateNode` / `HashAggregateNode` directly. Spot-check that no
  test currently asserts plan shape against a vtab with declared latency
  involving a scalar subquery. None turned up in my search, and the full
  `yarn test` (3642 passing, 9 pending) is unchanged from baseline.
- **No projection-pruning interaction was relied upon.** Removing the
  Project means there is no longer an "identity Project on a 1-col input"
  for any pruning rule to elide. That's a payoff (not a concern) — the
  logical tree is smaller by one node per recognized subquery branch — but
  worth a glance at `rule-projection-pruning.ts` to confirm it neither
  matches this pattern nor relies on it being present (it doesn't; it only
  fires on `Project(Project(…))` patterns).
- **Re-read the rule-file's top-level comment.** It already described the
  subquery's relational root as "used verbatim as the branch child" (line
  ~26). That description was inaccurate while the Project wrap existed; it
  is now accurate. Reviewer should confirm the description still matches
  what the code does end-to-end.

## Validation

- `yarn workspace @quereus/quereus run lint` — clean on the edited file
  (no output, exit 0).
- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0).
- `yarn workspace @quereus/quereus run test` — 3642 passing, 9 pending,
  0 failing. Same numbers as baseline before the edit.

## Known gaps / soft spots

- I did **not** rerun `yarn test:store` (LevelDB-backed). The rule is
  cost-gated on `expectedLatencyMs > 0`, which is leaf-driven, not store-
  driven, and the LevelDB store does not declare per-call latency, so I
  expect zero behavioral change there — but the reviewer may want to
  confirm with a `yarn test:store` if they want belt-and-suspenders.
- No new tests were added. The existing `parallel-fanout.spec.ts` suite
  (which uses a high-latency synthetic vtab to drive the cost gate) covers
  the formation path including subquery branches with wrapped and bare
  shapes, and it stayed green. The change is a pure simplification of an
  already-tested code path; the floor is the existing tests, not a new
  guard.
