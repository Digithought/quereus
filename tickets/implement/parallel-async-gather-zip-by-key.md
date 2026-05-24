description: Add a `zipByKey` combinator to `AsyncGatherNode` — full N-ary outer join across N uncorrelated child relations on a shared set of key columns, implemented as an eager hash-merge (not a chained binary-join lowering). Combinator + node properties + runtime emitter + manual-construction path only; recognition rule is a separate backlog item.
prereq: parallel-async-gather-node
files: packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/test/runtime/async-gather.spec.ts, packages/quereus/src/util/comparison.ts, packages/quereus/src/runtime/emit/set-operation.ts, packages/quereus/src/runtime/parallel-driver.ts
----

## Summary

Extend `AsyncGatherCombinator` (currently `unionAll | crossProduct`) with a third
variant:

```ts
{ readonly kind: 'zipByKey', readonly keyAttrs: readonly number[] }
```

`keyAttrs` is a list of **attribute IDs** (the codebase has no `AttributeId`
type — attribute IDs are `number`, see `Attribute.id` in
`planner/nodes/plan-node.ts:393`). Semantics: full N-way outer join on the key
columns. For each distinct key value present in *any* branch, emit exactly one
composed row: the key columns once, then each branch's non-key columns (NULL
when that branch has no row for that key).

The implementation is an **eager hash-merge** over a `BTree` keyed by the key
tuple — mirroring `runUnionDistinct` in `runtime/emit/set-operation.ts` and the
`createCollationRowComparator` pattern in `util/comparison.ts:573`. It must NOT
be a chained binary full-outer-join lowering (that assumes two-sided null
padding and produces O(N²) work / worse FD inference).

## Key contract: how `keyAttrs` maps to each branch (resolved design decision)

The ticket's `keyAttrs: readonly number[]` is a **single shared list**, and the
output layout de-duplicates the key columns. This pins the contract:

- The key columns of every branch carry the **same attribute IDs**. That is, the
  manual-construction caller (and the future recognition rule) assigns each
  branch's key column the shared output attribute ID. This is how the join
  condition `a.id = b.id = c.id` surfaces — the equated columns share one output
  attribute.
- At construction, for each branch `i`, build `idToIndex` from
  `children[i].getAttributes()` and resolve `keyAttrs.map(id => idToIndex.get(id))`.
  **Every keyAttr must resolve in every branch** (reject otherwise). The key
  column need not sit at the same *position* in each branch — only carry the same ID.
- Non-key columns are every column whose attribute ID is NOT in the keyAttrs set,
  taken per-branch in declared order. Because branches are uncorrelated, non-key
  attribute IDs are unique across branches (only the key IDs are shared) — so the
  concatenated output has no ID collisions and the attribute-provenance validator
  treats it as forwarding, not duplication (same as the existing crossProduct case;
  see the `validator pass-through` test).

## Output attribute / column layout

```
[ key cols (K, in keyAttrs order) ] ++ [ branch0 non-key cols ] ++ [ branch1 non-key cols ] ++ …
```

- Key attributes: take the `Attribute` from `children[0]` (guaranteed present per
  the contract), in `keyAttrs` order. Nullability = OR across all branches' key
  column nullability (a NULL-keyed row can surface — see below).
- Non-key attributes: per branch in declared order, each forced
  `type.nullable = true` (NULL when the branch is absent for a key). Clone the
  attribute/column with the widened nullability, mirroring the existing
  `unionAll` nullability-OR cloning in `getType()`
  (`async-gather-node.ts:155-163`).
- `buildAttributes()` returns `preserveAttributeIds` verbatim when present (the
  future rule path); otherwise builds the layout above.

## Node properties (`getType` / `computePhysical` / `estimatedRows`)

- **keys**: `[[0, 1, …, K-1]]` — the key columns are the output's unique key.
  Multiple NULL-keyed rows do not violate this (SQL UNIQUE permits multiple
  NULLs).
- **isSet**: `false` (NULL-keyed standalone rows can repeat — see below).
- **computePhysical**: conservative v1 — drop `fds`, `equivClasses`,
  `constantBindings`, `domainConstraints`, `ordering`, `monotonicOn` (return them
  all `undefined`), exactly like the `unionAll` branch. The output's key is
  carried in `getType().keys`, not in physical FDs. Document the conditional-FD
  nuance (branch-i FDs hold only when the branch-i row exists / non-NULL) as
  future work, not implemented here.
