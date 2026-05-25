description: Review the Option-A rework of `AsyncGatherNode`'s `zipByKey` combinator — shared-key-id list replaced by per-branch key refs (`branchKeyAttrs`) plus gather-minted output key ids (`outputKeyAttrs`). The change makes a zipByKey node provenance-clean by construction so it passes `validatePhysicalTree`; the previously-skipped regression test is un-skipped and asserts no-throw.
prereq:
files: packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/src/planner/analysis/attribute-provenance.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/runtime.md, tickets/backlog/parallel-async-gather-zip-by-key-rule.md
----

## What changed (and why)

The `zipByKey` combinator previously carried `keyAttrs: readonly number[]` — a
single list of attribute IDs that **every branch's key column carried verbatim**.
That contract is mutually exclusive with the attribute-provenance invariant
(`computeAttributeProvenance`, run by `validatePhysicalTree`): two uncorrelated
sibling branches both outputting the shared key id = "originated at two distinct
nodes" → validation throws. So no validly-constructed zipByKey node survived
`validatePhysicalTree`, and the optimizer validates physical trees — the node was
un-plannable as shipped.

**Option A** (the design the plan ticket preferred and the only provenance-clean-
by-construction resolution) replaces the shared list with:

```ts
{ kind: 'zipByKey',
  branchKeyAttrs: readonly (readonly number[])[],  // per branch b: branch b's K key ids, key-order; distinct per branch
  outputKeyAttrs: readonly number[],               // K gather-minted ids for the merged key columns
}
```

The gather **originates** `outputKeyAttrs` (they appear in no child — it genuinely
mints "branch0's key, or branch1's key, …, whichever row is present") and
**forwards** each branch's non-key id (each in exactly one child). No id is output
by two branches → `validatePhysicalTree` passes by construction. **`attribute-
provenance.ts` was NOT modified** (it is listed only because it is the surface this
reconciles with — confirm it stays untouched in the diff).

### Files touched

