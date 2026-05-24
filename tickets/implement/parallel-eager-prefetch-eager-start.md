description: Start EagerPrefetch's pump on emit (run()) instead of on first iteration, so a hash join's build phase overlaps with the probe's first prefetch round-trip; gate the wrap rule on concurrencySafe.
prereq:
files: packages/quereus/src/runtime/emit/eager-prefetch.ts, packages/quereus/src/runtime/emit/bloom-join.ts, packages/quereus/src/planner/rules/parallel/rule-eager-prefetch-probe.ts, packages/quereus/src/planner/nodes/eager-prefetch-node.ts, packages/quereus/test/runtime/eager-prefetch.spec.ts, packages/quereus/test/optimizer/parallel-eager-prefetch-probe.spec.ts
----

## Goal

`EagerPrefetchNode` hides latency by pumping its source into a bounded ring buffer ahead of the consumer's first demand. Today the pump is **lazy**: `emitEagerPrefetch.run` returns an async generator whose body (`fork` + detached pump) only executes on the first `.next()`. Inside a `BloomJoinNode` the runtime drains the build (`right`) side to completion *before* it ever touches the probe (`left`) side, so when the probe is an `EagerPrefetchNode` its pump does not start until the entire build phase finished. We capture per-row probe-latency hiding but lose the larger win: overlapping the build materialization with the probe's first network round-trip.

Make the pump start as soon as the scheduler invokes the prefetch's `run()` (which happens during scheduler arg-assembly, before `BloomJoin.run`'s body drains the build), so the probe's first fetch is already in flight while the build materializes.

## Why this needs a concurrency gate (do not skip)

Today `rule-eager-prefetch-probe` has no concurrency-safety gate, and that is currently correct: the BloomJoin drains the build (`right`) to completion before the (lazy) probe pump ever starts, so pump and build never run concurrently. The moment the pump starts on `run()`, that invariant breaks — the probe pump iterates the `left` subtree **concurrently** with the build's for-await over `right`. If both sides sit over the same `'serial'` vtab connection (or otherwise share a non-reentrant cursor), concurrent iteration corrupts state.

So this change must be paired with a `concurrencySafe` gate on the wrap rule, mirroring `rule-async-gather-union-all` (`packages/quereus/src/planner/rules/parallel/rule-async-gather-union-all.ts:65-70`, which aborts on `child.physical.concurrencySafe !== true`). Only wrap the probe when **both** `node.left.physical.concurrencySafe === true` (probe) and `node.right.physical.concurrencySafe === true` (build).

Background facts already verified:
- `concurrencySafe` is set on access leaves in `reference.ts:201` as `getModuleConcurrencyMode(module) !== 'serial'`. The memory module declares `concurrencyMode = 'reentrant-reads'` (`vtab/memory/module.ts:88`), so it reports `concurrencySafe === true`. The `HighLatencyMemoryModule` test helper extends `MemoryTableModule`, so both sides of the existing "fires" SQL test stay `=== true` — **the new gate does not break that test.**
- The base `physical` getter ANDs children (`plan-node.ts:584`, `concurrencySafe: every(child !== false)`); leaf default (`DEFAULT_PHYSICAL`) omits `concurrencySafe` entirely (it is `undefined`). Use `=== true` (mirror async-gather strictness: only wrap when *proven* safe). Consequence: the direct-invocation mock tests in `parallel-eager-prefetch-probe.spec.ts` must set `concurrencySafe: true` on the probe/build `MockRelNode` physical overrides (they currently omit it → `undefined` → gate would block the "fires" cases).

## Approach chosen: eager-on-run inside `emitEagerPrefetch` (ticket's Approach 1)

Restructure `prefetchAsyncIterable` / `emitEagerPrefetch` so `run()` **eagerly** forks and starts the pump at call time and returns a plain (non-generator) `AsyncIterable<Row>` whose backing pump is already running. The scheduler calls each instruction's `run()` during arg-assembly (`scheduler.ts` `runOptimized`), before the parent `BloomJoin.run`'s generator body executes, so the pump is live before the build for-await begins.

Rejected Approach 2 (prime the pump from `bloom-join` by pulling one `.next()` before the build for-await): it must be conditional on `plan.left instanceof EagerPrefetchNode` (an unconditional early `.next()` would advance a serial left cursor one row before the build iterates the right cursor — the very corruption we are guarding against), and it complicates the probe loop with a buffered-first-row that still has to flow through the full inner/semi/anti/outer `joinOutputRow` logic. Approach 1 keeps the probe loop a clean for-await and localizes the eager behavior in the prefetch node, benefiting any future EagerPrefetch consumer.

### Eager `prefetchAsyncIterable` shape

