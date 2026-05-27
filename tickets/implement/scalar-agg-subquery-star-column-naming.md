description: Physical aggregate selection advertises extra source columns on the aggregate's output attribute list, but the aggregate emitter never emits those columns (they live only in runtime context). When a scalar-aggregate subquery is a join source with no Project to trim it, the bogus extra attributes leak into `SELECT *` / column resolution, relabeling the second subquery's aggregate column as the inner table's first column (`id`). Fix: physical aggregates must advertise exactly the logical AggregateNode's output schema.
files: packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/building/select-aggregates.ts, packages/quereus/src/runtime/emit/aggregate.ts, packages/quereus/src/runtime/emit/hash-aggregate.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts
----

## Root cause (confirmed)

`SELECT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y`
returns `{a:3, id:3}` instead of `{a:3, b:3}`.

The **logical** `AggregateNode` correctly exposes only its aggregate/group-by columns
(`buildAttributes`/`buildOutputType` in `aggregate-node.ts` — just `[a]` for the scalar
case). During optimization, `ruleAggregatePhysical`
(`rule-aggregate-streaming.ts:46`) builds the physical node's attribute list via:

```ts
const finalAttrs = combineAttributes(node.getAttributes(), source.getAttributes());
```

`combineAttributes` **appends every source column** (by unique name) to the aggregate's
output attributes and passes the result as `preserveAttributeIds`. So the physical
`StreamAggregate`/`HashAggregate` advertises `[a, id, v]` (3 attributes) for
`SELECT count(*) AS a FROM t`, even though:

- the logical node, and everything built on top of it (the `SELECT *` star expansion,
  the join, the prepared statement's column names) was built against the **1-column**
  logical schema `[a]`; and
- the emitter (`runtime/emit/aggregate.ts`, lines 309/432/543 and `hash-aggregate.ts`)
  **only yields `[...groupByValues, ...aggregateValues]`** — it never emits the appended
  source columns. The source values are placed *only* into the runtime
  `combinedRowDescriptor` **context** (so HAVING / correlated subqueries can read source
  attributes by their source attribute-id), and that context is built from
  `plan.getAttributes()` + source attributes independently of whether the appended
  attributes exist on the output.

So the physical aggregate declares more output attributes than it emits row values for.
Normally a Project above the aggregate (the SELECT-list projection) trims the output back
to the real columns, masking the discrepancy. But a **scalar-aggregate subquery used as a
join source** has no such Project: the aggregate's (inflated) attribute list becomes the
subquery's visible schema, the join concatenates `[a,id,v,b,id,v]`, and the
position/attribute-id ↔ emitted-value desync surfaces the inner table's `id` column name
(and a wrong-but-coincidentally-equal value) in place of `b`.

Confirmed pre-existing and unrelated to the empty-key-join-coverage work (matches the
ticket's note).

## The fix (verified)

In `rule-aggregate-streaming.ts`, advertise exactly the logical aggregate's schema:

```ts
const finalAttrs = node.getAttributes().slice();
```

i.e. drop the `combineAttributes(...)` call (and remove the now-unused `combineAttributes`
helper + its now-unused `Attribute` import). This makes the physical node's declared
output schema identical to the logical `AggregateNode`'s, which matches both what the
emitter actually yields and what the rest of the plan was built against.

Verified locally: the one-line change makes

- `SELECT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y`
  → `{a:3, b:3}`
- `SELECT x.a, y.b FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t2) y`
  → `{a:3, b:2}`

and **all 3629 quereus tests still pass** (incl. GROUP BY + HAVING and the
`HAVING <group-by-col>`/`HAVING <agg>` paths). HAVING still works because valid HAVING
references resolve to aggregate-output attribute-ids (group-by + aggregate columns, which
remain in the output) and/or read source columns through the runtime `combinedRowDescriptor`
context — neither depends on the appended output attributes.

## Why the appended source columns are vestigial

- The emitter never emits them (only context-exposes source values).
- `createAggregateOutputScope` (`select-aggregates.ts:318-331`) has a loop that registers
  "source columns for HAVING access" by iterating `aggregateAttributes` **beyond**
  groupBy+aggregates. Against the *logical* AggregateNode (which never had them) this loop
  was already a no-op; against the inflated physical list it registered the leaked columns.
  After the fix it is uniformly a no-op and can be removed for clarity.
- `buildHavingFilter` independently registers a *source-column fallback* in its hybrid
  scope and rejects any non-grouped/non-aggregate reference, so it does not rely on the
  aggregate advertising source columns.

## Defensive consistency cleanup (recommended, re-run tests)

`stream-aggregate.ts` (`getType` lines ~124-133, `buildAttributes` n/a there) and
`hash-aggregate.ts` (`buildAttributes` lines ~58-76, plus its `getType`) still append
source columns to the aggregate output **when constructed without `preserveAttributeIds`**.
Every current construction site passes `preserveAttributeIds`
(`rule-aggregate-streaming.ts`, `rule-aggregate-predicate-pushdown.ts`, and the nodes'
`withChildren`), so this path is currently dead — but it is the same latent bug. Make the
no-`preserveAttributeIds` path advertise only `groupBy + aggregates` (mirroring
`AggregateNode.buildOutputType`/`buildAttributes`) so a physical aggregate can never again
advertise a column it doesn't emit. Keep the runtime `combinedRowDescriptor` context logic
in both emitters unchanged (it correctly exposes source values for HAVING/correlated reads).

## TODO

- Replace `combineAttributes(node.getAttributes(), source.getAttributes())` with
  `node.getAttributes().slice()` in `rule-aggregate-streaming.ts`; delete the unused
  `combineAttributes` helper and the now-unused `Attribute` import.
- Remove (or convert to a no-op) the "source columns for HAVING access" loop in
  `createAggregateOutputScope` (`select-aggregates.ts:318-331`) since it is now dead.
- Defensive: update `stream-aggregate.ts` and `hash-aggregate.ts` so the
  no-`preserveAttributeIds` `getType`/`buildAttributes` paths advertise only
  groupBy+aggregate columns (no appended source columns). Leave emitters' context logic intact.
- Add a behavioral regression in `keys-propagation.spec.ts` asserting exact column names
  **and** values for an aggregate-subquery cross join, e.g.:
  - `SELECT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y`
    → single row `{a:3, b:3}`.
  - `SELECT x.a, y.b FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t2) y`
    → single row `{a:3, b:2}` (different tables; proves it is not `*`-expansion-only).
  Consider also tightening the existing
  "DISTINCT-eliminated ≤1-row join returns the same rows…" test (which currently
  side-steps this defect by comparing DISTINCT-vs-plain) to also assert the `{a,b}` shape.
- Run `yarn workspace @quereus/quereus run test` (and `yarn lint`) and confirm green.
