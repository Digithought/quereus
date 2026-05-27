description: Recognize the empty key ([], ≤1-row) as join coverage and propagate ≤1-row through joins; migrate the physical join key-coverage path onto the unified keysOf/isUnique surface. Review must sweep for further empty-key opportunities.
files: packages/quereus/src/planner/util/key-utils.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/util/fd-utils.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, packages/quereus/test/property.spec.ts, docs/optimizer.md
----

## Background

The `unified-key-inference-surface` work (commit `12d9f03f`, in `tickets/complete/`)
landed `keysOf` / `isUnique` in `planner/util/fd-utils.ts` — a single uniqueness
read surface that reconciles all three places a uniqueness fact lives (declared
`RelationType.keys`, `PhysicalProperties.fds`, and `RelationType.isSet`),
**including the empty key `[]`**. An empty key means at-most-one-row
(cardinality 0–1). `keysOf` surfaces it from either a length-0 declared key or
the `∅ → all_cols` FD (`hasSingletonFd`), and `isUnique([], rel)` is `true` iff
the relation is ≤1-row.

That surface is read by the distinct / orderby / groupby rules, but the **join
key-propagation paths were never migrated onto it** and still reason over raw
`RelationType.keys` only, silently ignoring the empty key — the single most
powerful uniqueness fact (it caps cardinality at one row).

### Current code map

- `key-utils.ts`
  - `joinPairsCoverKey(keys, eqIndices)` (~line 162): `keys.some(k => k.length > 0 && k.every(...))` — the `k.length > 0` guard drops the empty key. Used by `combineJoinKeys`.
  - `combineJoinKeys(leftKeys, rightKeys, joinType, leftColumnCount, equiPairs?)` (~line 194): **logical** key path, called from `getType()` of `JoinNode`, `BloomJoinNode`, `MergeJoinNode`. Reads only logical `RelationType.keys` (ColRef arrays); has no FD access. `left`/`right` branches early-return `[]` when `equiPairs` is empty.
  - `analyzeJoinKeyCoverage(joinType, leftPhys, rightPhys, leftType, rightType, equiPairs, leftRows, rightRows, leftColumnCount)` (~line 276): **physical** path, called from `computePhysical()` of the three join nodes. Inner `coversLogicalKey` (~line 312) has the same `key.length > 0` guard; already has an FD-superkey branch via `isSuperkey(...)`. Builds `preservedKeys` from `leftLogicalKeys` / `rightLogicalKeys` only (logical-keys-only — acknowledged completeness gap in its own comment).
- `join-utils.ts`
  - `propagateJoinFds(... preservedKeys)` (~line 165): `withKeyFds` (~line 191) layers each preserved key onto the FD set via `superkeyToFd(key, totalColumnCount)`. **Note:** `superkeyToFd([], totalCols)` already produces exactly the singleton `∅ → all_cols` FD, so emitting `[]` in `preservedKeys` is sufficient to propagate the ≤1-row fact — no new emitter needed.
- `fd-utils.ts`: `keysOf`, `isUnique`, `KeyRel`, `hasSingletonFd`, `singletonFd`, `superkeyToFd`, `isSuperkey` — the unified surface to migrate onto.

## Design

The two layers stay distinct and stay consistent:

- **Logical layer (`combineJoinKeys` → `getType().keys`)** recognizes the
  **logical** empty key (a length-0 entry in `RelationType.keys`, e.g. TableDee).
  It has no FD access by design — `getType()` is the logical type and must not
  reach into physical properties.
- **Physical layer (`analyzeJoinKeyCoverage` → `propagateJoinFds` →
  `physical.fds`)** recognizes the empty key from **either** logical keys **or**
  the FD surface (`hasSingletonFd` / `isUnique([], rel)`), and emits the singleton
  FD on the join output when the result is ≤1-row.

Downstream consumers read uniqueness through `keysOf` / `isUnique`, which
consult **both** `getType().keys` (from `combineJoinKeys`) **and**
`physical.fds` (from `propagateJoinFds`). So a join whose ≤1-row-ness is only
provable via FDs still surfaces the empty key to DISTINCT / ORDER BY / GROUP BY
through the physical FD branch — `getType().keys` carrying only logical-derived
keys is correct and sufficient. This is the resolution to the review's
"`combineJoinKeys` lacks the FD-superkey branch" note: the consolidated
FD-aware coverage lives in the physical path (one `isUnique` call), which is
where FDs exist; the logical path only needs the logical empty key.

### Soundness

The empty key proves ≤1 *matching* row regardless of the join predicate, so
empty-key coverage holds for inner / cross / left / right. For the *preserved*
(non-null-padded) side it is sound under outer joins too. **Full outer is
excluded**: two ≤1-row sides that do not match produce two rows (one
left-padded, one right-padded), so the result is not ≤1-row — full outer keeps
its existing `[]` (drop-everything) behavior. The additions are
completeness-only; they must never relax the null-padding reasoning for the
null-extended side of an outer join, and must keep `property.spec.ts`
"Key Soundness" green.

### Key migration insight

In `analyzeJoinKeyCoverage`, `leftKeyCovered` (the equi-pairs cover a left-side
unique key) collapses to a single unified call:

```
const leftRel: KeyRel = { getType: () => leftType, physical: leftPhys };
const leftKeyCovered = isUnique(equiPairs.map(p => p.left), leftRel);
```

`isUnique(eqIndices, rel)` returns true when `eqIndices` is a superset of some
`keysOf` entry (covers declared keys, FD-derived keys, **and the empty key**) OR
a proper-subset superkey via FD closure (the old `isSuperkey` branch). So this
one call subsumes the old `coversLogicalKey || isSuperkey` pair **and** adds
empty-key recognition. Symmetric for `rightKeyCovered`. Guard for
`leftType` / `rightType` possibly `undefined` (the param type allows it) and
fall back to the prior logical-keys-only check in that case.