Convert the exported `prefetchAsyncIterable` from an async generator into a function that does the fork + pump at call time and returns a manual `AsyncIterable` whose iterator drains the buffer and whose `return()`/`throw()`/done-path perform cleanup. Preserve every current behavior: ordered pass-through, bounded back-pressure, `buf.fail` → `shift()` throws (error identity preserved), child `return()` on cleanup, and strict-fork counter bump/drop. Sketch:

```ts
export function prefetchAsyncIterable(rctx, sourceCallback, bufferSize, driver = new ParallelDriver()): AsyncIterable<Row> {
	// EAGER: fork + start the pump now, at call time — not on first next().
	const [forkCtx] = driver.fork(rctx, 1);
	const parentTableState = bumpParentForkCounter(forkCtx.tableContexts);
	const parentRowState = bumpParentForkCounter(forkCtx.context);
	const childIter = sourceCallback(forkCtx)[Symbol.asyncIterator]();
	const buf = new BoundedPrefetchBuffer<Row>(bufferSize);
	const abort = new AbortController();
	const pump = (async () => { /* same loop: childIter.next() → buf.push / buf.close / buf.fail */ })();
	void pump;

	let cleanedUp = false;
	const cleanup = async () => {
		if (cleanedUp) return; cleanedUp = true;
		abort.abort(); buf.close();
		try { await childIter.return?.(undefined); } catch { /* swallow */ }
		await pump.catch(() => undefined);
		dropParentForkCounter(parentTableState);
		dropParentForkCounter(parentRowState);
	};

	return {
		[Symbol.asyncIterator](): AsyncIterator<Row> {
			return {
				async next() {
					try {
						const item = await buf.shift();          // throws if pump called buf.fail
						if (item.done) { await cleanup(); return { done: true, value: undefined as never }; }
						return { done: false, value: item.value };
					} catch (e) { await cleanup(); throw e; }
				},
				async return(v) { await cleanup(); return { done: true, value: v as never }; },
				async throw(e) { await cleanup(); throw e; },
			};
		},
	};
}
```

`emitEagerPrefetch.run` stays a thin wrapper returning `prefetchAsyncIterable(rctx, sourceCallback, bufferSize, driver)`. Update the node/emit doc comments (`eager-prefetch.ts:168-174`, `eager-prefetch-node.ts:8-26`): the pump now starts on `run()` (emit/arg-assembly), not on first demand.

### Cleanup contract / non-consumption hazard

Eager-on-construction means the fork counters are bumped at `run()` time; cleanup only fires via the iterator's `return()`/`throw()`/done-path. If the returned iterable is **never iterated**, the pump leaks (it fills the buffer to capacity then blocks on back-pressure forever) and the strict-fork counters stay bumped.

Today the only inserter of `EagerPrefetchNode` is `rule-eager-prefetch-probe` (always the `left`/probe child of a `BloomJoin`). The probe phase's for-await closes the left iterator on normal completion, consumer-break, and consumer-throw. The single uncovered path is **build-phase error before the probe loop starts** (`bloom-join.ts:58-67` throws → the probe for-await is never created → left never closed). Fix in `bloom-join.ts`: obtain the left iterator up front and close it in a `finally` that wraps both phases, so the eager pump is always torn down:

```ts
const leftIter = leftSource[Symbol.asyncIterator]();
try {
	// build phase over rightSource ...
	// probe phase: iterate leftIter (manual while-loop, or wrap as { [Symbol.asyncIterator]: () => leftIter })
} finally {
	leftSlot.close(); rightSlot.close();
	try { await leftIter.return?.(undefined); } catch { /* swallow */ }
}
```

Keep the probe loop semantically identical (inner/semi/anti/outer via `joinOutputRow`); only the iterator acquisition + `finally` close changes. Document in the EagerPrefetch node comment that any *future* consumer of EagerPrefetch must likewise guarantee iterate-or-close.

### Strict-fork / Sort-above-fork

Respect the existing strict-fork contract. The bump now happens at `run()` (construction) rather than first `.next()` — that is the intended semantics: the fork is "live" from construction. The gather rule documents a known Sort-above-fork interaction; verify the existing strict-mode tests in `eager-prefetch.spec.ts` (`describe('strict-fork interaction')`) still hold under eager construction (parent mutation while live throws; mutation after drain is allowed).

## Tests

Run with `QUEREUS_FORK_STRICT` both unset and `=1` where the strict-fork tests live.

### `eager-prefetch.spec.ts` (runtime unit) — update the lazy-contract tests

These two pin the *old* lazy behavior and must be rewritten to the new eager contract (the behavior change is intentional):
- `describe('eager start') > 'kicks the source synchronously on first iter.next()'` — replace with: building the iterable (calling `prefetchAsyncIterable(...)`) starts the source **before** any `.next()`. Expected: `started === true` immediately after construction.
- `describe('no work without consumption') > 'does not invoke the source if the returned iterable is never iterated'` — invert: the source **does** start on construction even without iteration. (Add a `return()`/drain in the test to clean up the now-running pump and avoid a dangling timer.)

