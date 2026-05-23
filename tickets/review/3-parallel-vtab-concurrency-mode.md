description: Review the declarative `concurrencyMode` contract on `VirtualTableModule`, the `vtab/concurrency.ts` helper (mode getter + per-connection promise-chain lock), the `'fully-reentrant'` declaration on `MemoryTableModule`, the new `vtab/concurrency-mode.spec.ts` (7 cases), and the architecture/module-authoring/runtime doc updates. Plugins and store/isolation wrappers are intentionally untouched (default `'serial'`).
prereq: parallel-driver-context-fork, parallel-runtime-fork-test-harness
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/concurrency.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/index.ts, packages/quereus/test/vtab/concurrency-mode.spec.ts, docs/architecture.md, docs/module-authoring.md, docs/runtime.md
----

## What landed

### Contract surface

- New union `VtabConcurrencyMode = 'serial' | 'reentrant-reads' | 'fully-reentrant'` in `packages/quereus/src/vtab/module.ts:34` and a `readonly concurrencyMode?: VtabConcurrencyMode` member on `VirtualTableModule` at `module.ts:81`. Optional; omitting it inherits `'serial'`. No existing module's code changes other than the memory vtab below — every other module retains current serial semantics by default.

### Runtime helper

- `packages/quereus/src/vtab/concurrency.ts` (new):
  - `getModuleConcurrencyMode(module): VtabConcurrencyMode` — returns the declared mode or `'serial'`.
  - `acquireConnectionLock(connection): Promise<() => void>` — promise-chain mutex keyed by `VirtualTableConnection` identity via a module-private `WeakMap<VirtualTableConnection, Promise<void>>`. Each acquire chains a fresh tail and awaits the prior tail; the returned `release` resolves the chain so the next acquirer can proceed. No-op-on-non-`'serial'` is the caller's job — the lock itself is mode-agnostic.
- Re-exports added to `packages/quereus/src/index.ts:31`: `VtabConcurrencyMode`, `getModuleConcurrencyMode`, `acquireConnectionLock`.

### Memory vtab declaration

- `MemoryTableModule` declares `readonly concurrencyMode = 'fully-reentrant' as const` (`packages/quereus/src/vtab/memory/module.ts:67-79`). Justification in the surrounding JSDoc and in `docs/architecture.md`: `query()` snapshots the connection's read layer once at call entry and iterates immutable BTree layers; writes always publish via a fresh transient layer that is atomically folded into `pendingTransactionLayer`. Under JS's single-thread invariant, a concurrent reader can only observe the pre- or post-write layer pointer — never a torn intermediate.
- If a future memory-vtab change adds genuine mid-iteration mutation of a scanned layer (e.g. an in-place layer collapser), this must drop to `'reentrant-reads'`. The JSDoc on the field and the bullet in `architecture.md` both call this out.

### Tests

`packages/quereus/test/vtab/concurrency-mode.spec.ts` (new, 7 cases, all passing):

- **`getModuleConcurrencyMode` defaults to `'serial'`** for a module that declares nothing.
- **Round-trips each explicit mode** for stub modules.
- **`MemoryTableModule` reports `'fully-reentrant'`** — guards against accidental regression of the flag.
- **`acquireConnectionLock` serializes acquirers on one connection.** Verified by ordering microtasks between two acquires and asserting the second only resolves after the first releases.
- **`acquireConnectionLock` is keyed per connection.** A held lock on A does not block B.
- **Lock survives an exception in the critical section.** Verified by throwing inside the try/finally and confirming the next acquire proceeds.
- **Memory-vtab concurrent-scan smoke.** 50 rows × 4 concurrent `db.eval('select id, v from t')` iterators driven with `Promise.all`; asserts total cardinality 200 and per-iterator cardinality 50 with spot-checks on the first/last row of each.

### Docs

- `docs/architecture.md`: added a "Recent refinements" bullet next to the parallel-runtime entries summarising the contract and the memory-vtab declaration.
- `docs/module-authoring.md`: added a new "3. Concurrency Mode (Parallel Runtime)" subsection under Module Capability APIs, with the mode table, per-mode safety obligations, upgrade walkthrough, and the canonical caller pattern.
- `docs/runtime.md`: extended the `ParallelDriver` section to link out to the contract and named the helpers (`getModuleConcurrencyMode`, `acquireConnectionLock`); annotated the `activeConnection` row in the fork-policy table to mention the default-`'serial'` lock requirement.

