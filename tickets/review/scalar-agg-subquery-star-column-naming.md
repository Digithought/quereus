description: Physical aggregates were advertising appended source columns they never emit, leaking the inner table's first column name (`id`) in place of a second scalar-aggregate subquery's alias under `SELECT *`. Fixed by making physical aggregates advertise exactly the logical AggregateNode's output schema (groupBy + aggregates). Review the schema-consistency invariant and regression coverage.
files: packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/building/select-aggregates.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts
----

## What was wrong

`SELECT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y`
returned `{a:3, id:3}` instead of `{a:3, b:3}`.

`ruleAggregatePhysical` built the physical StreamAggregate/HashAggregate output attribute
list via `combineAttributes(node.getAttributes(), source.getAttributes())`, which appended
**every source column by unique name** to the aggregate's real output (`[a]` → `[a, id, v]`).
But the emitters only ever yield `[...groupByValues, ...aggregateValues]` — source values
are placed solely into the runtime `combinedRowDescriptor` *context* (for HAVING / correlated
reads), never as emitted output. So a physical aggregate declared more output attributes than
it emitted values for.

A Project above the aggregate (the SELECT-list projection) normally trims the output and masks
the desync. A scalar-aggregate subquery used as a join source has **no** such Project, so the
inflated attribute list became the subquery's visible schema, the join concatenated
`[a,id,v,b,id,v]`, and the position/attribute-id ↔ emitted-value desync surfaced `id` (and a
coincidentally-equal value) in place of `b`.

## The fix (landed)

**Invariant established:** a physical aggregate advertises exactly the logical
`AggregateNode`'s output schema — groupBy columns + aggregate columns, nothing else. This
matches what the emitter yields and what the rest of the plan (star expansion, joins, prepared
statement column names) was built against.

- `rule-aggregate-streaming.ts`: replaced `combineAttributes(node.getAttributes(),
  source.getAttributes())` with `node.getAttributes().slice()`; deleted the now-unused
  `combineAttributes` helper and the `Attribute` import.
- `select-aggregates.ts` (`createAggregateOutputScope`): removed the dead "source columns for
  HAVING access" loop. It iterated `aggregateAttributes` *beyond* groupBy+aggregates; against
  the logical node it was always a no-op, and after the fix it is uniformly a no-op. Source
  columns for HAVING/correlated access resolve through the runtime row-descriptor context and
  the source-column fallback in `buildHavingFilter`'s hybrid scope (both untouched).
- Defensive consistency: `stream-aggregate.ts` and `hash-aggregate.ts` no-`preserveAttributeIds`
  `buildAttributes()`/`getType()` paths no longer append source columns — they now advertise
  only groupBy+aggregate columns, mirroring `AggregateNode.buildOutputType`/`buildAttributes`.
  Every current construction site passes `preserveAttributeIds`, so this path is currently
  dead, but it was the same latent bug. Emitters' `combinedRowDescriptor` context logic is
  unchanged.

## Why HAVING / correlated subqueries still work

Valid HAVING references resolve to aggregate-output attribute-ids (groupBy + aggregate columns,
which remain in the output) and/or read source columns through the runtime
`combinedRowDescriptor` context — neither depends on the appended output attributes.
`buildHavingFilter` independently registers a source-column fallback in its hybrid scope and
rejects any non-grouped/non-aggregate reference, so it never relied on the aggregate advertising
source columns.

## Validation done

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — **3631 passing, 9 pending** (3629 baseline + 2
  new regression tests). No store run (`test:store`) was done — not relevant to this planner/
  schema change.

## Regression coverage added (`keys-propagation.spec.ts`, "Empty-key (≤1-row) join coverage")

- `scalar-aggregate subquery cross join exposes both aggregate columns by name (SELECT *)`
  → asserts `SELECT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y`
  yields exactly `[{ a: 3, b: 3 }]`.
- `scalar-aggregate subquery cross join over different tables exposes both aliases`
  → asserts `SELECT x.a, y.b FROM (...t...) x CROSS JOIN (...t2...) y` yields `[{ a: 3, b: 2 }]`
  (different tables; proves it is not `*`-expansion-only).
- Tightened the pre-existing `DISTINCT-eliminated ≤1-row join returns the same rows…` test:
  it previously compared DISTINCT-vs-plain *specifically to side-step* this defect; it now also
  asserts the exact `{ a: 3, b: 3 }` shape.

## Review focus / known gaps

- **Schema-vs-emit invariant:** confirm no other physical relational node advertises attributes
  its emitter doesn't produce. The fix only touched the two aggregate nodes; the same class of
  bug could exist elsewhere (any node that appends "context-only" attributes). Worth a quick
  scan of nodes that build attribute lists from `combineAttributes`-style helpers or append
  `source.getAttributes()`.
- **Dead defensive path:** the no-`preserveAttributeIds` branches in both aggregate nodes are
  currently unreachable (all callers pass `preserveAttributeIds`). They were corrected for
  safety, not because anything exercises them — so they have **no test coverage**. If the
  reviewer wants them covered, a direct unit test constructing a `StreamAggregateNode`/
  `HashAggregateNode` without `preserveAttributeIds` and asserting `getAttributes().length ===
  groupBy.length + aggregates.length` would lock the invariant. Consider whether the dead branch
  should instead be deleted (and the param made required) rather than maintained.
- **HAVING / correlated regressions:** existing suite covers GROUP BY + HAVING and
  `HAVING <group-by-col>`/`HAVING <agg>` paths and all pass, but no *new* test was added that
  specifically exercises a HAVING clause referencing a source (non-grouped, non-aggregate)
  column to prove the context path still feeds it after removing the dead scope loop. The
  existing logic tests cover this indirectly; a targeted assertion would be a stronger floor.
