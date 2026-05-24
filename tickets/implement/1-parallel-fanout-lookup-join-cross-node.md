description: Add a `cross` per-branch mode to FanOutLookupJoinNode + emitter — a cross branch contributes the full Cartesian product per outer row (1:n lookups), matching the nested-loop chain it replaces, while keeping the concurrent fan-out drive. Node + runtime only; recognition is the sibling `parallel-fanout-lookup-join-cross-rule` ticket.
files: packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts
----

## Goal

Extend `FanOutBranchMode` from `'atMostOne-left' | 'atMostOne-inner'` to also include
`'cross'`. A `cross` branch yields **n rows** per outer row (data-driven cardinality) and the
node emits one wide row per `(outer, b0_row, b1_row, …)` tuple — the n-ary Cartesian product,
identical to the chain of inner nested-loop joins it replaces. This ticket is the node + emitter;
no rule constructs a `cross` node yet (that lands in `parallel-fanout-lookup-join-cross-rule`),
so existing plans stay byte-for-byte unchanged.

## Replay design — read this before touching the emitter

The Cartesian product re-traverses all-but-the-outermost branch, and branch streams are
single-pass `AsyncIterable<Row>`. There are two granularities of replay; keep them distinct:

- **Across outer rows** — each new outer row re-executes every branch factory fresh
  (`emitCallFromPlan` → `(ctx) => AsyncIterable<Row>`). This is the foundational, O(1)-memory
  reset that the nested-loop join already relies on (`runtime/emit/join.ts:39,67`). Cross
  branches are **correlated** (parameterized on the outer row), so this is the only correct
  cross-outer-row mechanism — and exactly why the materialization advisory's Rule 3
  (`planner/cache/materialization-advisory.ts:99`) must never cache them.

- **Within one outer row** — the product re-reads each branch's rows many times against a
  *fixed* outer binding. Those rows must be materialized once per outer row.

**Decision (v1): materialize per outer row inside the driver's existing per-branch collection,
not via a composed CacheNode.** The serial driver already collects every branch row into
`branchBuf[i]` and *then* asserts ≤1 for at-most-one branches
(`runtime/emit/fanout-lookup-join.ts:167-181`). For `cross` we drop the ≤1 assertion on those
branches and compute the product over the collected rows. The materialization is transient —
discarded at the end of each outer row — so it is correct for correlated branches and bounded
by the recognition-time row/product guards in the sibling rule ticket (memory safety lives at
recognition, never runtime spill, which stays out of scope).

This deviates from the plan ticket's "delegate replay to a composed CacheNode, hold no buffer"
framing. The reason: `CacheNode`'s state is emit-scoped and **persists across factory
invocations** (`runtime/emit/cache.ts:33` — `cacheState` created once, outside `run`), so a
`CacheNode` wrapping a correlated cross branch would serve the *previous* outer row's rows on
the next outer row. Literal CacheNode delegation would require a per-outer-row cache-reset hook
that does not exist today; that is a clean future refinement (note it in the review handoff),
not a correctness prerequisite. The concurrent fan-out *drive* — the actual win of this node — is
fully preserved: cross branches depend only on the outer row, never on each other, so all N are
still forked and driven concurrently via `ParallelDriver` exactly as at-most-one branches are;
only the post-drive composition differs.

## Node changes (`fanout-lookup-join-node.ts`)

- Add `'cross'` to the `FanOutBranchMode` union; update the doc comment (drop the "deferred"
  language for `cross`, keep `array` removed/out-of-scope).
- `buildAttributes` / `getType`: a `cross` branch is **inner** (empty branch ⇒ row dropped), so
  its output columns are **not** nullable-widened — only `atMostOne-left` widens. Branch the
  nullability decision on `mode === 'atMostOne-left'` (the existing test already does this; just
  make sure `cross` falls into the non-widening path).
- `computePhysical`: fold a `cross` branch with `joinType = 'inner'` through `propagateJoinFds`
  (same as `atMostOne-inner`) — this yields the product-of-per-branch-FDs the plan ticket
  specifies.
