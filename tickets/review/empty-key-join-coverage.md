description: Review the empty-key (≤1-row) join coverage work — logical combineJoinKeys empty-key recognition, physical analyzeJoinKeyCoverage migration onto keysOf/isUnique with ≤1-row empty-key propagation through joins. Includes a mandatory dedicated sweep for further empty-key / ≤1-row opportunities.
files: packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md, packages/quereus/src/planner/nodes/limit-offset.ts
----

## What landed

Recognizes the empty key `[]` (the at-most-one-row / ≤1-row fact) as join
coverage and propagates ≤1-row-ness through joins, and migrates the physical
join key-coverage path onto the unified `keysOf` / `isUnique` surface
(`fd-utils.ts`). Build, full quereus test suite (3621 passing, 9 pending), the
`property.spec.ts` "Key Soundness" tier, and the quereus eslint all pass.

### Logical layer — `combineJoinKeys` / `joinPairsCoverKey` (`key-utils.ts`)

- `joinPairsCoverKey` dropped its `k.length > 0` guard, so a length-0 (empty)
  key is unconditional coverage (`[].every(...)` is vacuously true). A ≤1-row
  side caps the partner at one matching row regardless of equi-pairs.
- LEFT / RIGHT branches no longer early-return `[]` on empty `equiPairs` — they
  run the (now empty-key-aware) coverage check with an empty eq-set, so a ≤1-row
  opposite side still preserves keys with no equi-pairs.
- When **both** sides carry a logical empty key, inner/cross/left/right emit the
  empty key (deduped via a new `dedupeKeys` helper); full outer stays `[]`.
- Per the design's logical-vs-physical layering: `combineJoinKeys` recognizes
  **only** the logical empty key (length-0 `RelationType.keys` entry) and has no
  FD access by design. FD-provable ≤1-row-ness flows through the physical path.

### Physical layer — `analyzeJoinKeyCoverage` (`key-utils.ts`) + `propagateJoinFds` (`join-utils.ts`)

- Builds a `KeyRel` per side (`{ getType: () => leftType, physical: leftPhys }`),
  guarded against `leftType` / `rightType` being `undefined` (falls back to the
  legacy `coversLogicalKey || isSuperkey` check only then).
- `leftKeyCovered` / `rightKeyCovered` collapse to a single
  `isUnique(equiPairs.map(p => p.left/right), rel)` call — folds the old
  `coversLogicalKey || isSuperkey` pair AND adds empty-key recognition
  (`[] ⊆ anything`, so a ≤1-row side is always covered).
- `preservedKeys` now sourced from `keysOf(leftRel)` / `keysOf(rightRel)` (right
  shifted by `leftColumnCount`) instead of logical-keys-only, closing the
  acknowledged completeness gap (FD-derived keys now flow through).
- When **both** sides are ≤1-row (`isUnique([], rel)`), `[]` is pushed into
  `preservedKeys` for inner/cross/left/right (not full outer). `withKeyFds` →
  `superkeyToFd([], totalCols)` materializes it as the singleton `∅ → all_cols`
  FD on the join output. No `propagateJoinFds` signature change.
- semi/anti `preservedKeys` also sourced from `keysOf(leftRel)` so a ≤1-row left
  side propagates its empty key to the (left-shaped) output.

## Validation / use cases (tests added)

In `test/optimizer/keys-propagation.spec.ts`:

- **`combineJoinKeys` unit tests** (`empty-key (≤1-row) coverage` describe): one
  side ≤1-row preserves the other side's keys without equi-pairs (INNER/CROSS/
  LEFT/RIGHT); both sides ≤1-row → output advertises `[]`; SEMI passes the empty
  key through; FULL stays `[]`.
- **Integration scenarios** (`Empty-key (≤1-row) join coverage` describe), using
  ≤1-row sources that provably emit a singleton FD today:
  - scalar-aggregate subquery `(select count(*) ...)`,
  - full-PK-equality filter `(select * from w where wid = 1)`.
  Asserts: ≤1-row side preserves the other side's key-encoding FD; two ≤1-row
  sides → singleton `∅ → all` FD on the join output; DISTINCT eliminated over a
  ≤1-row join.

Run: `yarn workspace @quereus/quereus test` (full), or filtered
`--grep "empty-key|Empty-key|combineJoinKeys|≤1-row|Soundness"`.

## Known gaps / honesty notes (reviewer: treat tests as a floor)

- **Integration tests assert FD *presence* on the join physical via `query_plan`,
  not end-to-end row results.** They confirm the FD is emitted and that DISTINCT
  is eliminated, but do not independently re-derive correctness of every join
  type's row output. A reviewer may want a behavioral test that the eliminated
  DISTINCT / preserved-key plan still returns correct rows.
- **ORDER BY / GROUP BY collapse over a ≤1-row join was NOT added as a test.** The
  ticket listed it as expected; I added DISTINCT (clearly key-driven and
  confirmed) but did not assert sort/group elimination, as I was unsure a
  dedicated ≤1-row sort/group-elimination rule fires today. Worth a reviewer
  check: does `SELECT ... ORDER BY` / `GROUP BY` over a two-≤1-row-side join
  actually collapse, and if not, is that a gap or out of scope?
- The redundant explicit `if (leftIsSingleton && rightIsSingleton) push([])` in
  `analyzeJoinKeyCoverage` is belt-and-suspenders: when a side is ≤1-row,
  `isUnique([], rel)` already makes it "covered", so the covered branch already
  pushes a `keysOf`-sourced `[]`. The explicit push is harmless (duplicate `[]`
  collapses in `addFd`) and documents intent, but is not strictly necessary.
  Reviewer may simplify if preferred.
- The `isUnique` all-columns behavior is *stricter* (more sound) than the old
  `isSuperkey(eqSet, fds, colCount)` when `eqSet` equals all columns of a bag
  (no key, not a set): old returned `true` (unsound), `isUnique` returns `false`.
  This is a correctness improvement, not a regression; Key Soundness stays green.

## REVIEW REMINDER — mandatory empty-key / ≤1-row sweep (carried forward)

The empty key is a recurring blind spot. **During this review, do a dedicated
sweep for further empty-key / ≤1-row opportunities beyond the join paths fixed
here** — wherever code branches on `keys.length > 0`, `k.length > 0`, "has a
non-empty key", or reads `RelationType.keys` directly instead of `keysOf` /
`isUnique`. Sweep cost-model cardinality, predicate pushdown, semi/anti-join
folding, limit/offset reasoning, and subquery decorrelation. File follow-up
tickets (`fix/` or `backlog/`) for anything found; do **not** expand this work.

**Confirmed candidate (verify + file follow-up):** `LimitOffsetNode.computePhysical`
(`packages/quereus/src/planner/nodes/limit-offset.ts`, ~lines 71–86) passes
source FDs through unchanged and does **not** emit a singleton `∅ → all_cols` FD
for `LIMIT 1` (nor for a constant `LIMIT n` with `n` resolvable to ≤1). A
`LIMIT 1` relation is provably ≤1-row, so it should advertise the empty key like
a scalar aggregate does. I deliberately did **not** rely on `LIMIT 1` in tests
for this reason. Recommend filing a `fix/` ticket.
