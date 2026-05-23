description: Extend `AsyncGatherNode`'s combinator union with `zipByKey(keys)` — full N-ary outer join across N uncorrelated child relations on a shared set of key columns. Generalizes binary `FULL OUTER JOIN` to N inputs; needs a hash-merge implementation distinct from the existing binary-join code paths.
prereq: parallel-async-gather-node
files: packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/src/planner/rules/parallel/, packages/quereus/test/runtime/async-gather.spec.ts
----

## Scope

A third combinator for `AsyncGatherNode`:

```ts
{ readonly kind: 'zipByKey', readonly keyAttrs: readonly AttributeId[] }
```

Semantics: full N-way outer join on `keyAttrs`. Per key value present in *any* child, emit one composed row containing each child's columns (NULL when that child has no row for this key). Use cases:

- `users FULL OUTER JOIN orders FULL OUTER JOIN reviews ON user_id` — awkward as a left-deep tree of binary full-outer joins, natural as one N-ary zip.
- Any "side-by-side" combination of remote sources keyed on a shared ID, with no implicit ordering across the inputs.

The combinator is the natural N-ary generalization of the binary `JoinNode(joinType='full')` path, but the implementation must be a hash-merge — not a chained binary-join lowering — because binary full-outer-join code paths assume two-sided null padding, and chaining them produces O(N²) work and worse FD inference.

## Architecture sketch

### Combinator semantics

For input rows `(R_1, R_2, …, R_N)` with each child producing keyed rows on `keyAttrs`:

1. Drive all N children concurrently via `ParallelDriver.drive` (same primitive `unionAll`/`crossProduct` use).
2. As rows arrive, partition by `keyAttrs` value: maintain `Map<KeyTuple, Row[N]>` (each cell starts undefined; filled as rows arrive for that branch).
3. When all branches close, walk the map and emit one row per key: `[key columns] ++ [R_1 non-key cols or nulls] ++ [R_2 non-key cols or nulls] ++ …`.

**Eager materialization.** Like `crossProduct`, `zipByKey` cannot stream — it must see every branch's full row set before deciding which keys never matched. Document the memory caveat in the JSDoc.

### Output attribute layout

- Key columns first (computed once, since all children must agree on the key column types — validate at construction).
- Then per-branch non-key columns in declared order.

This differs from `crossProduct`'s "concatenate every branch's attributes verbatim" — the key columns are de-duplicated.

### FD / key propagation

- The output's key is `keyAttrs` (every emitted row is unique on `keyAttrs` by construction — the hash-merge ensures one row per key value).
- Non-key columns from branch `i` are determined by `keyAttrs` *within branch i*: if branch i's `keyAttrs → other_i_cols` FD held, the corresponding FD on the output holds *conditionally on the branch-i row existing* (else the columns are NULL).
- Document the conditional-FD nuance; the conservative version is to drop FDs on non-key columns and only assert the key as the output's unique key.

### Recognition rule (separate, future)

`zipByKey` recognition would target a `Project` rooted over a chain of `JoinNode(joinType='full')` joins sharing a common key column set. Out of scope for this ticket — the implement-stage focus here is the combinator + runtime + manual-construction path.

## Out of scope

- The recognition rule. File as `parallel-async-gather-zip-by-key-rule` once this lands and the manual-construction case has been exercised.
- Streaming variants (sort-merge zipByKey requiring all branches pre-sorted by key). The implementation is more involved and the memory win matters only at large branch sizes.
- Adaptive scheduling (issue slowest branch first) — same scope cut as `unionAll`'s v1.
- Multi-column composite keys with affinity coercion — v1 should support multi-column keys via the existing row-key comparator (`BTree<Row, …>` with `createCollationRowComparator`, mirroring `set-operation.ts`'s `runUnionDistinct`).

## Open questions

- **Key column count of zero.** Degenerate (the whole join becomes Cartesian + collapse). Reject at construction.
- **Key columns whose types disagree across branches.** Reject at construction with a clear error, mirroring `SetOperationNode`'s column-count validation.
- **NULL key values.** SQL standard: `NULL = NULL` is unknown, so two NULL-keyed rows from different branches do not merge. Document this and lock with a test.
- **Output ordering.** No ordering claim. Callers wrap in `Sort` when they need one (mirrors `unionAll`).

## End
