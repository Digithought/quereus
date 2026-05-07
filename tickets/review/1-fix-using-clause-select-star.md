description: select * over a join with duplicate-named columns (USING or ON-equi) now preserves both sides via `:N` disambiguation instead of silently dropping columns
prereq:
files:
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/test/logic/11.1-join-using.sqllogic
----
## What changed

`select * from u_a join u_b using (k)` used to return only 4 columns (`{id, k, va, vb}`) instead of 6 — silently dropping `u_a.id` and `u_a.k` because their names collided with `u_b`'s and the row→object conversion used the JoinNode's column names directly, where duplicates collapse on the second key.

The same bug affected any `select *` (or qualified column list with same-named columns) over an ON-equi-join — not just USING. The ticket framed it as USING-specific because the existing `11.1-join-using.sqllogic` queries qualified everything to dodge it; the underlying defect is one layer up.

### Root cause

`isIdentityProjection` in `select-modifiers.ts:199` was deciding that `select *` over a JoinNode was a no-op (same arity, same per-position names) and skipping the `ProjectNode` that would have applied `name`, `name:1`, … disambiguation in `project-node.ts:65-75`. Without that ProjectNode in the tree, the outer Sort/Filter/etc. wrappers exposed JoinNode's raw column names, which contained duplicates, and `rowToObject` (`core/utils.ts:4`) silently overwrote earlier keys with later ones.

### The fix

`isIdentityProjection` now returns `false` whenever the source exposes duplicate column names (case-insensitively), forcing a `ProjectNode` to be inserted so that downstream sees disambiguated names. One-liner conceptually; small Set-based check at the top of the function alongside the existing arity check.

`packages/quereus/src/planner/building/select-modifiers.ts:206-215` (new block).

## Use cases / behavioural expectations

For tables `u_a(id, k, va)` and `u_b(id, k, vb)` populated with shared `k` values:

- `select * from u_a join u_b using (k)` → 6 columns: `id, k, va, id:1, k:1, vb`, both sides' values intact.
- `select * from u_a left join u_b using (k)` → same 6 columns; unmatched `u_a` rows produce `null` for `id:1`, `k:1`, `vb`.
- `select u_a.id, u_a.k, u_a.va, u_b.id, u_b.k, u_b.vb from u_a join u_b on u_a.k = u_b.k` → same 6-column shape (was previously also broken).
- Existing pattern `select l.id, l.val_l, r.id, r.val_r from t_left l join t_right r on …` (already-tested in `11-joins.sqllogic:11-12`) continues to produce `{id, val_l, id:1, val_r}` — unchanged because that path already had projection-arity mismatch and so already inserted a ProjectNode.
- USING-key is *not* merged into a single output projection — Quereus intentionally does not implement SQLite's USING-merge semantics (see `11.1-join-using.sqllogic:1-4`); both copies of the key appear (`k` and `k:1`).

## Tests

`packages/quereus/test/logic/11.1-join-using.sqllogic` adds two new assertions:

- Line ~16-17: `select * from u_a join u_b using (k)` → 6-column disambiguated rows.
- Line ~26-27: `select * from u_a left join u_b using (k)` → 6 columns with right side null on miss.

The existing qualified-reference assertions are unchanged.

## Validation

- `yarn workspace @quereus/quereus lint` clean.
- `yarn workspace @quereus/quereus build` clean.
- `yarn test` (full repo): 596 pass, 1 fail. The one failure is `18-json-string-escapes.sqllogic:13` (`json_quote('String "\\ Test')`), pre-existing on `main`, unrelated — confirmed by stashing the change and re-running on stock main.
- Targeted re-run of `11.1-join-using`, `11-joins`, `11.2-comma-join`, `23-self-joins-duplicates`, `26-join-edge-cases`, `08.1-semi-anti-join`, `82-bloom-join`, `83-merge-join`, `91-merge-join-edge-cases`: 8/8 pass.

## Review focus

- Confirm the duplicate-name short-circuit in `isIdentityProjection` is the right granularity. The narrower alternative (only suppress when both occurrences trace back to *different* attribute IDs) was rejected as needlessly clever — any source that hands duplicate names to row→object conversion is a problem, regardless of provenance.
- Confirm there is no ProjectNode-skipping shortcut elsewhere in the pipeline (e.g. in window/aggregate paths) that bypasses the disambiguation. Aggregate path always builds a ProjectNode via `buildFinalAggregateProjections` when `needsFinalProjection`, and ProjectNode dedupes via `outputTypeCache` (`project-node.ts:65-75`), so it's already covered.
- The ticket also flagged "GROUP BY + HAVING + select * over USING drops projection aliases." That symptom was the same disambiguation issue rolling through the aggregate path; with this fix the ProjectNode at the end of `buildFinalAggregateProjections` produces disambiguated names. (No standalone test was added for this combination because Quereus's strict aggregate-projection validator rejects `select * group by u_a.id` on functional-dependency grounds — that's a separate, intentional restriction unrelated to the bug here.)
- USING-merge semantics remain intentionally not implemented; the ambiguity error for unqualified `k` (line 18 of the test file) is unchanged and asserted.