- `async-gather-node.ts` —
  - combinator type + doc comments rewritten (origination of merged key columns).
  - `validateZipByKey` rewritten to per-branch refs. **New load-bearing check:**
    `outputKeyAttrs` must be pairwise-distinct AND disjoint from every child id
    (else the provenance walk would treat an output key id as forwarded). Also:
    `branchKeyAttrs.length === children.length` (INTERNAL), all inner lists same
    non-empty length K, `outputKeyAttrs.length === K`, each branch key ref resolves
    in its own branch, per-position affinity agreement across branches.
  - `computeZipByKeyIndices` resolves `branchKeyAttrs[b]` against branch b (not one
    shared list against all branches). The runtime contract (`branchKeyIndices` /
    `branchNonKeyIndices` into `runZipByKey`) is **unchanged** — only its derivation.
  - `buildZipByKeyAttributes` / `getZipByKeyType`: identical column layout (K key
    cols first, then each branch's non-key cols forced nullable; key type/nullability
    from branch 0 with OR'd nullability), but the K key attrs now carry
    `outputKeyAttrs[k]` as their id (minted) instead of a shared child id.
  - `getLogicalAttributes` surfaces `branchKeyAttrs` + `outputKeyAttrs`.
  - `withChildren` unchanged — passes `this.combinator` verbatim, so the minted
    `outputKeyAttrs` stay stable across rebuild (no minting in `buildAttributes`).
- `runtime/emit/async-gather.ts` — collation derivation in `emitAsyncGather` now
  reads branch-0 key columns via `branchKeyIndices[0]` directly (no `keyAttrs`).
  `runZipByKey` body and all its runtime tests untouched.
- `docs/runtime.md` § AsyncGatherNode — zipByKey bullet rewritten to the per-branch-
  refs + minted-output model, with the explicit provenance statement.
- `tickets/backlog/parallel-async-gather-zip-by-key-rule.md` — `description:` header
  updated to the Option-A signature (the body already described Option A from the
  plan stage).

## Use cases / validation focus for the reviewer

- **Provenance acceptance (the headline):** a zipByKey node built the way the
  recognition rule will build it (distinct per-branch key ids + minted
  `outputKeyAttrs` disjoint from all branch ids) passes `validatePhysicalTree`.
  Covered by the un-skipped test `zipByKey passes full validation (per-branch key
  refs + minted output key)`.
- **The new disjointness check is the load-bearing safety rail.** Covered by
  `zipByKey rejects an output key id that collides with a child attribute id`.
  Worth a close read: this is what prevents a future caller (or the recognition
  rule) from re-using a branch id as an output key and silently breaking the
  origination contract. Also confirm pairwise-distinctness of `outputKeyAttrs` is
  enforced (it is, in `validateZipByKey`, but there is **no dedicated unit test**
  for the duplicate-within-`outputKeyAttrs` case — see gaps below).
- **Position-independence:** key column may sit at a different index in each branch
  (`zipByKey output: ...` builds branch A key at index 0, branch B key at index 1).
- **Output id identity moved:** key-column id-equality assertions now check the
  minted `outputKeyAttrs[k]`, not a shared child id. Column layout / keys /
  nullability assertions are unchanged from before.
- **withChildren stability:** rebuilt node keeps the same `outputKeyAttrs`.

## Known gaps / things to scrutinize

- **No dedicated test for `outputKeyAttrs` containing a duplicate id** (e.g.
  `outputKeyAttrs: [x, x]` for K=2). The validation path exists (`seenOutput` set in
  `validateZipByKey`) but is only exercised transitively. A reviewer adding a one-
  line test here would close the gap; it is a minor inline fix, not a major finding.
- **No test for `branchKeyAttrs.length !== children.length`** (the INTERNAL guard)
  nor for `branchKeyAttrs` inner-list length mismatch across branches (the
  per-branch-K ERROR). Both code paths exist; neither has a direct unit test.
- **No end-to-end / SQL-level test** of a validated zipByKey plan executing — there
  is still **no rule that constructs one** (that is the backlog ticket
  `parallel-async-gather-zip-by-key-rule`). All coverage here is node-construction +
  validator + runtime-emitter units. The provenance fix is verified structurally
  (validatePhysicalTree no-throw) but not via an executed query plan. This is
  expected for this ticket's scope, but it means the *integration* of minted key ids
  with downstream attribute resolution is unproven until the rule lands.
- The collation comparator still derives solely from **branch 0**'s key columns
  (`branchKeyIndices[0]`), unchanged from before. With distinct per-branch key ids,
  branches could in principle declare different collations on the same key position;
  construction only checks *affinity* agreement, not *collation* agreement. Branch 0
  wins silently. Pre-existing behavior, but now slightly more visible since key ids
  are no longer shared — flag if the reviewer thinks collation should be validated.

## Verification performed

- `yarn workspace @quereus/quereus build` — EXIT 0.
- AsyncGather suite (`--grep AsyncGather`): 67 passing, 1 pending (the
  `QUEREUS_FORK_STRICT`-gated strict-fork test, skipped in the default run).
- Full quereus suite: **3519 passing, 9 pending, EXIT 0** (no regressions).
- eslint on both touched src files — EXIT 0, clean.
- Confirmed no remaining `.keyAttrs` / `keyAttrs:` references in
  `packages/quereus/src`.

## Acceptance (all met)

- ✅ zipByKey node built rule-style passes `validatePhysicalTree`.
- ✅ `zipByKey passes full validation` un-skipped, asserts no-throw.
- ✅ Construction unit tests build provenance-legal branches (distinct per-branch
  key attrs, no shared `Attribute` object across branches, minted `outputKeyAttrs`).
- ✅ New `outputKeyAttrs`-collides-with-branch-id rejection test added.
- ✅ `docs/runtime.md` § AsyncGatherNode describes the per-branch + minted model.
- ✅ backlog ticket "What it produces" matches Option A (header also updated).
- ✅ `attribute-provenance.ts` not modified.
