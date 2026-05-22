description: Add a declarative `concurrencyMode` contract to `VirtualTableModule` so consumers of the parallel-* track know which modules tolerate concurrent calls. Default `'serial'`; memory vtab flips to `'fully-reentrant'`. Ship a runtime helper that future parallel consumers (FanOutLookupJoin) can consult to enforce the contract, and add a single unit test that covers the helper + a memory-vtab concurrent-scan smoke. Plugins and store/isolation wrappers stay default.
prereq: parallel-driver-context-fork, parallel-runtime-fork-test-harness
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/vtab/concurrency.ts, packages/quereus/test/vtab/concurrency-mode.spec.ts, packages/quereus/src/index.ts, docs/architecture.md, docs/module-authoring.md, docs/runtime.md
----

## Architecture

### The contract

Add to `VirtualTableModule` (declarative, not method-shaped):

```ts
/**
 * Declares whether the runtime may issue concurrent calls (query, update,
 * connect, …) against tables owned by this module while another call is
 * already in flight on the same connection. Read by `ParallelDriver`
 * consumers (e.g. FanOutLookupJoin) to decide whether sibling branches
 * may share a connection or must serialize.
 *
 * - `'serial'` (default) — runtime serializes vtab calls per connection.
 *   Safe for any module that has not been audited; defeats parallelism
 *   for that module.
 * - `'reentrant-reads'` — concurrent `query()` calls on a single
 *   connection are safe; writes (`update()`, savepoint ops, etc.)
 *   continue to serialize.
 * - `'fully-reentrant'` — no constraint; any operation is safe to
 *   interleave with any other on the same connection.
 *
 * Omit to inherit `'serial'`.
 */
readonly concurrencyMode?: 'serial' | 'reentrant-reads' | 'fully-reentrant';
```

Optional, default `'serial'`. Existing modules need zero code changes to retain current behavior.

Export the union type as `VtabConcurrencyMode` from `vtab/module.ts` for downstream consumers.

### Memory vtab