These should keep passing unchanged (sanity that eager refactor preserves semantics): pass-through ordering, empty source, `pre-fetches additional rows while consumer is busy`, back-pressure bound (`produced ≤ bufferSize + 2`), consumer-break calls child `return()`, no-unhandled-rejection after break, inner-throw identity, consumer-error-path closes child, both `BoundedPrefetchBuffer` helper tests, and both strict-fork tests.

### `parallel-eager-prefetch-probe.spec.ts` (optimizer) — add the concurrency gate

- Update the existing direct-invocation mock physical overrides: the probe and build `MockRelNode`s in the "fires (direct)" and "propagates relational physical claims" paths must include `concurrencySafe: true` (else the new `=== true` gate blocks them). The `makeJoin` build override and the default probe override are the ones to touch.
- New direct test **"does NOT fire: probe is not concurrencySafe"** — probe `MockRelNode` with `physical: { deterministic: true, readonly: true, concurrencySafe: false }`, high-latency safe build → `ruleEagerPrefetchProbe(join, ctx)` returns `null`.
- New direct test **"does NOT fire: build is not concurrencySafe"** — safe probe, build with `concurrencySafe: false` (and latency ≥ threshold) → returns `null`.
- The existing SQL-level "fires" / "execution equivalence" tests must still fire (memory + hi-lat-memory are both `reentrant-reads` → `concurrencySafe === true`); confirm they pass unchanged.

### Overlap / latency test (the headline win)

Add a runtime test (in `eager-prefetch.spec.ts` or a new `parallel-eager-prefetch-overlap.spec.ts`) demonstrating the build wait overlaps the probe's first fetch. Construct a `BloomJoin`-shaped scenario (or test `runBloomJoin`-equivalent directly with hand-built sources):
- Build (right) source: yields N rows with a per-row `await sleep(d)` so the build phase takes ~`B` ms total.
- Probe (left) source wrapped in eager prefetch: records a timestamp when its **first** `childIter.next()` fires.
- Assert the probe's first-fetch timestamp lands *during* the build window (well before build completion), not after it. Use wide CI-flaky bands like `fanout-lookup-join.spec.ts:185` (e.g. first-fetch start `< B/2`, and total wall-clock noticeably less than `B + probeFirstFetchLatency` serialized).

The existing `parallel-eager-prefetch-probe.spec.ts` execution-equivalence test continues to guard row/order correctness.

## Validation

Stream output (Windows + Git Bash `tee` caveat — see AGENTS.md):
```
yarn workspace @quereus/quereus test 2>&1 | tee /tmp/eager.log; tail -n 100 /tmp/eager.log
QUEREUS_FORK_STRICT=1 yarn workspace @quereus/quereus test --grep "EagerPrefetch|eager-prefetch|ruleEagerPrefetchProbe" 2>&1 | tee /tmp/eager-strict.log; tail -n 80 /tmp/eager-strict.log
```
Also run `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows). Confirm the golden-plan / optimizer sweep still shows no rewrites on local-only memory plans (the gate + zero-latency cost gate keep the rule inert there).

Note the future ticket `tickets/backlog/known/2-adaptive-query-optimization` — adaptive optimization may later revisit when/whether to insert this prefetch; keep the gate logic self-contained in `rule-eager-prefetch-probe.ts` so it composes cleanly.

## TODO

- [ ] `rule-eager-prefetch-probe.ts`: add the `concurrencySafe === true` gate on both `node.left` (probe) and `node.right` (build); update the rule doc comment to record the gate and why eager-start requires it.
- [ ] `eager-prefetch.ts`: convert `prefetchAsyncIterable` to eager-on-call (fork + pump at construction) returning a manual `AsyncIterable` with `return()/throw()/done` cleanup; preserve back-pressure, error identity, child return, strict-fork bump/drop. Update doc comments on the helper and `emitEagerPrefetch`.
- [ ] `eager-prefetch-node.ts`: update the class doc comment ("starts on run()/emit, not first demand") and document the iterate-or-close contract for consumers.
- [ ] `bloom-join.ts`: acquire the left iterator up front; wrap build + probe phases in a `finally` that closes it (and the slots), covering the build-error-before-probe path so the eager pump never leaks.
- [ ] `eager-prefetch.spec.ts`: rewrite the two lazy-contract tests to the eager contract; verify the remaining unit + strict-fork tests still pass.
- [ ] `parallel-eager-prefetch-probe.spec.ts`: add `concurrencySafe: true` to the existing mock overrides; add the two new "not concurrencySafe → no wrap" direct tests.
- [ ] Add the build/probe overlap (latency) runtime test.
- [ ] Run full quereus test suite + strict-fork grep + lint; confirm golden-plan sweep unchanged.