- **estimatedRows**: distinct keys across branches is bounded by
  `max(children) ≤ result ≤ sum(children)`. Use `max` across children (heavily
  overlapping keys is the join's normal case); return `undefined` if any child is
  `undefined`. Document the choice in a comment — reviewer may tune.

## Runtime emitter (`runtime/emit/async-gather.ts`)

Add `runZipByKey` alongside `runUnionAll` / `runCrossProduct`, exported for unit
testing, and wire a third branch into `emitAsyncGather`. Signature (carry the
per-branch index metadata + comparator computed at emit time):

```ts
export async function* runZipByKey(
  rctx: RuntimeContext,
  factories: ReadonlyArray<AsyncGatherFactory>,
  branchKeyIndices: readonly (readonly number[])[],     // per branch, key col indices in keyAttrs order
  branchNonKeyIndices: readonly (readonly number[])[],  // per branch, non-key col indices in declared order
  keyComparator: (a: Row, b: Row) => number,            // over the K key cells
  concurrencyCap: number,
  driver?: ParallelDriver,
): AsyncIterable<Row>
```

Algorithm (eager — drain all branches before yielding the first row; document the
memory caveat in JSDoc, same as `runCrossProduct`):

1. `forks = driver.fork(rctx, N)`; iterate `driver.drive(factories, forks, { concurrency })`.
2. For each `{ branch, value }`:
   - Extract `keyRow = branchKeyIndices[branch].map(ix => value[ix])`.
   - **NULL key** (`keyRow.some(v => v === null)`): SQL `NULL = NULL` is unknown,
     so this row never merges. Push `{ branch, value }` onto a `nullKeyed[]` list
     to be emitted standalone at the end. (Do NOT insert into the BTree.)
   - Else upsert into `BTree<Row, ZipEntry>(e => e.key, keyComparator)` where
     `ZipEntry = { key: Row; cells: (Row | undefined)[] /* length N */ }`:
     `const path = tree.find(keyRow); if (path.on) { tree.at(path)!.cells[branch] = value } else { const cells = new Array(N).fill(undefined); cells[branch] = value; tree.insert({ key: keyRow, cells }) }`.
     In-place mutation of the entry's `cells` is the supported pattern (see
     `vtab/memory/index.ts:170` `entry.primaryKeys.delete(...)` after `at(path)`).
   - Within-branch duplicate keys (a branch yields two rows for one key): v1
     assumes branches are key-unique; the second write overwrites the first.
     Behavior under duplicates is **unspecified** (branch arrival order is
     non-deterministic). Document this; do NOT add an order-dependent test.
3. After the drive completes, walk the BTree in key order
   (`tree.first()` + `tree.moveNext` + `tree.at`, see
   `vtab/memory/layer/safe-iterate.ts`). For each entry emit:
   `[ key cells in keyAttrs order ] ++ for each branch b: (cells[b] ? branchNonKeyIndices[b].map(ix => cells[b][ix]) : Array(branchNonKeyIndices[b].length).fill(null))`.
   Key cells come from any present branch (equal by construction) — take them
   from the entry's stored `key`.
4. Emit each `nullKeyed` row standalone: key cells from that row (containing the
   NULL), only its own branch's non-key cols filled, all other branches NULL-padded.

`emitZipByKey` wiring: compute `branchKeyIndices` / `branchNonKeyIndices` from
`plan.children[i].getAttributes()` vs `plan.combinator.keyAttrs`; build
`keyComparator` via `createCollationRowComparator` over the K key columns'
collations (resolve via `ctx.resolveCollation`, defaulting `BINARY_COLLATION` —
same as `emitSetOperation`). `note: async_gather(zipByKey, N=…, cap=…)`.

## Construction validation (`validateConstruction`)

Add a `combinator.kind === 'zipByKey'` arm:

