description: Review the cascading incremental-MV convergence implementation — MV-over-MV chains now converge within a single COMMIT via a topologically-ordered post-commit maintenance pass plus a per-pass delta overlay layered on the change log. Verify correctness of the overlay capture/projection, topo ordering, the kernel seams, and the documented divergence caveat.
files: packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, packages/quereus/test/incremental/delta-executor.spec.ts, docs/materialized-views.md, docs/incremental-maintenance.md
----

## What was implemented

Cascading incremental MVs (an `on-commit-incremental` MV whose body reads another
incremental MV's backing table) now **converge within a single COMMIT**. Before
this change, a depth-N chain lagged one commit per level; interim reads of a
dependent returned stale data with no error.

The fix processes incremental MVs in **dependency-topological order** within the
existing single post-commit maintenance pass, and makes each producer MV's
backing-table write visible to its dependents through a manager-owned **delta
overlay** layered on top of the `TransactionManager` change log.

### Kernel seams (`delta-executor.ts`) — consumer-neutral, opt-in

- `DeltaExecutorContext.isGloballyChanged?(base): boolean` — when a base changed
  opaquely (a producer rebuilt wholesale), `runOne` flags any relation on it for
  global re-evaluation rather than fetching per-tuple deltas. Seam placed right
  after the `changedBases.has(base)` guard.
- `runAll(opts?: RunAllOptions)` with `order?(subs)` (reorder the snapshot,
  default insertion order) and `rescanPerSubscription?` (recompute
  `getChangedBaseTables()` before each `runOne`, default false).
- Assertions (`database-assertions.ts`) and watchers (`database-watchers.ts`)
  still call `runAll()` with no args → **zero behavior change** (verified: only
  the MV manager passes options).

### MV manager (`database-materialized-views.ts`)

- Per-pass overlay state, reset at the top of `runPostCommit`:
  - `pendingDelta: Map<backingBase, Map<pkKey, {op, oldRow?, newRow?}>>` — captured
    per-row backing deltas (full rows stored, so any requested column projects
    directly).
  - `globallyChangedBacking: Set<string>` — backing bases rebuilt wholesale.
- Overlay-aware executor context: `getChangedBaseTables` unions the txn set with
  `pendingDelta.keys()` and `globallyChangedBacking`; `getChangedTuples` projects
  out of captured rows for an overlay base (insert→new, delete→old,
  update→old&new, de-duped) and delegates to the change log otherwise;
  `isGloballyChanged` consults `globallyChangedBacking`.
- `applyMaintenanceAndCapture`: after a per-binding `applyMaintenance`, reads each
  touched backing PK before and after the (synchronous, latched) write and
  synthesizes an insert/update/delete overlay change keyed by serialized PK.
- `markBackingRebuilt`: every successful full rebuild (global binding,
  cost-fallback, `deleteKeyOrder === null`, diverged self-heal, Tier-1 recovery)
  marks `globallyChangedBacking`. Tier-2 divergence records nothing.
- Topological order: Kahn over producer-backing-base → consumer edges; rank cached
  (`subId → rank`), invalidated on register/unregister. Cycle guard warns and
  falls back to insertion order (cycles are structurally impossible).
- `CompiledIncrementalMV` gains `backingBase` (`mvKey(schema, backingTableName)`)
  and `subscriptionId`.

## How to validate / use cases

Run: `node packages/quereus/test-runner.mjs --grep "52-materialized-views-incremental"`
and `... --grep "DeltaExecutor"`.

The new sqllogic sections (§13–§17 of `52-materialized-views-incremental.sqllogic`)
cover, all asserting convergence **without a second commit/refresh**:

- **§13 Linear chain** `c_t → c_mv1 → c_mv2`: a single source insert reflects in
  `c_mv2` the same commit (`x10 = (x+1)*10`).
- **§14 Depth-3 chain** `… → c_mv3`: one source mutation converges all three.
- **§15 Aggregate dependent over a row-preserving leaf** (`c_sum = sum(v) group by k`
  over `c_leaf`): an UPDATE moving a leaf row between groups drives BOTH the OLD
  and NEW group of the aggregate the same commit (exercises overlay old/new
  projection).
- **§16 Cost-fallback / rebuild upstream propagates**: a bulk insert (may demote
  `c_big1` to a full rebuild) still converges `c_big2` (forced rebuild via
  `globallyChangedBacking`). Result is correct on either path.
- **§17 DELETE / predicate ripple**: a row leaving (`x>0 → x=-2`) or entering
  (`x=-1 → x=7`) a leaf MV's predicate, and a deleted source row, ripple to the
  dependent the same commit.

New kernel unit tests in `delta-executor.spec.ts` (`RunAllOptions + isGloballyChanged`):
`order` reorders dispatch; `rescanPerSubscription` exposes a base added by an
earlier apply; `isGloballyChanged` forces a row relation to global without
fetching tuples.

Full suite green: **3793 passing, 9 pending, 0 failing**; `lint` clean; `build`
(tsc) clean. Non-cascading §1–§12 unchanged (no leaf-MV regression).

## Known gaps / what the reviewer should scrutinize (tests are a floor)

- **No isolated unit test for the overlay capture itself.** `applyMaintenanceAndCapture`
  and `overlayChangedTuples` projection are exercised only end-to-end via the
  sqllogic cascade cases. A focused unit test (before/after synthesis for
  insert/update/delete, composite-PK and old/new projection) would harden this.
  In particular, double-check `serializeTuple` / `pkToString` dedup for composite
  PKs, `bigint`, `Uint8Array`, and `null` values (uses a `` join + type
  prefixes; only ever used as a map key, never split).
- **Per-binding capture runs even for leaf MVs with no dependents** — two extra
  point-reads per touched key plus a discarded overlay map. Bounded (large deltas
  route through cost-fallback → rebuild, which skips per-binding capture), but a
  guard ("only capture for backing bases that have a consumer") is a possible
  optimization. Not implemented to keep the path simple/correct.
- **Cost-fallback on the cascade hop.** Backing tables are created with
  `estimatedRows: 0`, so `getRowCount(backingBase)` returns 0 and the
  ratio-based cost-fallback never fires on a dependent's binding (dependents stay
  per-binding — desirable). If backing-table stats ever get populated, a cascade
  hop could start demoting to rebuild; behavior stays correct, just less
  incremental. Worth a glance.
