description: Make `AsyncGatherNode({ kind: 'zipByKey' })` legal in a validated physical tree by switching the combinator from a single shared-key-attribute-ID list to per-branch key column refs plus K gather-minted output key IDs (Option A). The gather genuinely *originates* the merged key columns (provenance-clean) and *forwards* each branch's non-key IDs, so `validatePhysicalTree` passes. Un-skip the regression test and update docs + the recognition-rule backlog ticket.
prereq:
files: packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/src/planner/analysis/attribute-provenance.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/runtime.md, tickets/backlog/parallel-async-gather-zip-by-key-rule.md
----

## Background

The `zipByKey` combinator (landed in `parallel-async-gather-zip-by-key`) currently
carries `keyAttrs: readonly number[]` — attribute IDs that **every branch's key
column carries verbatim**. `AsyncGatherNode.validateZipByKey` enforces that each
id in `keyAttrs` resolves in *every* branch, and the output forwards the shared
id (output key columns at index `0..K-1`).

This contract is mutually exclusive with the attribute-provenance invariant
(`computeAttributeProvenance`, run by `validatePhysicalTree`): **each attribute id
must be originated by exactly one relational node.** Two independent (uncorrelated)
sibling branches each outputting the shared key id is exactly the "originated at
two distinct nodes" error. The `visited` dedup in the provenance walk only spares
a literal same-node DAG instance, which uncorrelated branches never are. So **no
validly-constructed zipByKey node survives `validatePhysicalTree`**, and the
optimizer validates physical trees — the node is un-plannable as shipped.

The runtime emitter (`runZipByKey`) and merge semantics are correct and fully
tested. This ticket is purely about making the node legal in a validated tree.

## Chosen design — Option A (per-branch key refs + minted output key IDs)

> Decision note: the plan ticket flagged this for human sign-off (it touches the
> just-landed provenance surface). The sign-off question was dismissed without a
> selection, so we proceed with Option A — the plan ticket's stated preferred
> starting point and the only resolution that is provenance-clean *by
> construction* (Option B special-cases one node type inside a general analysis
> and weakens the "originated exactly once" invariant the provenance surface
> just landed to tighten). If a reviewer prefers Option B, the plan ticket's
> "Options to weigh" section documents it; this is a localized swap.

Replace the shared-ID combinator with per-branch key column references plus an
explicit list of gather-minted output key IDs:

```ts
export type AsyncGatherCombinator =
  | { readonly kind: 'unionAll' }
  | { readonly kind: 'crossProduct' }
  | {
      readonly kind: 'zipByKey',
      /** Per branch b, the attribute IDs of that branch's K key columns, in
       *  key-position order. Distinct per branch (provenance-clean — each branch
       *  originates its own key id). length === children.length; every inner
       *  list has the same length K. */
      readonly branchKeyAttrs: readonly (readonly number[])[],
      /** The K output key attribute IDs the gather mints (originates). One per
       *  key position. Disjoint from every child's attribute IDs. Output key
       *  columns sit at index 0..K-1, in this order. */
      readonly outputKeyAttrs: readonly number[],
    };
```

Why this is provenance-clean: the gather **originates** `outputKeyAttrs` (none of
them appears in any child, so the provenance walk records the gather as their sole
origin — it genuinely mints merged columns: "branch0's key, or branch1's key, …,
whichever row is present"). It **forwards** every branch's non-key id (each appears
in exactly one child). No id is output by two branches. `validatePhysicalTree`
passes by construction; **no change to `attribute-provenance.ts` is needed** (it is
listed in `files:` only because it is the surface this reconciles with — read it,
don't edit it).

Key positions are resolved by *attribute id within each branch* (as today), so the
key column may sit at a different index in each branch (the existing
`zipByKey output: key attrs first ... (position-independent)` test must keep
passing under the new representation).

### Stability across `withChildren`

`outputKeyAttrs` lives in the combinator, and `withChildren` already passes
`this.combinator` verbatim — so the minted output key IDs stay stable across a
rebuild for free. Confirm no separate minting happens in `buildAttributes`
(the IDs come from the combinator, not `nextAttrId()` at attribute-build time),
so there is no withChildren-instability hazard. Manual constructors / the
recognition rule mint `outputKeyAttrs` via `PlanNode.nextAttrId()` once, up front.

### Output attribute layout (unchanged shape, new id source)

`buildZipByKeyAttributes` / `getZipByKeyType` keep the same column layout:
K key columns first, then each branch's non-key columns (forced nullable). The
only change is the **key columns now carry `outputKeyAttrs[k]` as their id**
(minted), not a shared child id. Their *type* still derives from branch 0's
key column at position k, with nullability OR'd across branches (a NULL-keyed
standalone row can surface), collation/affinity from the agreed branch columns.
`preserveAttributeIds`, when supplied, still wins verbatim — and in that path the
first K preserved attrs ARE the `outputKeyAttrs` (the recognition rule builds them
consistently; see the backlog ticket revision below).

### Emitter (`runtime/emit/async-gather.ts`)

`getZipByKeyIndices()` resolves `branchKeyAttrs[b]` against branch b's attribute
layout (instead of resolving one shared `keyAttrs` list against every branch).
`branchNonKeyIndices[b]` = indices of branch b's attrs whose id is not in
`branchKeyAttrs[b]`. The runtime contract (`branchKeyIndices` / `branchNonKeyIndices`
arrays into `runZipByKey`) is **unchanged** — only their derivation changes.
Collation derivation in `emitAsyncGather` reads branch 0's key columns via
`branchKeyIndices[0]` (same as today). `runZipByKey` and all its runtime tests are
untouched.

