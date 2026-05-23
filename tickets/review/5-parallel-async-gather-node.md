description: Review the AsyncGatherNode physical node + emitter landed by ticket 5. Two combinators (`unionAll`, `crossProduct`) drive N independent children concurrently via `ParallelDriver.drive` and combine them per-combinator. Manual-construction only — no optimizer recognition rule (deferred to `5.5-parallel-async-gather-union-all-rule`). `zipByKey` parked in backlog.
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/src/runtime/register.ts, packages/quereus/test/runtime/async-gather.spec.ts, docs/runtime.md, docs/architecture.md
----

## What landed

### Plan node — `packages/quereus/src/planner/nodes/async-gather-node.ts`

`AsyncGatherNode` (new): physical N-ary `RelationalPlanNode`. Constructor takes children, an `AsyncGatherCombinator` (discriminated union), a `concurrencyCap`, and an optional `preserveAttributeIds` (mirrors `BloomJoinNode`).

Construction-time invariants (enforced via a static `validateConstruction` before `super()`):

- `children.length >= 2` — degenerate gathers are not constructible.
- `concurrencyCap` is a positive integer.
- For `unionAll`, every child must have the same column count.

Per-combinator semantics:

- **`unionAll`** — attributes mirror `children[0]` verbatim (matches `SetOperationNode.buildAttributes` — preserves downstream ORDER BY resolution). `isSet` is false; per-column nullability is the OR across children. `computePhysical` drops ordering, FDs, equivalence classes, constant bindings, domain constraints (same conservatism `SetOperationNode.computePhysical` applies).
- **`crossProduct`** — attributes are the verbatim concatenation of children. Keys are the pairwise fold of children's keys (each child contributes one key; running offsets accumulate); if any child has no key, the product has no key. `computePhysical` folds FDs / equivalence classes / constant bindings / domain constraints pairwise with shifted indices, applying `closeConstantBindingsOverEcs` after each merge — the same fold `JoinNode(cross)` does, repeated.

`expectedLatencyMs` / `concurrencySafe` propagation is not introduced by this ticket; the node inherits whatever the standard child-merge path eventually surfaces (`deterministic`, `idempotent`, `readonly` flow through unchanged).

### Emitter — `packages/quereus/src/runtime/emit/async-gather.ts`

Exports three helpers for unit-testing (`runUnionAll`, `runCrossProduct`, `cartesianProduct`) plus the `emitAsyncGather` entry point wired into the registry.

- `runUnionAll(rctx, factories, cap, driver?)` — `driver.fork(rctx, N)`, then `driver.drive(factories, forks, { concurrency: cap })`, yielding each arrival's `value` immediately.
- `runCrossProduct(rctx, factories, cap, driver?)` — same fork+drive pattern, but accumulates per-branch buffers and finally yields `cartesianProduct(buffers)`. If any branch buffer is empty, returns early with no rows.
- `cartesianProduct(buffers)` — odometer-style N-ary generator; branch 0 varies slowest. Caller responsible for non-emptiness.

The emitter relies on `ParallelDriver.drive` for cancellation, error propagation (one branch throw → re-raise after best-effort `return()`-close of siblings), strict-fork bookkeeping (`drive` does its own bump/drop), and consumer-break cleanup. No manual `bumpParentForkCounter` calls are needed — that's reserved for direct-`fork()` consumers like `emitEagerPrefetch`.

### Registry — `packages/quereus/src/runtime/register.ts`

`registerEmitter(PlanNodeType.AsyncGather, emitAsyncGather)` added alongside the EagerPrefetch line.

### Validator

No explicit registration in `plan-validator.ts`. `AsyncGather` is not a logical-only type, so it passes through the validator's tree walk by default. **Caveat documented in the test spec:** `validatePhysicalTree` with the default `validateAttributes: true` will reject any plan whose parent re-publishes its children's attribute IDs verbatim — this is a pre-existing inconsistency that also affects `JoinNode`, `SetOperationNode`, and `EagerPrefetchNode`. Production callers run with `validatePlan: false` (the tuning default), so it never bites; the test exercises validation with `{ validateAttributes: false }` to isolate the node-type allowlist check.

### Tests — `packages/quereus/test/runtime/async-gather.spec.ts`

Hand-built plans + direct calls to `runUnionAll` / `runCrossProduct` (no SQL, no golden-plan). Mirrors `eager-prefetch.spec.ts` / `parallel-driver.spec.ts` style.

Node coverage: arity-min, column-count mismatch for unionAll, cap-bounds, attribute layout for both combinators, Cartesian key fold (positive + empty-key short-circuit), FD propagation (`crossProduct` shifts indices), `unionAll` drops FDs / ECs / bindings / domains, `withChildren` arity / unchanged-instance / preservation of `preserveAttributeIds`.

Runtime coverage:

- **`unionAll`** — three-branch happy path, one empty branch, all-empty, concurrency cap = N (single wave ≲ 175ms for 3 × 50ms), cap = 1 (serial ≳ 125ms for 3 × 50ms), cap < N (two waves ~100ms for 4 × 50ms, cap=2), ordering-not-preserved (sorted multiset, no list assertion), consumer-break (every branch's `return()` fires), branch throw propagates.
- **`crossProduct`** — 2×2 product, one-empty-branch → empty, three-way 2/3/4 → 24 distinct rows, cap=3 concurrency timing, cap=1 serial timing.
- **`cartesianProduct`** — happy path on 2×2 and 1×1×1.
- **Strict-fork** — one `QUEREUS_FORK_STRICT=1`-gated test that asserts parent-context mutation while the gather is live throws.

All 29 active tests pass (1 strict-fork-gated case pends in default mode; passes under `--fork-strict`).

### Docs

- `docs/runtime.md` — new subsection "AsyncGatherNode" after the EagerPrefetchNode entry. Covers combinator semantics, the dropped-ordering / dropped-FDs invariants for `unionAll`, the `crossProduct` memory caveat, the relationship between `concurrencyCap` and the 5.5 rule's `tuning.parallel.concurrency`, and the forward pointers to `5.5` and the backlog `zipByKey` ticket.
- `docs/architecture.md` — one bullet under the runtime/optimizer overview pointing at the new node and the deferred work.

## How to exercise

```ts
import { AsyncGatherNode } from 'quereus/src/planner/nodes/async-gather-node.js';
import { runUnionAll, runCrossProduct } from 'quereus/src/runtime/emit/async-gather.js';

// Manual construction — there is no optimizer rule yet.
const node = new AsyncGatherNode(scope, [childA, childB, childC], { kind: 'unionAll' }, 4);

// Or directly drive the runtime layer with synthetic factories:
const factories = [/* (ctx) => AsyncIterable<Row>, ... */];
for await (const row of runUnionAll(ctx, factories, /* cap */ 3)) { /* ... */ }
```

The emitter goes through the standard registry path — once an optimizer rule produces an `AsyncGatherNode`, no further plumbing is required to emit it.

## Honest gaps the reviewer should weigh

- **No optimizer rule for either combinator.** `unionAll` recognition is the next ticket (`5.5-parallel-async-gather-union-all-rule`). `crossProduct` recognition is opt-in and not on the optimizer roadmap. Until the rule lands, the node is unreachable from real SQL.
- **`crossProduct` materialises everything.** Every branch is drained before the first row is yielded. This matches a fully-materialised `JoinNode(cross)` profile but is a real cost on wide products. No streaming variant in v1; doc'd in `docs/runtime.md` and in the node JSDoc.
- **`zipByKey` is deferred** to `tickets/backlog/parallel-async-gather-zip-by-key.md`. The combinator union is a discriminated union so the third variant slots in without re-shaping the constructor.
- **Per-branch starvation under skewed production speeds** is possible (fast branch's slot in `drive`'s arrival queue can crowd out slower branches' first rows when `concurrencyCap < N`). v1 accepts this; adaptive scheduling is parked.
- **`expectedLatencyMs` / `concurrencySafe`** propagation is **not** introduced here — the node inherits whatever the standard child-merge path supplies, and the 5.5 ticket is responsible for consuming those properties once they exist. If 5.5 lands the propagation differently than the gather's docstring assumes (`max` for latency, `AND` for concurrencySafe), update the gather's docs at that time.
- **Validator + attribute-preserving N-ary nodes.** As noted above, `validatePhysicalTree(node)` with default options will throw a `Duplicate attribute ID` for any attribute-preserving parent (JoinNode, SetOperationNode, EagerPrefetchNode, AsyncGatherNode). This is pre-existing and out of scope for this ticket; the spec compensates by passing `{ validateAttributes: false }` for the explicit validator test. The reviewer may want to file a follow-up if validator coverage is desired for these node families.
- **FD propagation re-uses the binary-join machinery in a fold.** No bespoke N-ary FD primitives. Conservative but correct; if the rule ticket finds the resulting FD set too lossy in practice, file a follow-up.
- **No SQL or golden-plan tests** in this ticket. Those land with the rule ticket — synthetic latency sources are the way to exercise the node in isolation today.

## Validation done

- `npx tsc --noEmit` from `packages/quereus`: clean.
- `yarn run lint` from `packages/quereus`: clean (initial pass surfaced an unused import, a `let`-vs-`const`, and a `function*` that didn't yield; all addressed).
- `yarn run test` from repo root: 3363 passing / 7 pending / 0 failing across the workspace.
- `node test-runner.mjs --fork-strict --grep AsyncGather` from `packages/quereus`: 30 passing (the strict-fork-only test runs).

## End