- **Cascading divergence is NOT propagated (documented limitation).** If an
  upstream MV diverges (Tier-2: even its rebuild failed), its dependents are
  maintained against the upstream's stale backing data without erroring — only
  direct reads of the diverged MV error (via the `diverged` read-guard). Captured
  in `docs/materialized-views.md` § Limitations. If this warrants tracking, file a
  `backlog/` ticket.
- **Single-source bodies only (v1).** Multi-source/join bodies are still rejected
  at create, so a cascade is a linear chain (forest), not a general DAG with
  diamonds. The topo machinery is general and stays correct when join bodies land
  (`materialized-view-incremental-join-bodies`).
- **Convergence relies on the executor awaiting each `runOne` sequentially** so a
  producer's `markBackingRebuilt` / `pendingDelta` writes are visible before a
  consumer's `runOne` (guaranteed by topo order + sequential await). Confirm no
  future change parallelizes `runAll` without revisiting this.

## Docs updated

- `docs/materialized-views.md` § Limitations: replaced the "may need more than one
  commit" bullet with the resolved single-commit behavior + cascading-divergence
  caveat.
- `docs/incremental-maintenance.md` § Third consumer: new "Cascading convergence"
  subsection describing the two kernel seams, topo order, overlay change source,
  and capture-on-write.
- `database-transaction.ts` post-commit comment updated (no longer documents the
  lag).