## Validation rules (`validateZipByKey`)

Rewrite to the new representation:

- `branchKeyAttrs.length === children.length` (else INTERNAL).
- Every inner list non-empty and all the same length `K` (else ERROR — was the
  `requires >= 1 key column` check; generalize the message).
- `outputKeyAttrs.length === K` (else ERROR).
- `outputKeyAttrs` are pairwise distinct AND disjoint from every child attribute
  id (else ERROR — a collision would make the provenance walk treat an output key
  id as forwarded, breaking the origination contract). This is the load-bearing
  new check.
- Each `branchKeyAttrs[b][k]` resolves in branch b (else ERROR — keep the
  `not found in branch i` message, now scoped to that branch's own list).
- Per key position k, affinity (physical storage class) agrees across all
  branches (keep the existing affinity-mismatch check, re-pointed at the per-branch
  resolution). Nullability may differ; it is OR'd in `getType`.

## TODO

### Phase 1 — node representation + validation
- Change `AsyncGatherCombinator`'s `zipByKey` variant to
  `{ kind, branchKeyAttrs, outputKeyAttrs }` in `async-gather-node.ts`; update the
  doc comment on the type and on the class to describe origination of the merged
  key columns.
- Rewrite `validateZipByKey` per the rules above (the `outputKeyAttrs`-disjoint
  check is new and load-bearing).
- Rewrite `computeZipByKeyIndices` to resolve per-branch `branchKeyAttrs[b]`.
- Update `buildZipByKeyAttributes` so the K key attrs carry `outputKeyAttrs[k]`
  as their id (type/nullability/affinity still derived from the branches);
  `preserveAttributeIds` path unchanged.
- Update `getZipByKeyType` (column layout identical; key still `[[0..K-1]]`).
- Update `getLogicalAttributes` to surface `branchKeyAttrs`/`outputKeyAttrs`
  instead of `keyAttrs`.
- Confirm `withChildren` needs no change (combinator passed verbatim keeps
  `outputKeyAttrs` stable) — add a test asserting the rebuilt node keeps the
  same `outputKeyAttrs`.

### Phase 2 — emitter
- Update `emitAsyncGather`'s collation derivation and `getZipByKeyIndices` usage
  to the per-branch representation. `runZipByKey` body unchanged.

### Phase 3 — tests (`test/runtime/async-gather.spec.ts`)
- Update the construction unit tests to build **provenance-legal** branches:
  distinct per-branch key attribute IDs (no shared `Attribute` object across
  branches), with explicit `outputKeyAttrs` minted distinct from all branch ids.
  Affected tests: `zipByKey rejects empty keyAttrs`,
  `zipByKey rejects a keyAttr absent from some branch`,
  `zipByKey rejects key column affinity disagreement across branches`,
  `zipByKey output: key attrs first ...`, `zipByKey key nullability is OR ...`,
  `zipByKey getType keys are [[0..K-1]] ...`,
  `zipByKey drops fds/... in physical`,
  `zipByKey withChildren rebuilds preserving the combinator ...`.
- Add a test for the new `outputKeyAttrs`-collides-with-a-branch-id rejection.
- **Un-skip** `zipByKey passes full validation` (currently
  `it.skip('zipByKey passes full validation (BLOCKED: ...)')`, ~line 388).
  Rebuild it with distinct branch key ids + minted `outputKeyAttrs`, assert
  `expect(() => validatePhysicalTree(node)).to.not.throw()`. Drop the
  KNOWN-LIMITATION comment block above it.
- Expected outputs: every construction test asserts the same column layout /
  keys / nullability as before; the key column ids are now the minted
  `outputKeyAttrs`, so id-equality assertions move from "shared k.id" to
  "outputKeyAttrs[k]".

### Phase 4 — docs + downstream ticket
- `docs/runtime.md` § AsyncGatherNode (the `zipByKey({ keyAttrs })` bullet,
  ~line 1117): rewrite the key-representation description from "a list of
  attribute IDs that every branch's key column carries verbatim; the equated
  columns share one output attribute" to the per-branch-refs + gather-minted
  output key model. State explicitly that the gather *originates* the K key
  columns (provenance-clean) and forwards non-key ids.
- `tickets/backlog/parallel-async-gather-zip-by-key-rule.md` "What it produces":
  replace the "whatever the prereq settles on / most likely per-branch refs"
  hedge with the concrete Option A signature
  (`{ kind: 'zipByKey', branchKeyAttrs, outputKeyAttrs }`), and note the rule
  mints `outputKeyAttrs` to match the coalesced key columns the recognized
  Project surfaces (so `preserveAttributeIds[0..K-1] === outputKeyAttrs`).

### Phase 5 — validate
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/zip.log; tail -n 60 /tmp/zip.log`
  (focus: `test/runtime/async-gather.spec.ts`).
- `yarn workspace @quereus/quereus build` (type-check the combinator shape change
  reaches the emitter cleanly).
- Lint the two touched src files (single-quote globs on Windows).

## Acceptance

- A zipByKey node built the way the recognition rule would build it (distinct
  per-branch key ids + minted `outputKeyAttrs`) passes `validatePhysicalTree`.
- The regression test `zipByKey passes full validation` is un-skipped and asserts
  no-throw.
- Construction unit tests build provenance-legal branches under the new
  representation (no shared `Attribute` across branches).
- `docs/runtime.md` § AsyncGatherNode describes the chosen key representation.
- `tickets/backlog/parallel-async-gather-zip-by-key-rule.md` "What it produces"
  matches Option A.
- `attribute-provenance.ts` is **not** modified.
