description: Add an FD-driven "body proves it" recognition path to the coverage prover — prove a logical `unique` is discharged by the body's *effective key* (via the unified `keysOf`/`isUnique`/FD-closure surface) when the constraint columns are subsumed by the body's key, even when not literally projected (e.g. a `group by x, y` body proving `unique(x, y)`). This is the obligation primitive `lens-prover-and-constraint-attachment` consumes for its `obligation: proved` class. It is **separate** from v1's base-table covering-enforcement prover (`proveCoverage`), which is left unchanged for a soundness reason discovered during planning (below).
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/covering-structure.spec.ts, docs/optimizer.md, docs/materialized-views.md, docs/lens.md
----

## Background — two different "coverage" questions

The v1 prover (`proveCoverage`, landed by `covering-structure-unique-enforcement`)
answers a **base-table** question: *does this MV's materialized row set cover a
`unique` constraint on a base table `T`, keyed so a point lookup answers the
uniqueness question, with the base PK reconstructible so a conflicting row can be
identified?* It requires literal projection of every UC column + the source PK,
an `order by` permutation of the UC columns, and predicate/NULL-skip alignment.

This ticket adds a **different** question, the one the lens prover actually needs
for its `obligation: proved` class:

> *Is the body's own output relation provably unique on the declared key columns,
> via its effective key (FD closure)?*

Canonical case (from `lens-prover-and-constraint-attachment` § Key Tests):

```sql
-- logical table defined by:
select x, y, sum(z) from B.t group by x, y     -- declares: unique(x, y)
```

The `group by x, y` makes the output one row per distinct `(x, y)`, so the output
is intrinsically unique on `(x, y)`. The logical `unique(x, y)` is **vacuously
satisfied** — no runtime enforcement structure is needed; the body's structure is
the proof. The optimizer already exposes this as the group-key FD
`{0,1} → {2}` on the aggregate's physical properties (`propagateAggregateFds`),
which `keysOf`/`isUnique` read.

## Key planning finding — why NOT to widen base-table `proveCoverage`

The ticket as filed framed this as widening `proveCoverage` to recognize the UC
columns "by FD closure rather than literal projection," and listed base-PK
reconstructibility as a requirement. **Implementing it that way is unsound**, and
the v1 module's own invariant ("a false `Covers` is latent corruption once
enforcement routes through the structure") is the reason:

- A `group by x` body's output is **always** unique on `x`, *whether or not* the
  base table `T` satisfies `unique(x)`. Grouping collapses base-row duplicates, so
  two base rows with `x = 5` (a base-constraint violation) still yield exactly one
  output row for `x = 5`. **Output-key uniqueness therefore cannot prove a
  base-table constraint** — the masking is the whole problem.
- Aggregating bodies also drop the base PK, so the "identify the conflicting base
  row" half of the v1 covering contract (needed for REPLACE/IGNORE conflict
  resolution) is unrecoverable.

So the FD-derived recognition is **not** a generalization of base-table covering;
it is a proof about the **derived (output) relation's own** constraint. Keeping it
out of `proveCoverage` preserves the v1 soundness boundary and the eager-link
path (`linkCoveredUniqueConstraints`) untouched. Whether a covering *enforcement*
structure can ever be FD-derived (detection-only, ABORT) is the separate concern
of the row-time-enforcement / lens tickets, not this one.

This deviation from the filed framing is deliberate and is the central design
decision of the ticket — document it in `coverage-prover.ts` and the docs.

## Design — the new primitive

Add to `packages/quereus/src/planner/analysis/coverage-prover.ts`:

```ts
export type EffectiveKeyResult =
  | { proved: true }
  | { proved: false; reason: 'not-a-key' | 'out-of-frame' };

/**
 * "Body proves it": true iff the body's output relation is provably unique on
 * `keyColumns` (output-column indices) via its effective key — declared keys,
 * FD-closure-derived keys, or the set/all-columns fallback, all read through the
 * unified `isUnique` surface.
 *
 * `root` MUST be the optimized body relation (the same node v1 receives:
 * `db.getPlan(body).getRelations()[0]`), so `physical.fds` is populated.
 *
 * Soundness notes (why the v1 covering checks do NOT apply here):
 *  - Ordering: irrelevant — a proof of intrinsic uniqueness needs no ordered
 *    point-lookup path, so the canonical `group by` body (no ORDER BY) qualifies.
 *  - PK reconstructibility / observation-equivalence: irrelevant — there is no
 *    enforcement and no base row to identify; the constraint is on the output.
 *  - NULL-skip: composes trivially by subsumption. `isUnique` proves *strict*
 *    key-uniqueness (NULL treated as a value); SQL `unique` is NULL-permissive
 *    (weaker), so strict-unique ⟹ `unique` holds. No extra NULL handling.
 *  - Superkey semantics are correct: if the body's real key is a subset of
 *    `keyColumns`, the (stronger) constraint on the smaller set still implies the
 *    declared one.
 */
export function proveEffectiveKeyUnique(
  root: RelationalPlanNode,
  keyColumns: readonly number[],
): EffectiveKeyResult;
```

