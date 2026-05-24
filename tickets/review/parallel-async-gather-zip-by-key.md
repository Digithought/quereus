description: Review the `zipByKey` combinator added to `AsyncGatherNode` — full N-way outer join over N uncorrelated branches on shared key columns, implemented as an eager BTree hash-merge. Node properties + runtime emitter + manual-construction path only (no recognition rule — that's the backlog ticket `parallel-async-gather-zip-by-key-rule`).
files: packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/runtime.md
----

## What landed

A third `AsyncGatherCombinator` variant, `{ kind: 'zipByKey', keyAttrs: readonly number[] }`,
alongside the existing `unionAll` / `crossProduct`. `keyAttrs` is a single shared
list of **attribute IDs** (the codebase has no `AttributeId` type — IDs are `number`).
Semantics: full N-way outer join on the key columns. For each distinct key value
present in *any* branch, emit exactly one composed row.

Output layout:
```
[ key cols (K, in keyAttrs order) ] ++ [ branch0 non-key cols ] ++ [ branch1 non-key cols ] ++ …
```

### Node (`async-gather-node.ts`)
- Combinator union + JSDoc extended.
- `ZipByKeyIndices` interface + memoised `computeZipByKeyIndices()` (resolves the shared
  `keyAttrs` against each branch's attribute layout) + public `getZipByKeyIndices()` used
  by the emitter.
- `validateZipByKey`: rejects empty `keyAttrs`; rejects a keyAttr absent from any branch;
  rejects key-column **affinity** disagreement across branches. **Affinity is proxied by
  `logicalType.physicalType`** — the codebase has no distinct affinity field (see review
  question below). Nullability may differ (it's OR'd).
- `buildZipByKeyAttributes` / `getZipByKeyType`: deduped key columns first (from
  children[0], nullability OR'd across branches), then each branch's non-key columns forced
  `nullable: true`. `keys = [[0..K-1]]`, `isSet = false`.
- `computePhysical`: shares the `unionAll` arm — drops fds/equivClasses/constantBindings/
  domainConstraints/ordering/monotonicOn (all `undefined`).
- `estimatedRows`: `max` across children (undefined if any child undefined).
- `getLogicalAttributes`: adds `keyAttrs` when zipByKey.
- `withChildren`: unchanged — already preserves `combinator` verbatim.

### Emitter (`runtime/emit/async-gather.ts`)
- `runZipByKey` (exported) — forks N branches, drives concurrently, upserts each row into a
  `BTree<Row, ZipEntry>` keyed by the key tuple; NULL-keyed rows are buffered separately and
  emitted standalone. After the drive completes, walks the tree in key order (plain
  `first()`/`moveNext()` — tree is no longer mutated, so no `safeIterate` recovery needed),
  composing one output row per entry, then appends the NULL-keyed rows.
- `composeZipRow` helper.
- `emitZipByKey` wiring in `emitAsyncGather`: builds `branchKeyIndices`/`branchNonKeyIndices`
  via `plan.getZipByKeyIndices()` and a `keyComparator` from children[0]'s key-column
  collations (`ctx.resolveCollation`, defaulting `BINARY_COLLATION`).
  `note: async_gather(zipByKey, N=…, cap=…)`.

## Validation status (all green)
- `yarn typecheck` — clean.
- `yarn lint` (packages/quereus) — clean.
- `packages/quereus/test/runtime/async-gather.spec.ts` — 46 passing, 1 pending (strict-fork,
  skipped outside `QUEREUS_FORK_STRICT`). Added 8 node-construction tests + 9 runtime tests.
- Full `yarn test` — 3457 passing, 9 pending, 0 failing.

## Test coverage (the floor, not the ceiling)
Construction: empty keyAttrs rejected; missing keyAttr rejected; affinity mismatch rejected;
output attr layout (key-first, position-independent key resolution, non-key nullable); key
nullability OR; `keys`/`isSet`; physical drops; `withChildren` preserves keyAttrs.
Runtime: full overlap; one-sided NULL pad; 3-branch partial overlap (row-width check); empty
branch; all-empty; NULL-key non-merge (asserted as a set, order-independent); composite K=2
key via collation comparator; cap=3 single-wave and cap=1 serialized timing.

## Deliberate v1 simplifications — please treat as design, not gaps
1. **Affinity check uses `logicalType.physicalType`.** There is no `affinity` field on
   `LogicalType` (it has `physicalType: PhysicalType` and `name`). I picked `physicalType` as
   the closest storage-class proxy. Existing AsyncGather mocks set `physicalType` undefined,
   so they trivially agree. **Reviewer: confirm `physicalType` is the right granularity, or
   whether `name` / a real affinity helper should be used.**
2. **Within-branch duplicate keys are unspecified.** Branches are assumed key-unique; a
   second write for the same key overwrites the first. Branch arrival order is
   non-deterministic, so no order-dependent test exists (by design).
3. **Conditional non-key FDs dropped.** Branch-i FDs hold only when the branch-i row exists
   (non-NULL); v1 asserts only the key (`getType().keys`), dropping all physical FDs. Noted
   as future work in the node JSDoc and `computePhysical` comment.
4. **`estimatedRows = max(children)`** — distinct keys are bounded by
   `max(children) ≤ result ≤ sum(children)`; `max` assumes heavy overlap (the join's normal
   case). May want tuning toward `sum` for low-overlap workloads. Documented inline.
5. **Eager materialization.** Like `crossProduct`, every branch is drained before the first
   row yields. No streaming/sort-merge variant (would require pre-sorted branches).

## Suggested review focus
- Correctness of the NULL-key path: key cells for a NULL-keyed standalone row come from that
  row itself (containing the NULL), not from the tree. Verify the composed width matches the
  merged-row width in all cases.
- The `getType()`/`buildAttributes()` ↔ emitter layout must stay positionally aligned (both
  consume `getZipByKeyIndices()`); a divergence would mis-map columns silently.
- Whether the affinity proxy (#1) is acceptable or should change before the recognition rule
  (`parallel-async-gather-zip-by-key-rule`) starts minting these nodes.
- `BTree` walk correctness: confirm `first()`/`moveNext()` without `safeIterate` is safe here
  (tree is read-only after the drive loop).
