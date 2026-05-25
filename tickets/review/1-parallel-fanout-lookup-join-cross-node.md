description: Review the `cross` per-branch mode added to FanOutLookupJoinNode + emitter — a cross branch contributes the full Cartesian product per outer row (1:n lookups) while preserving the concurrent fan-out drive. Node + runtime only; no rule constructs a cross node yet (sibling `parallel-fanout-lookup-join-cross-rule`).
prereq:
files: packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts
----

## What landed

Added `'cross'` to `FanOutBranchMode`. A `cross` branch yields *n* rows per outer
row and the node emits the n-ary Cartesian product `(outer, b0_row, b1_row, …)` —
identical column and row order to the inner nested-loop join chain it replaces.
Existing plans are unchanged: no rule constructs a `cross` node yet (recognition is
the sibling ticket), so all current plans stay byte-for-byte identical.

### Node (`fanout-lookup-join-node.ts`)
- `'cross'` added to the `FanOutBranchMode` union; doc comments updated (dropped the
  "deferred" language for `cross`; `array` remains out-of-scope).
- Nullability: `buildAttributes` / `getType` already branch on `mode === 'atMostOne-left'`,
  so `cross` (inner semantics) falls into the **non-widening** path — verified by test.
- FD fold: `computePhysical`'s `joinType = mode === 'atMostOne-left' ? 'left' : 'inner'`
  already routes `cross` through the `'inner'` `propagateJoinFds` path (still empty
  equi-pair lists — the conservative v1 behavior, unchanged).
- `estimatedRows`: new private `computeEstimatedRows()` multiplies the outer estimate
  by each `cross` branch's `child.estimatedRows` (at-most-one branches stay ×1). A
  `cross` child with no estimate falls back to ×1 for that branch; `undefined` outer
  estimate ⇒ `undefined` overall. Both the getter and `computePhysical` use it.
- `validateConstruction`: no new constraints — `cross` may freely mix with `atMostOne-*`.

### Emitter (`fanout-lookup-join.ts`)
- Removed the single-row `composeOuterRow` + `DROP` sentinel. Replaced with
  `composeOuterRows(...) : Row[]` — builds a per-branch factor list and emits the
  Cartesian product via an iterative index odometer (right-most branch varies
  fastest → outer-most branch is the outer loop, matching nested-loop order).
  - `cross` empty buffer ⇒ inner-drop (returns `[]`). **Locks the plan ticket's open
    question to inner-drop semantics.**
  - `atMostOne-inner` empty ⇒ drop; `atMostOne-left` empty ⇒ single NULL-pad factor.
- New `assertAtMostOne(branchBuf, descriptors)` helper enforces the ≤1 invariant
  **scoped to `atMostOne-*` branches only** (`cross` is exempt). Used by both drivers.
- Serial driver: collects all rows, asserts (scoped), yields each product row.
- Batched driver: reorder buffer changed from `seq -> Row | DROP` to `seq -> Row[]`
  (empty array == old DROP). `runBranch` no longer asserts ≤1 (moved to `runRow` via
  `assertAtMostOne`, scoped). In-order emit yields every product row for `emitFrontier`
  contiguously before advancing. **Window/backpressure accounting still advances per
  `seq`, independent of product fan-out** — confirmed in code and by test.

## Replay / memory model (read before judging correctness)
- **Across outer rows:** each outer row re-executes every branch factory fresh — the
  correct, O(1)-memory mechanism for *correlated* cross branches.
- **Within one outer row:** the product re-reads each branch's rows many times. These
  are materialized once per outer row inside the driver's existing `branchBuf[i]`
  collection (transient — discarded at end of each outer row). This is the deliberate
  v1 decision and **deviates from the plan ticket's "delegate replay to a composed
  CacheNode" framing**: `CacheNode` state is emit-scoped and persists across factory
  invocations (`runtime/emit/cache.ts:33`), so wrapping a correlated cross branch would
  serve the *previous* outer row's rows. A per-outer-row cache-reset hook does not
  exist today; that is a clean future refinement, not a correctness prerequisite.
- Memory safety lives at **recognition** (row/product guards in the sibling rule
  ticket), never runtime spill — out of scope here.
- The concurrent fan-out *drive* is fully preserved: cross branches depend only on the
  outer row, never on each other, so all N are still forked and driven concurrently.

## Validation / use cases (tests in `test/runtime/fanout-lookup-join.spec.ts`)
Serial driver, driving `runFanOutLookupJoin` directly:
- single `cross` (3 rows) → 3 rows per outer; columns correct.
- two `cross` 3×2 → 6 rows, product order = outer, b0 (outer loop), b1 (inner loop).
- empty `cross` → outer row dropped (inner-drop).
- mixed: missed `atMostOne-left` (NULL pad) × `cross` (2) → 2 NULL-padded product rows.
- `cross` yielding >1 row does **not** throw (the `atMostOne` >1 throw test still holds).
- multi-`cross` node drives branches concurrently within the cap (wall-clock band).

Batched driver, driving `runFanOutLookupJoinBatched` directly:
- cross product per outer row, in outer order (reverse-completion staggering).
- two-branch cross multiset equals the serial output exactly.
- empty cross branch drops outer rows.
- one outer expanding to k=3 rows emits all 3 contiguously before the next seq
  (slowest-row-first staggering forces out-of-order completion).

Node-level (`FanOutLookupJoinNode`):
- `cross` outputs are not nullable-widened.
- `estimatedRows` = outer × product of cross fan-outs; at-most-one stays ×1.
- cross child with no estimate ⇒ ×1; undefined outer ⇒ undefined.

`MockRelNode` gained an optional `estimatedRows` constructor field to exercise the
node's estimate.

## Build / test status
- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — 3509 passing, 10 pending (the 2
  strict-fork cases require `QUEREUS_FORK_STRICT=1`; unrelated to this change).
- `test:store` not run (no store-specific code path touched).

## Known gaps / things to probe
- **No `cross` node is constructed anywhere yet** — only direct unit coverage. End-to-end
  SQL behavior arrives with `parallel-fanout-lookup-join-cross-rule`. The reviewer
  cannot exercise this through a query plan today.
- **Per-outer-row CacheNode-reset refinement** is deferred (see replay model above).
  If a reviewer wants the literal "hold no buffer" composition, that needs a new
  emit-scoped reset hook — file a follow-up rather than blocking.
- **FD precision unchanged**: cross branches fold through `propagateJoinFds` with empty
  equi-pair lists, same conservative v1 behavior as at-most-one branches.
- **No runtime product-size guard**: a large product (e.g. cross child with many rows ×
  many outer rows) materializes per outer row with no spill. By design — memory safety
  is a recognition-time concern. Worth confirming the sibling rule ticket's guards are
  sufficient before any rule emits `cross`.
- Odometer composer allocates a fresh `Row` per product row (`[...outerRow]` + pushes).
  Fine for bounded products; not optimized for very wide fan-outs.
