---
description: scanLayer seek-start now depends on the *physical* walk direction, not just the key's declared direction. Fixed the latent descending-range row-drop in both the primary and secondary branches; also corrected a reachable composite-secondary DESC + upper-bound seek wrap. Needs review.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/test/vtab/scan-layer-descending.spec.ts, packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
---

## What shipped

`scanLayer` (`packages/quereus/src/vtab/memory/layer/scan-layer.ts`) previously
chose its seek **start** key from the key's *declared* direction only:

- DESC-leading key → always seek from `plan.upperBound`;
- ASC-leading key → always seek from `plan.lowerBound`.

The early-termination block was already direction-aware but gated on
`isAscending`, so it simply never fired on a descending walk. The seek start was
the actual defect: a descending walk (`plan.descending = true`) over a
DESC-leading key seeked from the *upper* bound, started the backward walk at the
wrong end of the physical order, and dropped front-of-order rows.

### The fix — one rule across all four combinations

Seek-from end and terminate-at end are now derived from the physical walk
direction. Define `seekFromUpper = (isAscending === isDescFirstColumn)`:

| isAscending | isDescFirstColumn | seek from | terminate at |
|-------------|-------------------|-----------|--------------|
| true (ASC walk)  | false (ASC key)  | lower | upper |
| true (ASC walk)  | true  (DESC key) | upper | lower |
| false (DESC walk)| false (ASC key)  | upper | lower |
| false (DESC walk)| true  (DESC key) | lower | upper |

- **Seek start**: pick `upperBound` iff `seekFromUpper`, else `lowerBound`
  (absent that bound, fall back to the tree end `safeIterate` chooses for the
  direction). Composite keys still wrap the scalar bound in a single-element
  array so the comparator's short-key/prefix branch positions the seek.
- **Early termination**: break once the leading column passes the bound we
  *terminate at* — `!seekFromUpper ⇒ terminate at upper`, `seekFromUpper ⇒
  terminate at lower`. The `isAscending` gate is removed; the same comparison is
  correct for both walk directions (it only ever fires after `planAppliesToKey`
  has already rejected the row, so it is a pure optimization, never a
  correctness lever).

Applied symmetrically to **both** the `plan.indexName === 'primary'` branch and
the secondary-index branch. The `equalityPrefix` (plan=7) sub-branch is
untouched (plan=7 is never emitted descending).

## Why this was latent / reachability

The descending path is still **not reachable through SQL**: `scan-plan.ts`
`isDescendingScan()` returns true only for `ordCons === 'DESC'` (never emitted)
or `planType` 1/4 (never emitted — `rule-select-access-path.ts` produces only
`{0,2,3,5,6,7}`). So `plan.descending` is always `false` in the live engine.
Per the ticket, **no descending-range emitter was added** — that is a larger
feature, and the ticket explicitly said not to ship the emitter speculatively.
The descending cases are therefore exercised by constructing the `ScanPlan`
directly in a unit test, not via SQL.

## Bonus fix on a *reachable* path (please scrutinize)

While unifying the secondary branch I removed an asymmetry: the old DESC-leading
secondary seek used the **scalar** `plan.upperBound.value` even for a composite
index, whereas the primary branch (and the ASC secondary branch) wrap it as
`[value]`. For a composite secondary index, seeking with a bare scalar against
array-shaped keys feeds a non-array into the array comparator (`arrA[0]` on a
number → `undefined`). The unified code now wraps consistently. This is a
**reachable** ascending path (`create index idx (k DESC, name); select … where k <= 25`),
so I added a sqllogic case to guard it (see below). Reviewer: confirm this wrap
is correct and that no other caller depended on the old scalar form.

## Tests / validation use cases

New unit spec `test/vtab/scan-layer-descending.spec.ts` builds descending
`ScanPlan`s directly against the committed memory layer (obtained via
`db._getVtabModule('memory').module.tables.get(...).currentCommittedLayer`):

- **Primary, DESC-leading, descending, lower+upper** → the headline repro
  (`a ∈ [12,28)` over `[30,25,20,15,10]` → `[15,20,25]`; pre-fix returned `[]`).
- Primary DESC-leading descending, **lower-only** and **upper-only**.
- Primary **ASC-leading** descending lower+upper (the mirror combination).
- **Secondary** DESC-leading descending lower+upper.
- Secondary **ASC-leading** descending lower+upper.
- Ascending DESC-leading parity case (reachable path unchanged).

Verified as a real regression guard: with the fix reverted, **5 of the 7**
descending cases fail; the lower-bound-only case passes both ways (no seek skip
occurs there), and the ascending parity case is unchanged — exactly as the
direction analysis predicts.

`test/logic/05.1-composite-pk-range-scan.sqllogic` gains one reachable case:
`select id from idx_d where k <= 25` over `create index idx_kd on … (k DESC, name)`
→ `[{"id":1},{"id":2}]`, guarding the composite-secondary upper-bound wrap.

### Results
- `yarn typecheck` (quereus) → exit 0.
- `yarn lint` (quereus) → exit 0.
- `yarn test` (quereus) → **3591 passing, 9 pending** (was 3584 at the prior
  review's baseline; +7 from the new spec). No regressions.

## Known gaps / honest flags for the reviewer

- **Still no SQL-reachable descending plan.** This closes the seek-start defect
  so a future emitter is safe, but does not add the emitter. If the reviewer
  wants reachability proven end-to-end, that needs a separate emitter ticket
  (plan=4 / `ordCons=DESC` / reverse-walk-for-ORDER-BY) — out of scope here and
  deliberately deferred.
- **Unit test reaches into internals** (`_getVtabModule`, `module.tables`,
  `manager.currentCommittedLayer`) because there is no public path to inject a
  descending plan. If a cleaner seam is preferred, that is a test-infra change.
- **`yarn test:store` not run.** Memory-module change; the prior related ticket
  set the same precedent. The added sqllogic case would also run under the store
  harness — a reviewer preparing a release may want to confirm there.
- **`equalityPrefix` / plan=7 descending** not addressed (never emitted
  descending). The same direction-aware rework would be needed if a descending
  prefix-range emitter ever lands.
- The `seekFromUpper` derivation assumes `planAppliesToKey` keys off the leading
  column only (it does, for non-prefix plans). If that ever changes, the
  early-termination reasoning must be revisited.
