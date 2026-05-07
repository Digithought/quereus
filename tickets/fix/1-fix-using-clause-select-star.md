description: USING clause + select * drops one of the duplicate-named columns instead of disambiguating like other joins
prereq:
files:
  packages/quereus/test/logic/11.1-join-using.sqllogic
  packages/quereus/src/planner/building/select.ts
----
## Problem

A join with a `using (col)` clause projects only one of the two duplicate-named columns when expanded via `select *`, instead of producing both sides (e.g. `id` and `id:1`) the way Quereus does for other joins. Effectively the left side's full row content appears partially missing through a USING projection.

A related symptom: GROUP BY + HAVING combined with `select *` over a USING join drops projection aliases.

Note: Quereus has *not* implemented SQLite's "merge USING column into a single output projection" semantics (see the comment at `11.1-join-using.sqllogic:1-4` and the ambiguity check at line 18). That non-merging behaviour is intentional for now. The bug here is the *opposite*: in the non-merge model, `select *` should expose both copies of the USING key (with disambiguation suffix), not silently drop one.

## Expected behavior

For `select * from u_a join u_b using (k)`, the output should expose every column of both tables, with shared-name columns disambiguated (e.g. `id`, `k`, `va`, `id:1`, `k:1`, `vb`) — matching how Quereus already handles two same-named columns in a plain `inner join ... on ...`. No data should disappear.

GROUP BY + HAVING with `select *` + USING must likewise preserve all projection aliases that would be present in the non-grouped form.

## Reproduction

`packages/quereus/test/logic/11.1-join-using.sqllogic` — observation in the original review report (no `select *` assertion is currently in-tree because all queries qualify references to dodge the bug; see the explanatory header at lines 1-4 and the qualified-only style throughout). The implementer should add a `select *` assertion against `u_a join u_b using (k)` (and an analogous LEFT JOIN case) to lock in the expected disambiguated output.

Compare with the same shape using an equivalent `on u_a.k = u_b.k` predicate to confirm the divergence comes from USING-specific projection handling.

## Likely investigation areas

- `packages/quereus/src/planner/building/select.ts` — `select *` (star) expansion when the FROM tree contains a USING join. Suspect the using-key columns are being filtered out of one side's contribution to the wildcard expansion (an over-eager attempt at the SQLite "merge" behaviour that then doesn't produce the merged column either).
- Same file's GROUP BY / HAVING projection-alias propagation through a USING join.
- Compare with the `on`-predicate equi-join code path, which produces the expected `:1`-suffixed duplicates.
