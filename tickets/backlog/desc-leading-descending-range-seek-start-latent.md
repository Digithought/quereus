---
description: Latent — scanLayer seek-start for a DESC-leading key ignores physical scan direction; if a descending range plan (plan.descending=true with bounds) is ever emitted, the backward walk seeks from the wrong end and drops rows. Affects both primary and secondary branches. Currently unreachable.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/scan-plan.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts
---

## Why this is filed (and why it is NOT a live bug today)

During review of `primary-pk-desc-leading-range-scan-drops-rows` I confirmed the
implementer's flagged worry is real *in shape* but **currently unreachable**:

- `scan-plan.ts` `isDescendingScan()` returns true only when
  `params.get('ordCons') === 'DESC'` **or** `planType === 1 || planType === 4`.
- `ordCons` is **never emitted** anywhere in `src/`.
- The only `plan=` values emitted by `rule-select-access-path.ts` are
  `{0, 2, 3, 5, 6, 7}` — **never 1 or 4**.

Therefore `plan.descending` is **always `false`** in the current engine, the
`isAscending` branch in `scanLayer` is always taken, and the bug below cannot
fire. This is a future-proofing concern, not active work — hence backlog.

## The latent defect

In `scan-layer.ts`, for a DESC leading key (`isDescFirstColumn`) the seek
`startKey` is selected from `plan.upperBound` **regardless of physical scan
direction** (both the primary branch ~L72-79 and the secondary branch ~L154-157).
The direction-aware early-termination block is correctly gated on `isAscending`,
but the **seek start is not**.

If a future change ever emits a descending range plan (`plan.descending = true`
with a leading-column bound on a DESC-leading key — e.g. by emitting `plan=1`/`4`,
setting `ordCons=DESC`, or reverse-walking an index to satisfy `ORDER BY a ASC`
over a DESC-leading key), then `safeIterate(tree, /*ascending*/ false, startKey)`
would start the **backward** walk from the upper bound. For `PRIMARY KEY (a DESC, b)`
with rows `[30,0],[20,0],[10,0]` (physical ascending-compare order) and
`startKey=[upper]`, the backward walk begins at the largest key `<= [upper]` and
descends — **skipping `[30,0]`** (which sorts before `[upper]` due to the
short-key/prefix branch in `primary-key.ts` `arrA.length - arrB.length`). Rows at
the front of the physical order are dropped, reproducing the exact class of bug
the original ticket fixed, but on the descending path.

## Expected behavior

Seek-start selection must depend on the *physical* walk direction, not just the
key's declared direction:
- ascending physical walk (`isAscending`) over DESC-leading → seek from upper bound (current, correct);
- descending physical walk over DESC-leading → seek from lower bound (and terminate at upper).
Equivalently: the four combinations of `{isAscending} × {isDescFirstColumn}` each
pick the seek-from end and the terminate-at end consistently. The same fix applies
symmetrically to the secondary-index branch.

## Acceptance

- A reproducing test that forces `plan.descending = true` with a leading-column
  bound on a DESC-leading PK (and on a DESC-leading secondary index) and asserts
  no rows are dropped. NOTE: there is currently **no supported path** to emit such
  a plan — closing this likely requires first adding a descending-range emitter
  (or a test-only hook to inject `plan.descending`/`plan=4`). Scope that decision
  as part of the work; do not ship the emitter without the seek-start fix.
- Both primary and secondary branches of `scanLayer` covered.
