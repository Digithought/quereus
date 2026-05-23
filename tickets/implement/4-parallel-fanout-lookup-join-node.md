description: FanOutLookupJoinNode physical node + emitter. For one outer row, fork N parameterized child sub-plans, drive them concurrently via ParallelDriver, and assemble a wide result row. v1 scope is `atMostOne` mode only (LEFT/INNER per branch); `array` and `cross` are tracked as a follow-up. Manual-construction only — no optimizer recognition rule lands here (see 4.5-parallel-fanout-lookup-join-rule).
prereq: parallel-driver-context-fork, parallel-vtab-concurrency-mode, parallel-runtime-fork-test-harness, parallel-eager-prefetch-node
files: packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/planner/nodes/fanout-lookup-join-node.ts, packages/quereus/src/runtime/emit/fanout-lookup-join.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus/src/vtab/concurrency.ts, packages/quereus/test/runtime/fanout-lookup-join.spec.ts, packages/quereus/src/planner/validation/plan-validator.ts, docs/runtime.md, docs/architecture.md
effort: xhigh
----

## Goal

Land the `FanOutLookupJoinNode` physical node and its emitter so that a manually-constructed plan can replace a chain of N nested-loop LEFT/INNER joins (outer → N FK-aligned lookups) with one node that, per outer row, fires the N child sub-plans concurrently.

This ticket is **runtime artifact only**. The optimizer recognition rule, the cost-gate tuning knobs, and the golden-plan sweep are split into the dependent rule ticket (`4.5-parallel-fanout-lookup-join-rule`) so:

1. The node can ship and be exercised in isolation against a synthetic latency source before the rule starts churning real plans.
2. Golden-plan diffs are confined to one commit instead of bleeding across the runtime + rule landing.

## Architecture

### Plan node

```ts
export interface FanOutBranchSpec {
  readonly child: RelationalPlanNode;        // parameterized sub-plan
  readonly mode: 'atMostOne-left' | 'atMostOne-inner';
  // Output attribute IDs this branch contributes, in branch.child output order.
  // Preserved across rewrites so parents keep stable IDs (mirror BloomJoinNode.preserveAttributeIds).
  readonly outputAttrs: readonly Attribute[];
  // Whether the branch's underlying vtab connection allows concurrent query() on
  // the *shared* connection. Computed at construction from getModuleConcurrencyMode
  // on the child's table reference; the emitter consults it to decide between
  // raw concurrent driving and per-connection lock acquisition.
  readonly concurrencySafe: boolean;
  // Optional connection identity hint used to choose lock targets. When two
  // branches reference distinct connections, both can run unsynchronized even
  // if both modules declare 'serial'.
  readonly connectionKey?: unknown;
}

export class FanOutLookupJoinNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.FanOutLookupJoin;
  constructor(
    scope: Scope,
    public readonly outer: RelationalPlanNode,
    public readonly branches: readonly FanOutBranchSpec[],
    public readonly concurrencyCap: number,         // emitter passes through to ParallelDriver.drive
    public readonly preserveAttributeIds?: readonly Attribute[], // outer attrs + per-branch outputs, in order
  ) { ... }
  // Attribute layout: outer attrs first, then branches[0].outputAttrs, branches[1].outputAttrs, …
  // getRelations() returns [outer, ...branches.map(b => b.child)]
  // withChildren() reconstructs preserving branch shape.
}
```

Logical-node properties:

- **Attribute layout.** Outer first, then concatenated branch outputs in declared order. The branch `outputAttrs` carries the *output-side* attribute identities so the rule can preserve the original Project's attribute IDs after rewrite (mirroring `BloomJoinNode.preserveAttributeIds`).
- **Keys/FDs.** v1 is conservative: derive keys/FDs as if this were a chain of LEFT/INNER joins applied left-to-right with each branch's FK→PK alignment. Concretely, reuse `analyzeJoinKeyCoverage` + `propagateJoinFds` from `util/key-utils.ts` and `nodes/join-utils.ts` once per branch, folding the result into the next iteration's "left" type. Don't try to invent new FD-propagation primitives — fall back to the existing per-join machinery driven N times in sequence. Document the conservatism in the node's JSDoc.
- **Ordering.** Outer ordering passes through unchanged; v1 emits rows in outer order.
- **Nullability.** `atMostOne-left` branches keep their output attributes nullable; `atMostOne-inner` keep nullability as declared by the branch's own type — but a per-row miss drops the outer row entirely.

### Runtime emitter

The emitter receives:

- One outer instruction (streamed iterator).
- N branch instructions, each emitted via `emitCallFromPlan(branch.child, ctx)` so the branch surfaces as a `(ctx: RuntimeContext) => AsyncIterable<Row>` factory the per-row loop can invoke against a forked context.
- Outer row descriptor + per-branch row descriptor for `rctx.context` slot management. The outer row's slot must be *set on the parent context before forking* so each fork's snapshot already carries the binding — `ParallelDriver.fork()` snapshots the parent `RowContextMap` at fork time (see `runtime/parallel-driver.ts:60-94`).

Per outer row:

1. Set the outer row's slot on the parent `rctx`.
2. Build the N branch factories. For each branch:
   - If `branch.concurrencySafe === true` (vtab module is `'reentrant-reads'` or `'fully-reentrant'` *and* the connection is shared with no other in-flight write), the factory invokes the branch instruction directly.
   - Else, wrap the factory in an `await acquireConnectionLock(connection); try { … } finally { release(); }`. The connection is resolved at emit time from the branch's table reference.
3. Call `driver.fork(rctx, N)`, then `driver.drive(factories, forks, { concurrency: concurrencyCap })` to collect `{ branch, value }` pairs in arrival order.
4. Reduce the pairs into a per-branch buffer `branchBuf: Row[][]` (length N). When `drive` completes, every branch's buffer is final.
5. Validate `atMostOne`: if any branch's buffer has `length > 1`, throw `QuereusError(StatusCode.CONSTRAINT, 'FanOutLookupJoin: branch %d produced more than one row for outer row')`. (FD violation. The recognition rule guarantees FK→PK alignment so this should be unreachable in production; the runtime check is defensive against manual construction or future rules.)
6. For each branch with `length === 0`:
   - `atMostOne-left` → emit a NULL-padded row's slice for that branch.
   - `atMostOne-inner` → mark the outer row as dropped; do not emit.
7. Compose: `outerRow ++ branchBuf[0]_or_nulls ++ branchBuf[1]_or_nulls ++ … ++ branchBuf[N-1]_or_nulls`.
8. Yield the composed row, then advance outer.

Strict-fork bookkeeping: `ParallelDriver.drive()` already handles bump/drop internally (see `parallel-driver.ts:154-155, 281-282`); the emitter does **not** need the manual `bumpParentForkCounter`/`dropParentForkCounter` calls that `emitEagerPrefetch` uses (because eager-prefetch goes through `fork()` directly, not `drive()`).

Cleanup: on outer iterator close or thrown error inside the per-row loop, the `driver.drive`'s async generator's `return()`/error path closes all in-flight branches via its existing `closeAll` mechanism. The emitter's `try/finally` only needs to close the outer iterator and any per-call descriptors.

### vtab concurrency lock policy

The decision tree at emit time, per branch:

```
mode = getModuleConcurrencyMode(branch.tableRef.vtabModule)
if mode === 'fully-reentrant':           concurrencySafe = true
else if mode === 'reentrant-reads' and the branch is purely read:
                                         concurrencySafe = true
else:                                    concurrencySafe = false
```

When `concurrencySafe === false`, the runtime wraps the branch's call site in `acquireConnectionLock(connection)`. Sibling branches that hit *different* connections never contend; siblings that share a `'serial'` connection serialize through the lock chain.

Two open implementation choices the implement agent should resolve:

- **Connection acquisition timing.** Two options:
  - **Always share the outer's connection.** Simplest. All branches against the same module re-use one connection; if the module is `'serial'`, the lock fully serializes them (so no concurrency win for that module, but correctness is preserved). Recommended for v1 — matches what memory vtab already does and avoids opening N connections per outer row.
  - **Acquire a fresh connection per branch.** Future work for `'reentrant-reads'` plugins that want per-connection isolation. Document as deferred.
- **What "branch is purely read" means.** v1: the branch's child subtree is wholly read-only (no Insert/Update/Delete nodes anywhere). Easy to check via a recursive `isReadOnlySubtree` walk over `RelationalPlanNode`, or by inspecting `PhysicalProperties.readonly` on the branch root if reliably populated. Land whichever is more robust at the time; document the chosen check.

### Validator

Add `FanOutLookupJoin` to the *non*-logical-only set in `plan-validator.ts` (default behavior — physical-tree validation passes through). Mirror what was done for `EagerPrefetch`. No new validator branch needed.

## Tests

`packages/quereus/test/runtime/fanout-lookup-join.spec.ts` (new). Avoid SQL/golden-plan tests — those belong with the rule ticket. Build plans by hand, mirroring `eager-prefetch.spec.ts`'s style.

Coverage shape:

