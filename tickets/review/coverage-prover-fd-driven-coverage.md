description: Review the FD-driven "body proves it" coverage primitive (`proveEffectiveKeyUnique`) added to the coverage prover — an output-relation uniqueness proof (delegating to `isUnique`), deliberately kept separate from v1 base-table `proveCoverage` for soundness. Audit the soundness argument and the framing deviation directly.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/test/covering-structure.spec.ts, docs/optimizer.md, docs/materialized-views.md, docs/lens.md
----

## What landed

A new obligation primitive in `packages/quereus/src/planner/analysis/coverage-prover.ts`:

```ts
export type EffectiveKeyResult =
  | { proved: true }
  | { proved: false; reason: 'not-a-key' | 'out-of-frame' };

export function proveEffectiveKeyUnique(
  root: RelationalPlanNode,
  keyColumns: readonly number[],
): EffectiveKeyResult;
```

Implementation is intentionally thin: reject any `keyColumns` index `< 0` or `>= root.getType().columns.length` as `out-of-frame`; otherwise return `proved` iff `isUnique(keyColumns, root)` (from `fd-utils.ts`), else `not-a-key`. No uniqueness logic is reimplemented — it delegates wholesale to the unified `isUnique` surface (declared keys, FD-closure-derived keys, all-columns/`isSet` fallback). The value the function adds over a raw `isUnique` call is the named obligation seam for the lens prover, the diagnostic result shape, and the load-bearing soundness doc block.

This is the primitive that `lens-prover-and-constraint-attachment` consumes for its `obligation: proved` class (the "body proves it" branch of the lens constraint-role split).

## ⚠️ Framing deviation — audit this directly

**The ticket as filed framed this as widening base-table `proveCoverage` to recognize UC columns by FD closure, with base-PK reconstructibility as a requirement. That framing was rejected during planning as unsound, and this implementation deliberately does NOT do it.** The deviation is the central design decision; the reviewer should audit the soundness argument, not just the code.

The argument (documented in the module doc block in `coverage-prover.ts`, and in all three docs):

- An FD-derived output key **cannot** prove a *base-table* constraint. A `group by x` body's output is *always* unique on `x` — whether or not the base table `T` satisfies `unique(x)` — because grouping collapses base-row duplicates: two base rows with `x = 5` (a base violation) still yield exactly one output row for `x = 5`. The masking is the whole problem; output-key uniqueness is silent about base duplicates.
- Aggregating bodies also drop the base PK, so the "identify the conflicting base row" half of the v1 covering contract (REPLACE/IGNORE conflict resolution) is unrecoverable.

So `proveEffectiveKeyUnique` is a proof about the **derived (output) relation's own** constraint — distinct from base-table covering. It is kept out of `proveCoverage` to preserve the v1 soundness boundary; `proveCoverage` and `linkCoveredUniqueConstraints` are **unchanged**.

Soundness notes embedded in the function doc (worth verifying):
- **Ordering** irrelevant — intrinsic-uniqueness proof needs no ordered point-lookup path, so a `group by` body with no `ORDER BY` qualifies.
- **PK reconstructibility / observation-equivalence** irrelevant — no enforcement, no base row to identify.
- **NULL-skip** composes by subsumption: `isUnique` proves *strict* key-uniqueness (NULL as a value); SQL `unique` is NULL-permissive (weaker), so strict-unique ⟹ `unique`.
- **Superkey semantics**: a real key ⊆ `keyColumns` still implies the declared (larger) key — `isUnique` returns true for any superset of a key.

## `fd-utils.ts` untouched

The ticket listed `fd-utils.ts` in `files:` but expected it to be read-only ("Only touch it if a small shared helper genuinely de-duplicates code; if nothing is needed, leave it and drop it from the `files:` list at review."). **Nothing was needed** — `isUnique`/`keysOf` already do everything. `fd-utils.ts` was not modified and has been dropped from this ticket's `files:` list.

## Tests (all green)

Added to `packages/quereus/test/covering-structure.spec.ts`:

- `describe('coverage prover — effective-key (body proves it)')` — 6 end-to-end cases against the real optimizer (reusing the `bodyRoot` helper):
  - group-by proves the composite key `[0,1]` → `proved`
  - group-by does NOT prove a strict subset `[0]` → `not-a-key`
  - group-by proves a superset of the group key `[0,1,2]` → `proved` (superkey semantics)
  - nullable group key (`x integer null`, `group by x`) `[0]` → `proved` (strict-unique ⟹ NULL-permissive)
  - non-aggregating body `select id, x from t` — `[0]` (PK FD survives projection) → `proved`; `[1]` → `not-a-key`
  - out-of-frame `[99]` → `out-of-frame`
- `describe('coverage prover — effective-key (stub unit)')` — 3 lightweight `RelationType` + `physical.fds` stub cases (cast to `RelationalPlanNode`; the function only touches `getType()`/`physical`), mirroring `test/optimizer/keysof-isunique.spec.ts`: the out-of-frame guard (incl. negative and mixed indices), the `isUnique` delegation, and the empty-key (≤1-row vs bag) edge.

Confirmed the optimizer emits the group-key FD on the body root (via `propagateAggregateFds`) — the e2e group-by cases pass without weakening any assertion, so `physical.fds` is populated as expected.

### Validation commands run
- `yarn workspace @quereus/quereus run build` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0
- Targeted `mocha covering-structure.spec.ts` → **26 passing** (17 pre-existing v1 + 9 new)
- `yarn test` (full memory suite, all workspaces) → quereus core **3770 passing, 9 pending**; all other workspaces green; `Done in 2m 29s`, no failures. (The one `failing`-substring hit in the log is an intentional `failingKv` test fixture in quereus-sync, not a failure.)

## Suggested reviewer focus / known gaps

- **Audit the soundness argument**, not just the diff — it is the reason this is a separate primitive and the reviewer is the right place to catch a hole in it.
- **Column frame contract**: `keyColumns` are body-*output* indices. The lens prover owns the logical→output mapping; this primitive does zero attribute-id translation. Confirm that contract reads cleanly for the downstream lens ticket (which is not yet landed — this is the seam it will call).
- **Test floor, not ceiling**: the e2e cases cover stream/hash-aggregate-agnostic group-by (the optimizer picks the physical aggregate); a reviewer may want to confirm both `StreamAggregateNode` and `HashAggregateNode` paths surface the same FD (both call `propagateAggregateFds`, so they should, but it is asserted only indirectly via whichever the planner chose).
- **No enforcement is wired** by this ticket — it is a pure analysis primitive returning a verdict. Whether a covering *enforcement* structure (detection-only, ABORT) can ever be FD-derived is explicitly out of scope (row-time-enforcement / lens tickets).
