description: Review GROUP BY projection-alias fix — final projection now forced on alias renames; ORDER BY can resolve aliases in aggregate path
prereq:
files:
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/src/planner/building/select.ts
  packages/quereus/test/logic/07.3-group-by-extras.sqllogic
  packages/quereus/test/logic/25.1-nested-aggregates.sqllogic
  packages/quereus/test/logic/26.2-left-join-on-vs-where.sqllogic
----

## What was implemented

When a SELECT with GROUP BY projects a grouped column with an alias (e.g.
`select grp as g, count(*) as cnt from t group by grp`), the alias was being
silently dropped — output rows came back keyed on the underlying column name
(`grp`) instead of the SELECT alias (`g`). The same shape was visible in 26.2
where `select ow_l.id as lid, count(...) as cnt … group by ow_l.id` produced
`{"id":…}` instead of `{"lid":…}`. The bug was framed as HAVING-specific in the
original report but reproduces whenever GROUP BY is present and the alias
renames a grouped column reference.

### Code changes

1. `select-aggregates.ts` — `checkNeedsFinalProjection` was widened to also force
   a final projection when any projection is a simple column reference whose
   SELECT-list alias differs from the underlying column name. Previously it
   only triggered for non-trivial expressions, so an alias-only rename on a
   grouped column was a no-op and the AggregateNode's column-naming (which
   uses `colRef.expression.name`) leaked through.

2. `select.ts` — after the aggregate path's final ProjectNode is built, an
   `aggregateProjectionScope` is captured and passed to the post-aggregate
   `applyOrderBy` (and `applyLimitOffset`), mirroring what the non-aggregate
   path already does via `finalResult.projectionScope`. Without this, ORDER BY
   could not resolve a SELECT-list alias like `order by g` after the alias
   started reaching the output.

3. `select-modifiers.ts` — `createProjectionOutputScope` was promoted from
   private to exported so the aggregate path can reuse it.

The `preserveForAggregate` flag (HAVING-only / ORDER-BY-only aggregate stripping)
was reviewed and left unchanged — the existing logic correctly handles the
intersection with the new alias-driven path: `hasHavingOnlyAggregates` /
`hasOrderByOnlyAggregates` are computed from `dedupeNewAggregates` and don't
fire merely because a SELECT alias renamed a grouped column.

### Test changes

- `26.2-left-join-on-vs-where.sqllogic`: line 42 expectation updated from
  `{"id":1,"cnt":1}` (the buggy output) to `{"lid":1,"cnt":1}`. The
  `-- TODO bug:` notes above it were removed.

- `25.1-nested-aggregates.sqllogic`: replaced the commented-out HAVING-in-derived-
  table block (which had a non-discriminating threshold of 25 — every group
  qualified, so the expected total of 120 was just wrong) with a positive test
  using threshold > 35 (eliminates group 'a'=30, keeps b=70 and c=50, outer
  sum=120). This is regression coverage that HAVING propagates through derived
  tables.

- `07.3-group-by-extras.sqllogic`: added three new positive tests under the
  `gx` table covering:
  - alias-survives + ORDER BY by alias (`order by g`)
  - same with HAVING
  - minimal repro: alias-only on grouped column, no aggregates

## How to validate

`yarn build`, `yarn test`, and `yarn lint` (in `packages/quereus`) all pass.
Specifically the new and updated SQL logic tests in 07.3, 25.1, and 26.2 cover
the fix.

Manual sanity checks:
- `select grp as g, count(*) as cnt from gx group by grp;` → `{"g":…,"cnt":…}`
- `select grp as g from gx group by grp order by g;` → ordered output, alias
  visible in ORDER BY.
- 07.3 line 22 (`select grp, count(*) as cnt from gx group by grp order by grp`)
  still works (underlying column name fallback path).
- 07.3 line 41 (`order by 2 desc`, ordinal) and line 95 (`order by max(val)`,
  ORDER-BY-only aggregate) — unchanged code paths, regression-checked.

## Aspects worth a closer look during review

- ORDER BY scope layering: `aggregateProjectionScope` is now passed to
  `applyOrderBy` for the aggregate path. The projection scope is layered ABOVE
  `selectContext.scope` via `ShadowScope`, so projection-output names win over
  aggregate-output names when both exist. For grouped column aliases this is
  the desired behavior; verify no existing test relies on the old precedence.

- `applyLimitOffset` also now receives `aggregateProjectionScope`. LIMIT/OFFSET
  expressions referencing aliases are unusual but the projection scope is
  harmless when the expressions are literals (the common case); the symmetry
  with the non-aggregate path is the reason for the change.

- The new alias-detection in `checkNeedsFinalProjection` does a case-insensitive
  comparison via `.toLowerCase()` on both sides. This matches existing
  case-insensitive handling elsewhere in the planner (e.g.,
  `isIdentityProjection`).
