description: Review the `cross-left` FanOutLookupJoin branch mode — a LEFT 1:n (not-at-most-one) equi-lookup chain now folds into the fan-out (outer-preserving NULL-pad) instead of bailing to a nested-loop left join.
files: packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/src/planner/rules/join/rule-fanout-batched-outer.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/test/optimizer/parallel-fanout.spec.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts, docs/optimizer.md, docs/runtime.md
----

## What landed

A new `FanOutBranchMode` value `'cross-left'` lets a **LEFT** 1:n equi-lookup
chain (non-preserved side is a parameterized equi-lookup that is *not* provably
at-most-one — no FK, or FK→non-unique) fold into a single `FanOutLookupJoinNode`
instead of bailing back to a nested-loop left join. Previously `recognizeBranch`
returned `null` for `joinType === 'left'` on the cross path.

`cross-left` semantics vs the existing `cross`:
- **Match present:** identical 1:n Cartesian product (one wide row per
  `(outer, branch-row)`).
- **Empty branch:** instead of inner-drop, emits one NULL-padded factor row, so
  the outer row is preserved (LEFT semantics).
- **Output attributes:** nullable-widened, like `atMostOne-left`.

### Centralized predicates (DRY)

Two exported helpers on `fanout-lookup-join-node.ts` replace the scattered
mode-literal checks and are the single source of truth:
- `isLeftBranchMode(mode)` → `atMostOne-left | cross-left` (outer-preserving ⇒
  nullable-widen + NULL-pad on empty).
- `isCrossBranchMode(mode)` → `cross | cross-left` (1:n Cartesian factor ⇒
  memory-guarded + cardinality-multiplied).

These are threaded through:
- **`recognizeBranch`** (`rule-fanout-lookup-join.ts`): `joinType === 'left'` on
  the cross path now returns `mode: 'cross-left'`.
- **`crossGuardsPass` filter**: `cross-left` lookups are gated by
  `maxCrossBranchRows` / `maxCrossProduct` identically to `cross`.
- **`preserveAttrs` widening** (rule): `isLeftBranchMode(spec.mode)` widens the
  branch's output attrs to nullable in the wide-row layout.
- **`FanOutLookupJoinNode`**: `buildAttributes`, `getType`, `computePhysical`
  (FD join-type = `left`), and `computeEstimatedRows` (1:n factor).
- **emit `composeOuterRows`**: empty-buffer ⇒ NULL-pad factor row when
  `isLeftBranchMode`, else inner-drop.
- **`rule-fanout-batched-outer.ts`**: `cross-left` excluded from batched outer
  mode on the same grounds as `cross` (both are 1:n; batched-cross is owned by
  the cross-mode ticket).

## How to validate

Build + full suite + lint all pass at handoff:
- `yarn workspace @quereus/quereus run build` → clean.
- `yarn workspace @quereus/quereus run test` → 3575 passing, 9 pending, 0 fail.
- ESLint on the four changed source files → clean.

Targeted run: `yarn workspace @quereus/quereus run test --grep "FanOutLookupJoin|ruleFanOutLookupJoin" --reporter spec`.

### Tests added

**Optimizer** (`test/optimizer/parallel-fanout.spec.ts`, new
`cross-left (LEFT 1:n) lookup branches` describe):
- Clusters a 2-branch LEFT 1:n chain into `['cross-left', 'cross-left']`, joins → 0.
- Inert on local-only (memory) chains (`expectedLatencyMs = 0` cost gate).
- Execution equivalence vs the rule-disabled nested-loop baseline, **including
  empty-match rows**: `p=3` (both branches empty) → `{id:3, v:null, w:null}`;
  `p=4` (one branch empty) → `{id:4, v:400, w:null}`.
- Memory-guard trips for both `maxCrossProduct` and `maxCrossBranchRows`.
- Mixed chain `atMostOne-left + cross + cross-left` → single fan-out, modes in
  declared order, plus an execution-equivalence run that exercises the
  cross-left NULL-pad alongside a `cross` product and an FK→PK at-most-one branch.

**Runtime** (`test/runtime/fanout-lookup-join.spec.ts`, new `cross-left mode`
describe): direct `composeOuterRows`/`runFanOutLookupJoin` coverage — non-empty
product, empty-branch NULL-pad + outer preservation, NULL-pad width = branch
`outputColCount`, mixed `cross × cross-left`, and the regression that an empty
**inner** `cross` sibling still drops the outer row even with a `cross-left`
present.

## Known gaps / reviewer attention points

- **Cardinality estimate is an upper-leaning approximation.**
  `computeEstimatedRows` multiplies the `cross-left` child estimate as a factor
  exactly like `cross`. For a LEFT branch the true minimum is 1 per outer row
  (empty ⇒ 1 preserved NULL row), so `outer × childEst` can under-count when
  `childEst` resolves to 0 (synthetic memory leaves) — it never over-prunes the
  memory guard in a way that loses correctness, but a reviewer may want a
  `max(childEst, 1)` factor for `cross-left` if estimate fidelity matters. Left
  as-is for parity/simplicity; flagged honestly.
- **`forkExecTest` skips execution paths under `QUEREUS_FORK_STRICT=1`** (the
  pre-existing Sort/Project-above-fan-out strict-fork false-positive, documented
  in the spec header). The two cross-left *execution-equivalence* tests are
  therefore skipped under strict-fork; recognition/shape tests still run. This
  matches the existing `cross` block — not a new gap, but the cross-left
  multiset-equality assertions only run in the non-strict suite.
- **No real remote-vtab fixture.** Like all fan-out tests, the cost gate is
  exercised via the synthetic `HighLatencyMemoryModule` (`expectedLatencyMs =
  25`) and a `concurrency: 1` cap to manufacture a positive savings number.
  Behaviour against a true remote plugin is untested in-tree (consistent with
  the rest of the fan-out suite).
- **Mixed-mode FD propagation** in `FanOutLookupJoinNode.computePhysical` still
  uses empty per-branch equi-pair lists (pre-existing conservatism, called out
  in the node's class doc) — `cross-left` rides the same path with join-type
  `left`. Not tightened here.

## Docs updated

`docs/optimizer.md` (Fan-out lookup join section: branch-mode listing, cross/
cross-left recognition, memory-guard note, tuning-knob notes, out-of-scope line,
batched-outer out-of-scope note) and `docs/runtime.md` (FanOutLookupJoinNode
branch-modes: added `cross-left`, documented the `isLeftBranchMode` /
`isCrossBranchMode` predicates, removed the stale "no rule constructs a cross
node yet" claim).