Source `preservedKeys` from `keysOf(leftRel)` / `keysOf(rightRel)` (right shifted
by `leftColumnCount`) instead of `leftLogicalKeys` / `rightLogicalKeys`, so
FD-derived keys flow through. `keysOf` may include the all-columns fallback when
`isSet`; that is harmless — `superkeyToFd(allCols)` returns `undefined` and
`withKeyFds` skips it.

## Validation expectations

Use ≤1-row sources that **provably** emit a singleton FD today:
- scalar-aggregate subquery (no GROUP BY) — `select count(*) from u` (docs §
  Aggregate emits `∅ → all_out_cols`);
- fully-PK-constant-bound filter — `select * from u where uid = 5` (docs § Filter
  emits singleton when predicate covers a full unique key).

(Note: `LIMIT 1` does **not** emit a singleton FD today — see TODO follow-up
sweep; do not rely on it in tests.)

Expected:
- A join with a provably ≤1-row side preserves the other side's keys — assert a
  key-encoding FD survives on the join physical via `query_plan()` properties
  (reuse `physicalFor` / `hasKeyFd` helpers in `keys-propagation.spec.ts`).
- A join of two ≤1-row sides reports the empty key (singleton `∅ → all` FD) on
  its output.
- DISTINCT / ORDER BY / GROUP BY over such a join collapse as they already do
  for an explicit empty key.
- No regression in `property.spec.ts` "Key Soundness".

## Review reminder (carry forward to the review stage)

The empty key is a recurring blind spot. **During review, do a dedicated sweep
for further empty-key / ≤1-row opportunities beyond the join paths fixed here** —
wherever code branches on `keys.length > 0`, `k.length > 0`, "has a non-empty
key", or reads `RelationType.keys` directly instead of `keysOf` / `isUnique`.
Known candidate already identified: **`LimitNode.computePhysical`
(`limit-offset.ts`) does not emit a singleton FD for `LIMIT 1`** — file a
follow-up. Also sweep cost-model cardinality, predicate pushdown, semi/anti-join
folding, limit/offset reasoning, and subquery decorrelation. File follow-up
tickets (`fix/` or `backlog/`) for anything found; do not expand this ticket.

## TODO

### Phase 1 — logical empty-key coverage (`combineJoinKeys`)

- In `joinPairsCoverKey`, drop the `k.length > 0` guard so an empty key (`[].every(...)` is vacuously true) is recognized as unconditional coverage.
- Fix the `left` / `right` branches of `combineJoinKeys` so they no longer early-return `[]` when `equiPairs` is empty *if* the opposite side carries a logical empty key — i.e. still run the (now empty-key-aware) coverage check with an empty eq-set. The empty key covers regardless of equi-pairs.
- In the `inner` / `cross` (and `left` / `right`) branches, when **both** sides carry a logical empty key, emit `[]` on the output key list so the join's logical type advertises ≤1-row. (Full outer stays `[]` = no keys.)
- Add focused unit coverage in `keys-propagation.spec.ts` exercising `combineJoinKeys` directly with an empty key on one/both sides per join type (the test already imports `combineJoinKeys`).

### Phase 2 — physical coverage + propagation (`analyzeJoinKeyCoverage` / `propagateJoinFds`)

- Build a `KeyRel` per side (`{ getType: () => leftType, physical: leftPhys }`); guard against `leftType` / `rightType` being `undefined` (fall back to the existing logical-keys check).
- Replace `leftKeyCovered` / `rightKeyCovered` with `isUnique(equiPairs.map(p => p.left), leftRel)` / `isUnique(equiPairs.map(p => p.right), rightRel)` — folds the old `coversLogicalKey || isSuperkey` and adds empty-key recognition.
- Source `preservedKeys` from `keysOf(leftRel)` and `keysOf(rightRel)` (right indices shifted by `leftColumnCount`), preserving the existing per-join-type rules (inner/cross: push covered side's keys; left: left keys iff right covered; right: mirror; semi/anti: left keys; full: none). Keep `estimatedRows` capping logic; it fires naturally once `leftKeyCovered`/`rightKeyCovered` include the singleton case.
- When **both** sides are ≤1-row (`isUnique([], leftRel) && isUnique([], rightRel)`) for inner / cross / left / right, push `[]` into `preservedKeys`. `withKeyFds` → `superkeyToFd([], totalCols)` then emits the singleton `∅ → all_cols` FD on the join output. Confirm `withKeyFds` handles the `[]` entry (it should via the existing loop); add an explicit guard/comment if needed. Do **not** add `[]` for full outer.
- No signature change needed for `propagateJoinFds` — it already receives `preservedKeys` and `totalColumnCount`.

### Phase 3 — tests + docs

- Extend `keys-propagation.spec.ts` with the three integration scenarios above (≤1-row side preserves other keys; two ≤1-row sides → singleton on output; DISTINCT/ORDER BY/GROUP BY collapse over such a join). Use scalar-aggregate and PK-constant-bound-filter sources.
- Run `property.spec.ts` "Key Soundness" and confirm green.
- Update `docs/optimizer.md` § Functional Dependency Tracking (the join rows of the per-operator propagation table, ~lines 1278–1282, and the `keysOf`/`isUnique` notes) to document empty-key coverage and ≤1-row propagation through joins, and the logical-vs-physical layering decision above.

### Validation commands

- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log` (Bash) or `Tee-Object` under PowerShell.
- Lint: the quereus package eslint (single-quote globs on Windows).
- Build/typecheck via `yarn build` (or the quereus workspace build) to catch the `KeyRel` / signature changes.