- **`estimatedRows`**: today it returns `this.outer.estimatedRows`. A `cross` branch multiplies
  cardinality. Update both the `estimatedRows` getter and `computePhysical`'s `estimatedRows`
  output to multiply the outer estimate by each `cross` branch's `child.estimatedRows`
  (at-most-one branches keep their ×1 factor). Guard against `undefined` child estimates (fall
  back to leaving the outer estimate unmultiplied for that branch, or `defaultRowEstimate`).
- `validateConstruction`: `'cross'` is a valid mode with no extra constraints. A node may freely
  mix `cross` and `atMostOne-*` branches.
- `toString` / `getLogicalAttributes`: `mode` already flows through; no special-casing needed.

## Emitter changes (`fanout-lookup-join.ts`)

- Replace the single-row `composeOuterRow` (`Row | typeof DROP`) with an n-ary product
  composer, e.g. `composeOuterRows(outerRow, branchBuf, branchDescriptors, padLengths): Row[]`:
  - For each branch produce its **factor list** of column-slices:
    - `cross`: one factor entry per buffered row (the row's columns). Empty buffer ⇒ **inner-drop**:
      the whole product is empty ⇒ return `[]` (no rows for this outer). (Locks the plan ticket's
      open question to inner-drop — the replaced inner nested-loop chain behaves this way.)
    - `atMostOne-inner`: empty ⇒ return `[]` (drop, unchanged semantics).
    - `atMostOne-left`: empty ⇒ single NULL-pad factor (the existing pad behavior); else the one row.
  - Emit the Cartesian product of the factor lists, left-to-right (outer cols first, then branch 0,
    branch 1, …), so output column order is identical to the at-most-one layout and to the replaced
    join chain. Keep the product allocation-lean (iterative index odometer over factor arrays).
- Serial `runFanOutLookupJoin`: keep collecting all rows into `branchBuf`. Apply the ≤1 invariant
  check **only to `atMostOne-*` branches** (a `cross` branch legitimately has >1). Then
  `for (const row of composeOuterRows(...)) yield row;`.
- Batched `runFanOutLookupJoinBatched`: the reorder buffer currently maps `seq -> Row | DROP`.
  Change it to `seq -> Row[]` (empty array == the old DROP). The in-order emit loop yields every
  row for `emitFrontier` in order before advancing. Per-branch ≤1 assertion in `runBranch` must be
  scoped to `atMostOne-*` branches only (pass the descriptor's mode, or move the check into the
  compose step). Confirm window/backpressure accounting still advances per `seq`, not per emitted
  row (read-ahead bounds outer rows admitted, independent of product fan-out).
- Update the `DROP` symbol usage / doc comments accordingly. If `DROP` is no longer needed once
  the buffer holds `Row[]`, remove it; otherwise keep it as the empty-product sentinel — pick
  whichever keeps both drivers consistent.
- `emitFanOutLookupJoin`: no structural change beyond plumbing the new composer; update the
  `v1 supports only atMostOne…` doc comment.

## TODO

- [ ] Add `'cross'` to `FanOutBranchMode`; update node doc comments.
- [ ] Non-widening attributes/type for `cross`; inner FD fold; product `estimatedRows`.
- [ ] Implement `composeOuterRows` (n-ary product, inner-drop on empty cross/inner factor).
- [ ] Serial driver: scope ≤1 assertion to at-most-one; yield product rows.
- [ ] Batched driver: reorder buffer `Row[]`; emit all rows per seq in order; scoped assertion.
- [ ] Runtime tests (`test/runtime/fanout-lookup-join.spec.ts`), driving the runners directly
      (the file already constructs branch factories + descriptors without a full plan):
  - single `cross` branch, 3 rows → 3 output rows per outer, correct columns.
  - two `cross` branches 3×2 → 6 rows per outer, product order = outer, b0, b1.
  - empty `cross` branch → outer row dropped (locks inner-drop semantics).
  - mixed node: one `atMostOne-left` (with a miss → NULL pad) + one `cross` → pad × product.
  - `atMostOne-*` branch yielding >1 row still throws `QuereusError(CONSTRAINT)`; a `cross`
    branch yielding >1 does **not**.
  - batched mode: same multiset as serial **and** emitted in outer order; a single outer row
    expanding to k>1 rows emits all k contiguously before the next seq.
  - concurrency preserved: reuse the existing concurrent-drive assertion for a multi-`cross` node.
- [ ] `yarn workspace @quereus/quereus run build` + `… test` green; lint clean.