## Validation

- `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js --reporter spec packages/quereus/test/vtab/concurrency-mode.spec.ts` → 7 passing, 0 failing (34 ms).
- `yarn workspace @quereus/quereus test` → 3334 passing, 6 pending, 0 failing on a clean re-run.
  - One earlier run reported a `Optimizer Equivalence / predicate pushdown rules produce identical results` fast-check property-test failure. Re-running both with and without my changes alternated pass/fail — the property generates fresh random seeds per invocation, so this is a flaky pre-existing test, not caused by this ticket. Untouched files: `test/fuzz.spec.ts` exercises planner rules far outside the vtab module surface.
- `yarn workspace @quereus/quereus run lint` → clean (exit 0).
- `yarn workspace @quereus/quereus run typecheck` → clean (exit 0).

## Known gaps and deliberate non-changes

These are written down honestly so the reviewer treats the tests as a floor, not a finish line.

- **No enforcement in `ParallelDriver`.** The driver is plan-node-agnostic and cannot know which `RuntimeContext` operations touch a vtab. Enforcement is the consumer's job (FanOutLookupJoin, gather node, …). The helpers shipped here are what those consumers will call; the consumer ticket(s) are out of scope.
- **Memory-vtab concurrent-scan smoke runs through `db.eval`, which acquires the engine's per-database exec mutex** (`Database._acquireExecMutex` in `packages/quereus/src/core/database.ts:361`). So the four iterators in test case 7 do not actually overlap at the vtab layer in today's runtime — they serialize at the engine mutex. The test still asserts the load-bearing correctness invariant (4 × 50 rows, no corruption) and will catch any future regression that breaks scans on memory tables, but a reviewer evaluating "does this prove `'fully-reentrant'` is actually safe under concurrent vtab calls?" should know it does **not** exercise concurrent vtab calls today. The deeper concurrent-scan test belongs with the FanOutLookupJoin consumer when there's a code path that actually parallel-drives the vtab. Worth a second opinion on whether a direct-`table.query()` concurrent smoke should also live here as belt-and-braces.
- **No plugin upgrades and no `connect()` change.** `quereus-store`, `quereus-isolation`, the four plugin packages, and `sample-plugins/json-table` all stay default. Each is a separate follow-up ticket that the plugin owner should drive. Connection construction is unchanged; the lock attaches to an existing `VirtualTableConnection` lazily via the WeakMap.
- **No share-vs-allocate policy.** The plan-stage ticket flagged "with `reentrant-reads` plugins, the driver needs a policy — share until contention, then allocate? Acquire fresh per branch always?" That decision lives with the FanOutLookupJoin consumer and is not answered here. This ticket landed the contract and the lock primitive.
- **Writer concurrency is explicitly out of scope.** `'fully-reentrant'` for writes is a deeper change (transaction layer, savepoint ordering) and the memory-vtab declaration relies on the layered-store property that writes publish via fresh-layer atomic swap. A module that wants `'fully-reentrant'` for writes must independently justify the property.
- **The lock uses a module-private `WeakMap` keyed on `VirtualTableConnection` identity.** Two different `VirtualTable` instances backed by the same shared connection object will share a lock — that's intentional given the contract is per-connection — but if a consumer keys the lock differently (e.g. on a wrapper that yields the same underlying connection), this property is worth double-checking. The `VirtualTableConnection` interface (`packages/quereus/src/vtab/connection.ts`) exposes a `connectionId` string the helper does NOT use; identity is by object reference.

## Suggested review focus

- **JSDoc correctness on `VirtualTableModule.concurrencyMode`** — does the wording correctly describe what `'reentrant-reads'` and `'fully-reentrant'` actually permit, and is the default-`'serial'` fallback claim accurate against the runtime helper's behavior?
- **The memory-vtab safety justification** — is the "JS single-thread + atomic pointer swap" argument tight enough to support `'fully-reentrant'` rather than `'reentrant-reads'`? Reviewer should sanity-check `MemoryTable.query()` / `MemoryTableManager.scanLayer` / `performMutation` to confirm no shared mutable state on the scan path.
- **The lock primitive** — promise-chain mutexes are standard but easy to get wrong (release ordering, awaiting a stale tail). Worth a close read of `acquireConnectionLock`.
- **Doc tone and placement** — module authors are the primary readers of `module-authoring.md`. The new "3. Concurrency Mode" subsection deliberately sits next to the existing capability APIs because the declaration is a sibling concept.