- **`atMostOne-left`, all branches match.** Two branches, two outer rows; assert composed row layout and that all rows are emitted.
- **`atMostOne-left`, some branches empty.** Branch returns zero rows → NULL pad. Other branch returns one row → real values. Composed row has nulls in the right slice.
- **`atMostOne-inner`, branch empty.** Outer row is dropped (matches the nested-loop INNER semantic for the chain it replaces).
- **`atMostOne-*` violation.** Synthetic branch yields two rows for one outer row → emitter throws `QuereusError`/`StatusCode.CONSTRAINT`. Pin the error message shape.
- **Concurrency.** Synthetic branch factories that resolve after `setTimeout(resolve, 50)`; with `N=3, concurrencyCap=3`, total wall-clock should be ~50ms (one fork), not 150ms (three serial). Same wide bands as the existing parallel-driver tests (75–175ms) since wall-clock is CI-flaky.
- **`concurrencyCap < N`.** With `N=4, concurrencyCap=2` and 50ms per branch, wall-clock should be ~100ms (two waves).
- **vtab-lock fan-in.** Two branches against the same `'serial'`-mode module connection: assert lock acquisition serializes them (a stub that records concurrency observed inside the critical section: at any instant, the count of branches actively *inside* `query()` for that connection must be ≤ 1). Two branches against the same `'reentrant-reads'` connection: no serialization observed.
- **Outer-row binding propagation.** The branch factory's body reads a binding placed in `rctx.context` by the outer row's slot. Assert each branch sees the *correct* outer row's value across two outer rows (catches binding bleeding between forks — the snapshot-at-fork semantic).
- **Strict-fork mode.** Run the spec under `QUEREUS_FORK_STRICT=1` (mirror the eager-prefetch tests; add two strict-only cases asserting parent-mutation-while-live throws, post-completion mutation is fine).
- **Consumer break.** Outer consumer breaks out of `for await` after one row → `drive`'s close path fires on all in-flight branches; no unhandled rejection.
- **Empty branch list.** `N=0` is rejected at construction (no use case; mirror `analyzeJoinKeyCoverage` style — throw early).
- **Validation.** Build a tree containing `FanOutLookupJoinNode` and run it through `validatePhysicalTree`; assert it passes.

## Docs

- `docs/runtime.md` — new subsection "FanOutLookupJoinNode" mirroring the EagerPrefetch entry. Cover the per-row fork-and-drive cycle, the `atMostOne` invariant + how the runtime validates it, the lock policy, and `concurrencyCap`. Note that `array`/`cross` modes are deferred to a follow-up.
- `docs/architecture.md` — one bullet under runtime/optimizer overview pointing at the new node and the deferred rule.

## TODO

Phase 1 — node and validator scaffolding

- Add `FanOutLookupJoin = 'FanOutLookupJoin'` to `PlanNodeType`.
- Create `nodes/fanout-lookup-join-node.ts` with the constructor, attribute composition, key/FD derivation by iterated per-branch `analyzeJoinKeyCoverage`+`propagateJoinFds`, `withChildren` arity check, `toString`/`getLogicalAttributes`.
- Verify validator behavior — `FanOutLookupJoin` should pass `validatePhysicalTree` without explicit allowlisting (matches `EagerPrefetch`). If the validator's tree walk requires explicit registration, add it.

Phase 2 — emitter and lock policy

- Implement `runtime/emit/fanout-lookup-join.ts`:
  - Resolve per-branch concurrency: `getModuleConcurrencyMode` + read-only-subtree check.
  - Build per-branch instructions via `emitCallFromPlan`.
  - Per-outer-row loop: set outer slot on `rctx.context`, fork + drive, collect per-branch buffers, validate atMostOne, compose, yield.
  - Wrap non-concurrencySafe branches in `acquireConnectionLock(connection)`.
- Wire into `runtime/register.ts`.

Phase 3 — tests

- Write `test/runtime/fanout-lookup-join.spec.ts`. Use the existing pattern from `eager-prefetch.spec.ts` (RuntimeContext factory, synthetic source generators, AbortController plumbing).
- Add a parent-mutation-while-live test under `QUEREUS_FORK_STRICT`.

Phase 4 — docs

- Update `docs/runtime.md` and `docs/architecture.md`.

## Honest gaps the next agent should call out in the review handoff

(These belong in the review-stage section, not the implement stage, but listing here so the implement agent knows what's expected of the handoff.)

- v1 supports `atMostOne` only. `array`/`cross` are tracked as a follow-up backlog ticket.
- No optimizer rule lands — the node is reachable only by manual construction or by ticket 4.5.
- Per-branch FD propagation by iterated per-join analysis is conservative; bespoke FD primitives for the multi-branch shape are deferred.
- Per-branch `expectedLatencyMs` is not yet a `PhysicalProperties` field — that lands with the rule ticket so the cost-gate has something to read.
- Connection-per-branch acquisition is deferred until a `reentrant-reads` plugin needs it.

## End
