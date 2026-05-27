description: Review Tier-2 (isolated per-node materialization) of the key-soundness property harness — walks every relational node in the optimized plan tree, emits + runs each in isolation, and asserts keysOf()/isSet hold on that node's own rows. Best-effort: nodes that can't emit standalone are skipped.
files: packages/quereus/test/property.spec.ts
----

## What was built

Added **Tier 2** to the existing `describe('Key Soundness', …)` block in
`packages/quereus/test/property.spec.ts`. Tier 1 (already shipped) reads
`keysOf()`/`isSet` off the **top** relational result node and checks the
materialized rows never contradict them. Tier 2 does the same **per inner
node**, for every relational node in the optimized plan tree.

New `it('keysOf / isSet never over-claim on any isolated inner node (Tier 2)')`:
- For each generated query shape + random table seed, walks the optimized
  `db.getPlan(q)` tree collecting every relational node (deduped by `node.id`).
- For each node that claims something (`keys.length > 0` or `isSet`), emits it
  in isolation (`emitPlanNode(node, new EmissionContext(db))`) and runs it
  (`new Scheduler(rootInstruction).run(runtimeCtx)`), collecting the node's own
  rows as **positional tuples**. The runtime context mirrors
  `Database._executeSingleStatement` (strict row-context map, empty table
  contexts, no tracer/metrics).
- Runs the shared soundness assertions on those rows. Emission/run failures are
  caught and **skipped** (correlated / parameterized inner nodes can't run
  standalone); a skip never fails the test.
- `numRuns: 50` (matches Tier 1, within the idle budget).

### Refactors (shared, DRY)
- Extracted the positional core `checkKeysAndSet(label, keys, isSet, rows)` from
  the old record-based `checkNoOverClaim`. `checkNoOverClaim` is now a thin
  record→positional adapter that delegates to it (so the negative self-test and
  Tier 1 are unchanged in behavior). Tier 2 calls `checkKeysAndSet` directly on
  the positional `Row[]` from the scheduler.
- Hoisted the query-shape list (`queries`), the row arbitraries (`rowArbA`,
  `rowArbB`), and table create/seed into `describe`-scope helpers
  (`createTables`, `seedTables`) shared by both tiers.
- New helpers: `collectRelationalNodes(root)` (id-deduped tree walk via
  `getChildren()` + `isRelationalNode`) and `materializeNode(node)` (emit + run +
  collect positional rows; throws → skip).

### Key design points to sanity-check during review
- **Positional alignment**: `keysOf(node)` returns **column-position indices**;
  the scheduler's raw output rows are positional in `node.getType().columns`
  order. Tier 1 relies on the same contract (db.eval maps positional output to
  names by column order). Tier 2 checks positionally without going through names
  — this avoids the column-name-collision problem inner nodes can have (e.g. a
  join producing two equally-named columns), which is *why* Tier 2 uses
  `checkKeysAndSet` rather than the name-keyed `checkNoOverClaim`.
- **Non-vacuous**: a `checkedNodes > 0` sanity assertion guards against the tier
  silently degenerating into all-skips.

## Validation performed

- `Key Soundness` block: 3 passing (negative self-test, Tier 1, Tier 2).
- Full `property.spec.ts`: 45 passing, no regression.
- `yarn typecheck` (quereus): clean. `yarn lint` (quereus): clean.
- **Coverage measured** (temporary instrumentation, since removed): across the
  shape zoo Tier 2 materialized & checked **117 node instances** spanning 9
  physical node types — `StreamAggregate, IndexScan, Distinct, SetOperation,
  Sort, Project, Alias, HashAggregate, HashJoin`. **63 skips, all
  `TableReference`** (the logical table-ref node can't run standalone without a
  connection; its physical `IndexScan` form *does* run and is checked). So the
  tier exercises real keyed/set-bearing operators, not just trivial scans.

## Known gaps / things the reviewer should treat as a floor

- **Skip-by-design is silent per-node.** Only the aggregate `checkedNodes > 0`
  guard prevents a fully-vacuous tier. If a future change made a *whole class* of
  node start throwing on isolated emit (e.g. Project suddenly needing outer
  context), Tier 2 would quietly skip it and stay green as long as *some* other
  node still materializes. A reviewer wanting stronger teeth could assert a
  minimum count or a required set of checked node types — deliberately not done
  here to avoid coupling the test to optimizer output shape.
- **No correlated/subquery shapes** in the zoo, so the skip path
  (correlated/parameterized inner nodes) is currently only exercised by
  `TableReference`. The catch/skip is correct, but the "parameterized inner
  node" branch is under-tested by the current shapes. Adding a correlated
  subquery shape would exercise it (and likely add more skips) — left out to keep
  the seed/insert harness simple.
- **Isolated runs bypass the execution mutex / implicit transaction** that
  `db.exec`/`db.eval` use. Reads of committed memory tables work (mirrors
  `_executeSingleStatement`, which also doesn't preset `activeConnection`), but
  this is a read-only assumption — fine for these SELECT shapes.
- **Determinism**: fast-check uses its default seed; if a rare shape/seed ever
  surfaces a real over-claim it'll reproduce via the printed counterexample. Per
  the ticket, if Tier 2 ever proves flaky it should be gated behind an env flag
  (mirroring `PROPERTY_LONG`) rather than deleted — it is currently
  enabled-by-default and has shown no flakiness across runs.

## Acceptance check

- [x] Tier-2 walk added to the existing `Key Soundness` block.
- [x] Emission/run failures **skip** rather than fail (try/catch around
      `materializeNode`).
- [x] Same invariants as Tier 1, via the shared `checkKeysAndSet` core.
- [x] `numRuns: 50`.
- [x] No regression to Tier 1 (full spec green).
- [x] Enabled by default (no env flag needed; no flakiness observed).