Implementation is intentionally thin — the inference is already shipped:

- Reject `out-of-frame`: any index in `keyColumns` `< 0` or `>= root.getType().columns.length`.
- Return `proved` iff `isUnique(keyColumns, root)` (from `fd-utils.ts`). Otherwise `not-a-key`.

Do **not** reimplement uniqueness logic — delegate to `isUnique` (DRY). The value
this function adds over a raw `isUnique` call is the named obligation seam for the
lens prover, the diagnostic result shape, and the load-bearing soundness
documentation above.

`fd-utils.ts` is expected to be **read-only** here (`isUnique`/`keysOf` already
exist). Only touch it if a small shared helper genuinely de-duplicates code; if
nothing is needed, leave it and drop it from the `files:` list at review.

### Column frame

`keyColumns` are **body-output** column indices. The lens prover owns the
logical-column → output-column mapping (it knows the body's projection); this
primitive does not do any base-table attribute-id translation (that was a v1
mechanism for the base frame and does not apply). This keeps the primitive clean
and avoids threading provenance through the aggregate boundary (where group-by
output attributes are minted fresh — see `aggregate-node.ts buildAttributes`).

## Key tests (TDD)

End-to-end against the real optimizer (extend `test/covering-structure.spec.ts`
with a new `describe('coverage prover — effective-key (body proves it)')` block;
reuse the `bodyRoot` helper):

- **group-by proves the composite key.** `create table t (id int primary key, x int not null, y int not null, z int)`; body `select x, y, sum(z) from t group by x, y`; `proveEffectiveKeyUnique(root, [0, 1])` → `proved: true`.
- **group-by does NOT prove a strict subset.** Same body; `proveEffectiveKeyUnique(root, [0])` → `proved: false, reason: 'not-a-key'` (two groups can share `x`).
- **group-by proves a superset of the group key.** Same body; if a 3rd output col existed, `[0,1,2]` (superset of group key) → `proved: true`. (Superkey semantics.)
- **nullable group key still proves it.** `x int null`; body `select x, count(*) from t group by x`; `proveEffectiveKeyUnique(root, [0])` → `proved: true` (strict-unique ⟹ NULL-permissive `unique`).
- **non-aggregating body whose key flows through.** body `select id, x from t` over `id int primary key`; `[0]` → `proved: true` (PK FD survives projection); `[1]` (just `x`, no key) → `proved: false`.
- **out-of-frame.** `proveEffectiveKeyUnique(root, [99])` → `proved: false, reason: 'out-of-frame'`.

Plus a stub-based unit test mirroring `test/optimizer/keysof-isunique.spec.ts`
(lightweight `RelationType` + `physical.fds`) for the `out-of-frame` guard and the
delegation to `isUnique`, so the primitive is covered without a full plan tree.

Regression: the existing `covering-structure.spec.ts` v1 cases must stay green —
`proveCoverage` and `linkCoveredUniqueConstraints` are not modified.

## TODO

- Add `proveEffectiveKeyUnique` + `EffectiveKeyResult` to `coverage-prover.ts`, delegating to `isUnique` from `fd-utils.ts`, with the soundness doc block.
- Add the module-level doc paragraph contrasting the two coverage questions and stating why FD-derived recognition is NOT folded into base-table `proveCoverage` (the grouping-masks-base-duplicates soundness argument).
- Add the new `describe` block + stub unit tests above; confirm the optimizer emits the group-key FD on the body root (it should, via `propagateAggregateFds`) — if a body root surprisingly lacks `physical.fds`, investigate before weakening any assertion.
- Docs: `docs/optimizer.md` § Coverage proving — add the effective-key/body-proves path and the soundness boundary; `docs/lens.md` — point the `obligation: proved` class at this primitive; `docs/materialized-views.md` § Covering structures — one line clarifying that FD-derived "body proves it" is an output-relation proof, not a base-table covering structure.
- Run `yarn build`, `yarn lint` (quereus, single-quoted globs on Windows), and `yarn test` (memory). Stream long output with `Tee-Object`/`tee` + a follow-up read. Record the passing count in the review handoff.
- Hand off to review with an honest note on the framing deviation (output-relation proof vs the filed base-table framing) so the reviewer audits the soundness argument directly.