- `keyAttrs.length === 0` → reject (`StatusCode.ERROR`, "zipByKey requires >= 1
  key column"). Degenerate (whole join collapses to Cartesian).
- Every keyAttr must resolve in every child's attribute list → reject with a
  clear message naming the offending branch + attribute ID.
- Key column **types must agree across branches** (compare logical type
  affinity — `getType().columns[ix].type` affinity per key position). Reject
  mismatch, mirroring `SetOperationNode`'s column-count validation style.
  Nullability may differ (it gets OR'd).

`withChildren` already preserves `this.combinator` (which now includes
`keyAttrs`), `concurrencyCap`, and `preserveAttributeIds` — verify the existing
rebuild path covers zipByKey with no change.

## NULL key semantics (lock with a test)

Two NULL-keyed rows from different branches do NOT merge (SQL `NULL = NULL` is
unknown). Each NULL-keyed row emits as its own output row with only its branch's
columns populated. Test: branch A `[[null, 'a1']]` keyed on col 0, branch B
`[[null, 'b1']]` keyed on col 0 → two output rows, not one merged row.

## Out of scope (do not implement here)

- **Recognition rule** — filed as `parallel-async-gather-zip-by-key-rule` in
  `tickets/backlog/`.
- Streaming / sort-merge variant (requires pre-sorted branches).
- Adaptive scheduling.
- Conditional non-key FD propagation (only the key is asserted in v1).

## Key tests (`test/runtime/async-gather.spec.ts`)

Node construction (`describe('node construction')`):
- rejects `zipByKey` with empty `keyAttrs`.
- rejects when a keyAttr is absent from some branch.
- rejects when a key column's affinity disagrees across branches.
- output attributes: key attrs first (in keyAttrs order, from children[0]), then
  each branch's non-key attrs; non-key attrs are nullable.
- `getType().keys` is `[[0..K-1]]`; `isSet` is false.
- `computePhysical` drops fds/equivClasses/constantBindings/domainConstraints/ordering.
- `withChildren` rebuilds preserving the zipByKey combinator (incl. keyAttrs).

Runtime (`describe('zipByKey runtime')`, mirroring the `crossProduct runtime`
block's mock style — build `branchKeyIndices`/`branchNonKeyIndices`/comparator
by hand and call `runZipByKey` directly):
- two branches, full overlap on keys → one row per key with both sides filled.
- key present only in branch A → row with branch B columns NULL (and vice-versa).
- three branches, partial overlap → correct NULL padding per absent branch;
  exactly one row per distinct key; row width = K + Σ non-key arities.
- empty branch → keys from the other branches still emit (NULL-padded for the
  empty one); all-empty → no rows.
- NULL key rows do not merge (the test described above).
- concurrency: 3 × 50ms branches with cap=3 ≈ one wave (<175ms); cap=1 serializes
  (>125ms) — mirror the existing crossProduct timing tests.
- multi-column composite key (K=2) merges correctly via the collation comparator.

## TODO

### Phase 1 — node
- Add `zipByKey` to the `AsyncGatherCombinator` union + JSDoc (note eager
  materialization, like crossProduct).
- `validateConstruction`: keyAttrs non-empty, resolvable in every branch, key
  affinities agree.
- `buildAttributes` / `getType`: key-deduped layout, nullability widening, keys =
  `[[0..K-1]]`, isSet false.
- `computePhysical`: conservative (all relational invariants `undefined`).
- `estimatedRows`: `max` across children (or undefined).
- Add node-construction tests; run them.

### Phase 2 — emitter
- `runZipByKey` (exported) + `emitZipByKey` wiring (index metadata + collation
  comparator) + the third arm in `emitAsyncGather`.
- Add zipByKey runtime tests (overlap, NULL-pad, NULL-key non-merge, composite
  key, concurrency); run them.

### Phase 3 — validate
- `cd packages/quereus`; `yarn test 2>&1 | tee /tmp/zip.log; tail -n 80 /tmp/zip.log`
  (or PowerShell `Tee-Object`). Ensure the async-gather spec and the full suite pass.
- `yarn lint` on `packages/quereus` (single-quote globs on Windows).
- Update `docs/optimizer.md` / `docs/runtime.md` if they enumerate the
  AsyncGather combinators; otherwise no doc change needed.

### Handoff
- Output a `review/` ticket; be explicit about the v1 simplifications (within-branch
  duplicate-key behavior unspecified, conditional non-key FDs dropped, estimatedRows
  heuristic) so the reviewer treats them as deliberate, not gaps.
