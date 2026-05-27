description: Recognize the empty key ([], ≤1-row) as join coverage and propagate ≤1-row through joins; migrate join key-coverage onto the unified keysOf/isUnique surface. Review must sweep for further empty-key opportunities.
files: packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, docs/optimizer.md
----

## Background

The `unified-key-inference-surface` work (commit `12d9f03f`, now in
`tickets/complete/`) landed a single uniqueness read surface — `keysOf` /
`isUnique` in `planner/util/fd-utils.ts` — that correctly reconciles all three
places a uniqueness fact can live, **including the empty key `[]`**. An empty
key means the relation has at-most-one-row (cardinality 0–1), and `keysOf`
handles it soundly: `hasSingletonFd` surfaces the `∅ → all_cols` FD as `[]`,
and `normalizeKeys` makes `[]` subsume every other key (it is a subset of all).

That surface is *read* by the distinct / orderby / groupby rules, but the
**join key-propagation paths were never migrated onto it** and still reason
over raw `RelationType.keys` only. As a result they silently ignore the empty
key — and an empty key is the single most powerful uniqueness fact there is,
because it caps cardinality at one row.

The completed ticket's review explicitly flagged this as a carried-forward
completeness gap (see `tickets/complete/unified-key-inference-surface.md`,
"Findings disposition → Minor"):

> `joinPairsCoverKey` requires `k.length > 0`, so an empty key (`[]`, ≤1-row)
> on the opposite side of a join is not recognized as coverage — a join against
> a provably ≤1-row side will not preserve the other side's keys. Also,
> `combineJoinKeys` (logical-keys path) lacks the FD-superkey coverage branch
> that `analyzeJoinKeyCoverage` (physical path) has.

## The opportunity

When one side of a join is provably ≤1-row (carries the empty key), each row on
the *other* side matches at most one row on that side — there is only ≤1 row in
total to match, independent of any equi-pairs. Therefore:

- the other side's unique keys survive the join unchanged, and
- if **both** sides are ≤1-row, the join result is itself ≤1-row (the empty key
  propagates), letting downstream DISTINCT / ORDER BY / GROUP BY collapse and
  cardinality estimates pin to 1.

Today none of this fires because two helpers hard-exclude the empty key:

- `joinPairsCoverKey` (`key-utils.ts`): `keys.some(k => k.length > 0 && …)` —
  the `k.length > 0` guard drops the empty key.
- `coversLogicalKey` inside `analyzeJoinKeyCoverage` (`key-utils.ts`): same
  `key.length > 0` guard.

Both helpers also read only logical `RelationType.keys`, so an empty key that
exists *only* as a `∅ → all_cols` FD (e.g. a scalar-aggregate subquery, a
`limit 1`, a fully-constant-bound filter) is invisible to them even though
`keysOf` / `isUnique` would report it.

A provably-empty key arises more often than it looks: `select count(*) from t`,
`… limit 1`, a filter that pins every PK column to a constant, a join whose
other side is already ≤1-row, an aggregate with no GROUP BY, etc. Missing it
means the optimizer keeps redundant DISTINCT/sort/aggregate machinery and
over-estimates cardinality on exactly the shapes where it could prove "one row".

## Scope

1. **Empty-key coverage.** A side whose `keysOf` includes `[]` (≤1-row) covers
   the join unconditionally — recognize this in both `combineJoinKeys` and
   `analyzeJoinKeyCoverage` so the opposite side's keys survive even with no (or
   non-covering) equi-pairs. Soundness note: the empty key proves ≤1 *matching*
   row regardless of the join predicate, so this holds for inner/cross/left/
   right; for the preserved (non-null-padded) side it is sound under outer joins
   too.

2. **Empty-key propagation.** When both join inputs are ≤1-row, the result is
   ≤1-row — emit the empty key (`∅ → all_cols`, via `singletonFd`/`superkeyToFd`)
   on the join output so the ≤1-row fact survives upward.

3. **Migrate join coverage onto `keysOf` / `isUnique`.** Replace the raw
   `RelationType.keys`-only checks in the join paths with the unified surface so
   FD-derived keys (including the empty key from `hasSingletonFd`) and the
   FD-superkey coverage branch are all consulted. This also closes the secondary
   gap the review noted — `combineJoinKeys` lacking the FD-superkey coverage
   branch that `analyzeJoinKeyCoverage` already has.

4. **Soundness boundary.** Keep the existing soundness discipline: never claim a
   key that does not hold. The empty-key coverage rule is additive completeness;
   it must not relax the null-padding reasoning for the *null-extended* side of
   an outer join.

## Review reminder (carry forward to the review stage)

The empty key is a recurring blind spot — wherever code branches on
`keys.length > 0`, `k.length > 0`, "has a non-empty key", or only consults
`RelationType.keys` instead of `keysOf` / `isUnique`, it likely drops the ≤1-row
case. **During review of the implementation, do a dedicated sweep for further
empty-key / ≤1-row opportunities beyond the join paths fixed here** — cost model
cardinality, predicate pushdown, semi/anti-join folding, limit/offset reasoning,
subquery decorrelation, and any other consumer that still reads keys directly
rather than through the unified surface. File follow-up tickets for any found.

## Validation expectations

- A join with a provably ≤1-row side (e.g. scalar-aggregate subquery, `limit 1`,
  fully PK-constant-bound filter) preserves the other side's keys; assert via
  `query_plan()` properties / `keys-propagation.spec.ts`.
- A join of two ≤1-row sides reports the empty key on its output.
- DISTINCT / ORDER BY / GROUP BY over such a join collapse as they already do
  for an explicit empty key (reuse the existing empty-key collapse paths).
- No regression in the Tier-1 key-soundness property harness
  (`property.spec.ts` "Key Soundness") — the additions are completeness-only and
  must keep that suite green.
- Update `docs/optimizer.md` (§ Functional Dependency Tracking / join key
  propagation) to document empty-key coverage and propagation through joins.