Flip `MemoryTableModule` to `'fully-reentrant'`. Justification (matches the layered store's design):

- `MemoryTable.query()` snapshots `conn.pendingTransactionLayer ?? conn.readLayer` once at call entry, then iterates `manager.scanLayer(startLayer, plan)`. Every BTree layer reachable from `startLayer` is **immutable** once published — mutations always go through a fresh transient layer that is folded back into the connection's `pendingTransactionLayer` atomically inside `performMutation`. So concurrent `query()` calls — even concurrent with a writer on the same connection — see consistent, non-mutating snapshots for the lifetime of their iterator.
- Connection-level state (`readLayer`, `pendingTransactionLayer`, savepoint stack) is touched only inside `begin/commit/rollback/createSavepoint/performMutation`, all of which the engine drives from the single statement-level execution thread (JS is single-threaded; these are not racing with each other within one connection). Concurrent **scans** never write that state.

We're declaring `'fully-reentrant'` rather than `'reentrant-reads'` because the JS single-thread invariant means even an interleaved write (driven by a parallel branch that also does a vtab-level mutation) can only observe a committed-layer pointer that's either the pre-write or post-write value — never a torn intermediate. The actual point at which writes get "exposed" to concurrent readers is the atomic layer-pointer swap inside the manager, which is a single synchronous statement.

If a future memory-vtab change adds genuinely mid-iteration mutation of the scanned layer (e.g. an in-place layer collapser that mutates a published layer), the mode must drop back to `'reentrant-reads'`. Document this constraint in `docs/architecture.md` alongside the flip.

### Runtime helper

A new module `packages/quereus/src/vtab/concurrency.ts` exposes two helpers consumed by future parallel plan nodes:

```ts
/** Returns the module's declared mode, defaulting to 'serial'. */
export function getModuleConcurrencyMode(module: AnyVirtualTableModule): VtabConcurrencyMode;

/**
 * Cooperative per-connection mutex used by ParallelDriver consumers
 * to serialize calls against a `'serial'` module when sibling branches
 * share a connection. Memoized on the VirtualTableConnection by
 * connectionId in a module-private WeakMap.
 *
 * Usage shape (the eventual FanOutLookupJoin consumer):
 *
 *   const release = await acquireConnectionLock(connection);
 *   try {
 *     for await (const row of vtab.query(filterInfo)) yield row;
 *   } finally {
 *     release();
 *   }
 */
export function acquireConnectionLock(
  connection: VirtualTableConnection,
): Promise<() => void>;
```

The mutex is a tiny promise-chain lock: `acquire` returns a `release` that resolves the head of the chain. No-op on `'fully-reentrant'` / `'reentrant-reads'` is the caller's job — the helper itself is mode-agnostic. (`getModuleConcurrencyMode` + `acquireConnectionLock` are separate because the lock is keyed by `connection`, but the mode lives on the `module`. The consumer reads the mode first to decide whether to even call `acquire`.)

Export both from `packages/quereus/src/index.ts` alongside `VtabConcurrencyMode`.

### What this ticket does NOT do

- **No enforcement in `ParallelDriver` itself.** The driver is plan-node-agnostic; it cannot know which `RuntimeContext` operations call into a vtab. Enforcement belongs in the consumer (FanOutLookupJoin, gather node) that owns the vtab interaction. The helpers above are what those consumers call.
- **No per-branch fresh-connection path.** The plan-stage prompt asked the agent to pick between "fresh connection per branch" vs. "per-connection lock"; we pick **per-connection lock** as the default policy. Rationale: (a) `serial` exists precisely for modules that haven't been audited, so the "minimum surprise" semantics is to fall back to the existing serial behavior, not to multiply real resource handles (file descriptors, sockets, IndexedDB transactions) underneath; (b) the lock is cheap (a single promise-chain), reversible, and easy to remove if a future plugin opts into `reentrant-reads`; (c) the alternative (cheap fresh-connection allocation) is a per-plugin question that should be answered when each plugin audits its concurrency model. Document the policy choice in `docs/module-authoring.md` so plugin authors know which knob actually buys them parallelism (declare `reentrant-reads`).
- **No plugin upgrades.** `quereus-store` (`StoreModule`), `quereus-isolation` (`IsolationModule`), the four direct plugin packages (`quereus-plugin-{leveldb,indexeddb,react-native-leveldb,nativescript-sqlite}`), and `sample-plugins/json-table` all stay default (`'serial'`). Each is a separate follow-up ticket and the right person to make the call is the plugin owner.
- **No `connect()` change.** Connection construction is unchanged; the lock is attached to an existing `VirtualTableConnection` lazily on first `acquireConnectionLock` call. No new field in the `VirtualTableConnection` interface.
- **No writer-concurrency design.** `'fully-reentrant'` for writes is a deeper change (transaction layer, savepoint ordering) and is explicitly out of scope.

### Files touched

- `packages/quereus/src/vtab/module.ts` — add `concurrencyMode?` to `VirtualTableModule`, export `VtabConcurrencyMode`.
- `packages/quereus/src/vtab/concurrency.ts` — new file: `getModuleConcurrencyMode`, `acquireConnectionLock`, lock memoization WeakMap.
- `packages/quereus/src/vtab/memory/module.ts` — add `readonly concurrencyMode = 'fully-reentrant'` on `MemoryTableModule`.
- `packages/quereus/src/index.ts` — re-export `VtabConcurrencyMode`, `getModuleConcurrencyMode`, `acquireConnectionLock`.
- `packages/quereus/test/vtab/concurrency-mode.spec.ts` — new spec (see test plan below).
- `docs/architecture.md` — bullet under the parallel-runtime section: "Module concurrency contract: `VirtualTableModule.concurrencyMode` declares serial / reentrant-reads / fully-reentrant; memory vtab is fully-reentrant; everything else defaults to serial. Parallel consumers consult `getModuleConcurrencyMode` + `acquireConnectionLock` to enforce serial."
- `docs/module-authoring.md` — new subsection under capabilities explaining the contract, the per-mode safety obligations, and how to upgrade an existing module.
- `docs/runtime.md` — short note linking the parallel-driver section to the new contract.

## Test plan

`packages/quereus/test/vtab/concurrency-mode.spec.ts`, Mocha, no SQL fixtures needed (pure unit + a thin memory-vtab integration). Expected outputs in parentheses.

- **Default mode is `'serial'`.** A fresh test module that does not declare `concurrencyMode` → `getModuleConcurrencyMode(module) === 'serial'`.
- **Explicit modes round-trip.** Test modules declaring each of the three modes return the same string. (Type-level satisfaction is already enforced by the union type; this is the runtime check.)
- **Memory module is `'fully-reentrant'`.** `getModuleConcurrencyMode(memoryTableModuleInstance) === 'fully-reentrant'`. (Sanity guard against an accidental flag regression.)
- **`acquireConnectionLock` serializes acquirers.** Acquire twice against the same mock `VirtualTableConnection`. The second `acquire` does not resolve until the first `release` runs. Verified by ordering a 0-delay async marker between the two. (Expected: marker order `[a-acquired, a-released, b-acquired]`, not `[a-acquired, b-acquired, …]`.)
- **`acquireConnectionLock` is keyed per connection.** Two distinct mock connections each get an independent lock; a held lock on connection A does not block connection B. (Expected: `[a-acquired, b-acquired, a-released, b-released]` interleaved as written.)
- **Lock survives an exception in the critical section.** Acquire, throw inside the try, release in finally → next acquirer can proceed. (Expected: no deadlock.)
- **Memory-vtab concurrent scan smoke.** Stand up an in-memory database, insert ~50 rows, fire 4 concurrent `db.exec("select * from t")` async iterators with `Promise.all`, assert each produces the full result set and total cardinality is `4 × 50`. This is the load-bearing safety check for the `'fully-reentrant'` declaration — if a future memory-vtab change breaks concurrent reads, this test fails before any FanOutLookupJoin consumer is even built. (Expected: 200 rows across all four iterators, no exception, no row corruption.)

The memory-vtab smoke does not use `ParallelDriver` — it goes through the public `db.exec()` path so that the test stays valid even if the driver's internals are refactored. The driver-side validation belongs with the consumer ticket.

## Open question deferred

The plan-stage ticket flagged: "with future `reentrant-reads` plugins, the driver needs a policy — share until contention, then allocate? Acquire fresh per branch always?" That is **not** answered by this ticket because the only consumer that hits it (`parallel-fanout-lookup-join`) is the right place to decide based on its actual access pattern. This ticket lays out the declarative contract and the lock primitive; the FanOutLookupJoin ticket decides the share-vs-allocate policy.

## TODO

### Phase 1 — interface + memory

- Add `concurrencyMode?: 'serial' | 'reentrant-reads' | 'fully-reentrant'` and exported `VtabConcurrencyMode` to `packages/quereus/src/vtab/module.ts`. JSDoc per the spec above.
- Add `readonly concurrencyMode = 'fully-reentrant' as const` field on `MemoryTableModule`. No constructor change.

### Phase 2 — runtime helper

- Create `packages/quereus/src/vtab/concurrency.ts` exporting `getModuleConcurrencyMode(module)` and `acquireConnectionLock(connection)`. Lock memoized in a module-private `WeakMap<VirtualTableConnection, Promise<void>>` (or equivalent promise-chain lock).
- Re-export `VtabConcurrencyMode`, `getModuleConcurrencyMode`, `acquireConnectionLock` from `packages/quereus/src/index.ts`.

### Phase 3 — tests

- Write `packages/quereus/test/vtab/concurrency-mode.spec.ts` per the test plan above (7 cases).
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log` and confirm no regressions.
- Run `yarn workspace @quereus/quereus run lint` and confirm clean.

### Phase 4 — docs

- Add the architecture bullet (`docs/architecture.md`, near the parallel-runtime section).
- Add the module-authoring subsection (`docs/module-authoring.md`).
- Add the runtime-doc cross-link (`docs/runtime.md`).
