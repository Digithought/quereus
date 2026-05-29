# Incremental Maintenance

Quereus exposes a single, reusable change-driven kernel that runs at every COMMIT.
Three consumers are live today: **assertions** (pre-commit, can roll the commit
back), **`Database.watch` reactive signals** (post-commit, fire-and-forget), and
**incremental materialized views** (post-commit, fire-and-forget, but their
`apply` *writes* a backing table — see
[Third consumer](#third-consumer-materializedviewmanager)). Manual-refresh
materialized views ([Materialized Views](materialized-views.md)) still
re-materialize in full on `REFRESH` and do not consume this kernel; **`row-time`**
materialized views are maintained *synchronously at the DML boundary*, also off
this kernel — see [Row-time write-through](#row-time-write-through-synchronous-off-the-kernel).
Still to come
— covering structures (indexes / unique-constraint enforcement) and triggers —
all of which plug into the same surface without reinventing change capture or
binding-key analysis. The [lens layer](lens.md) routes set-level constraint
enforcement to this kernel when no covering structure is present, and maintains
covering structures through it when one is.

## Pipeline at a glance

```
DML emitter ──recordInsert/Update/Delete(row, pkIndices)──► TransactionManager
                                                              │
                                                  per-base capture demand
                                                  registered by consumers
                                                              ▼
                                                       ChangeCapture
                                                  (PK + projected cols,
                                                   savepoint-layered)
                                                              │
                                          at top-level COMMIT (phase per consumer:
                                           assertions pre-commit, watch post-commit)
                                                              ▼
                                                       DeltaExecutor
                                                              │
                            ┌─────────────────────┬──────────┴────────┐
                            │                     │                   │
                            ▼                     ▼                   ▼
                  AssertionEvaluator     Database.watch       [future] MV /
                  (residual scheduler    (post-commit          covering-structure
                   per tuple,             reactive signals)     refresh
                   pre-commit)                                  (delete-then-upsert
                                                                 per binding tuple)
```

The kernel is decoupled from any specific consumer. A `DeltaSubscription`
carries:
- `dependencies` — the set of base tables the subscription cares about.
- `bindings` — a `BindingMode` per `TableReferenceNode` instance (from
  `extractBindings` in the optimizer).
- `apply(input)` — invoked at COMMIT with per-relation binding tuple batches
  and a set of relations flagged for global re-evaluation.

## Lifecycle

### Registering capture demand

A consumer that needs non-PK column values calls
`Database.registerCaptureSpec(baseTable, { extraColumns })` (typically at
plan-compile time). PK columns are always retained; `extraColumns` is the
union of non-PK columns any active spec needs. The returned dispose handle
removes that spec from the union; capture demand for a table is fully
released once all specs are disposed.

A `'row'` binding whose chosen key is the table's primary key needs no
extra capture — PK is always present. A `'row'` binding picked from a
covered non-PK unique key (and any `'group'` binding) registers the
non-PK columns it cares about so the values needed to bind at COMMIT are
preserved. The shared merge state machine in `TransactionManager` keeps
the earliest `oldProjection` for the row across both intra-layer activity
and savepoint RELEASE — per-group dispatch always sees a row's
pre-transaction state, even after a chain of updates inside savepoints.

### Recording changes

The DML emitter passes the full pre- and post-image rows plus PK indices to
`TransactionManager.recordInsert/Update/Delete`. The manager:
- Always retains the PK projection.
- Retains the registered `extraColumns` projection if any consumer has demand
  on that table.
- For UPDATEs, retains both OLD and NEW projections when any captured column
  changed value — making group-membership transitions visible to per-group
  dispatch.

The change log is layered for savepoints; SAVEPOINT pushes a new layer,
ROLLBACK TO discards, RELEASE merges with last-write-wins (delete-after-insert
collapses to no entry, insert-then-update keeps INSERT semantics with the
refreshed projection, etc.).

### Reading changes at COMMIT

`DeltaExecutor` iterates registered subscriptions, computes the per-relation
binding tuples via `getChangedTuples(base, columnIndices, pkIndices)`, and
calls each subscription's `apply`. Cost fallback: if the number of distinct
binding tuples exceeds `tuning.deltaPerRowFallbackRatio × estimatedRows(base)`,
the kernel demotes that relation to global re-evaluation.

The kernel runs only at top-level COMMIT — savepoints are seen indirectly via
the merged change log. How an `apply` exception is handled is the consumer's
choice, not the kernel's: the kernel surfaces it unchanged. The assertion
consumer registers its executor on the pre-commit path, so a thrown violation
propagates and rolls the COMMIT back; the `Database.watch` consumer runs its
executor *after* commit and swallows handler errors (logged, never fatal) —
the transaction has already durably committed by then.

## BindingMode

`extractBindings(plan)` walks a plan and emits a `PlanBindings` describing,
per `TableReferenceNode` instance, how the plan binds to changes on its
underlying base table:

```ts
type BindingMode =
  | { kind: 'global' }
  | { kind: 'row'; keyColumns: number[] }      // output-column indices
  | { kind: 'group'; groupColumns: number[] }; // output-column indices
```

- `'row'` picks the table's primary key when it's among the covered keys,
  else the lex-min covered key (by length then by joined indices). Candidate
  keys come from the unified `keysOf` surface (`planner/util/fd-utils.ts`) —
  declared `RelationType.keys`, FD-derived keys, the `∅ → all_cols` ≤1-row
  empty key `[]`, and the all-columns set key — not declared keys alone. This
  lets the binder pick a *tighter* key than the declared one: an FD-derived key
  (e.g. `{a}` from `CHECK (a = b)`) subsumes the all-columns key, so a covering
  equality binds on the single column instead of the full row. (Note: because
  every base table carries Quereus' implicit all-columns PK, and every
  FD-derived key is a superkey that is covered exactly when the all-columns key
  is, this sourcing does **not** flip the `'row'`/`'global'` classification on
  the equality path — it refines the chosen key and normalizes ≤1-row
  references to the empty key, below.) Coverage then expands the
  equality-covered column set under FD closure (local FDs + FK→PK /
  equality-derived ECs) and checks each candidate key against it.
  - An **empty `keyColumns`** (`{ kind: 'row'; keyColumns: [] }`) means
    "≤1 row, no key filter needed". Downstream consumers treat it as a sound
    full/global scan: the delta executor re-evaluates that relation globally,
    `change-scope` reports a `full` watch scope, and the assertion residual
    leaves the `TableReferenceNode` unwrapped. All three are equivalent for a
    ≤1-row table.
- `'group'` reads the minimal `GROUP BY` column subset from
  `analyzeRowSpecific.groupKeys`. It already lives in the table reference's
  output-column space.
- `'global'` means the kernel has no safe binding to parameterize on; the
  consumer evaluates its full plan once when any dependency changes.

## First consumer: AssertionEvaluator

On first reference to an assertion at COMMIT time:
1. Parse and optimize the violation SQL for analysis (pre-physical).
2. Run `extractBindings` to get `PlanBindings`.
3. Register projection capture for the union of group-key columns per base
   table (`'row'` bindings need no extra capture).
4. For each `'row'`/`'group'` binding, inject a key-equality filter on the
   `TableReferenceNode` (`injectKeyFilter`) and pre-compile the residual
   scheduler. Parameter prefix is `pk` for row bindings, `gk` for group.
   Per-column NULL safety: each nullable key column emits the NULL-safe
   form (`(col IS NULL AND :prefix_i IS NULL) OR col = :prefix_i`) so a
   changed NULL-keyed tuple is re-evaluated rather than silently skipped;
   NOT NULL columns keep the plain `col = :prefix_i` form to avoid
   disjunctive predicates on the hot path. This rule applies uniformly to
   both row and group bindings — typical PK-bound row residuals stay
   textually identical to before, group residuals retain NULL-safe
   equality on their (typically nullable) group-by columns, and the
   fallback case where a row binding lands on a nullable UNIQUE column
   is now correctness-safe.
5. Register a `DeltaSubscription` whose `apply`:
   - For each per-relation tuple batch, runs the cached residual scheduler
     once per tuple (early-exiting on the first violating row).
   - For any `globalRelations` entry, runs the full violation SQL once.

`DROP ASSERTION` or schema changes invalidate the cached entry — including
dispatch handle, capture demand, and residual schedulers.

## Second consumer: Database.watch

`Database.watch(scope, handler)` registers a post-commit reactive callback
against a public, JSON-serializable `ChangeScope` (see
[Change-scope Documentation](change-scope.md)). The watcher manager
(`src/core/database-watchers.ts`) owns its own `DeltaExecutor` and is the
reference example of the plug-in pattern below:

- `subscriptionFromChangeScope` (in `delta-executor.ts`) translates the public
  `ChangeScope` into a `DeltaSubscription`, mapping each watch to a
  `BindingMode` (`full` → `global`, `rows`/`rowsByGroup` → `row`/`group` with
  literal-value narrowing, `groups` → `group`) and registering capture demand
  for any non-PK key/group columns.
- The manager runs its executor **after** commit, so a throwing handler is
  logged and dropped rather than rolling anything back.
- Schema changes (`table_removed` / `table_modified`) invalidate affected
  subscriptions; `unsubscribe()` releases the kernel registration and all
  capture-spec demand.

Watchers prove the kernel is genuinely consumer-neutral: same binding
extraction, same capture demand, same cost fallback — only the commit-phase
placement and error policy differ from assertions.

## Third consumer: MaterializedViewManager

`src/core/database-materialized-views.ts` maintains `on-commit-incremental`
materialized views ([Materialized Views § Incremental refresh](materialized-views.md#incremental-refresh)).
It owns its own `DeltaExecutor` and runs **after** commit alongside watchers —
but where a watcher fires a handler, the MV subscription's `apply` **writes** the
backing table: per affected binding it issues a delete-then-upsert (the recomputed
slice), and on a `'global'` binding or cost-fallback it rebuilds the backing
wholesale (`replaceBaseLayer`, the manual-refresh path). The write path bypasses
the user read-only boundary via `MemoryTableManager.applyMaintenance`
(against the committed base layer, under the SchemaChange latch, off the
user-transaction path). `applyMaintenance` processes an ordered batch of
`MaintenanceOp`s:

- **`delete-key`** — remove the row with this exact backing primary key (the
  common per-binding delete; the recomputed slice's old rows).
- **`delete-by-prefix`** — remove *every* row whose leading `prefixLength`
  primary-key columns equal `prefix`. The lateral-TVF fan-out half: one base-row
  change maps to many backing rows sharing a base-PK prefix, which a single
  `delete-key` cannot express. The leading prefix columns are guaranteed ascending
  by the compile-time gate, so the matching rows form a contiguous run that
  `applyMaintenance` seeks to and forward-scans (mirroring `scanLayer`'s
  prefix-range early-termination), collecting matches before deleting so the scan
  never mutates the tree it walks.
- **`upsert`** — replace (or insert) the row sharing this row's PK; the recomputed
  slice's new rows.

On a `'global'` binding or cost-fallback the manager instead rebuilds the backing
wholesale (`replaceBaseLayer`, the manual-refresh path). A failing `apply` logs
and skips — the user's commit stands.

Two MV-specific wrinkles diverge from the watcher template:

- **Bindings are derived, not extracted.** `extractBindings`' 'row'/'group'
  classification is *equality-pinned* — it reports a bare MV scan, and a
  `GROUP BY` over non-key columns, as `'global'`. MV maintenance instead binds on
  source *identity*: a row-preserving body binds `'row'` on the source PK; a
  single-source aggregate binds `'group'` on the bare `GROUP BY` columns. The
  manager builds the `BindingMode` map directly and hands it to the same kernel.
  A **recursive-CTE** body is the deliberate exception: `compile()` binds *every*
  source `'global'` (no per-binding residual is built), because a fixpoint has no
  bounded per-binding slice — a single changed source row can ripple through
  arbitrarily many iterations. Any source change therefore routes through the
  global branch (`rebuildBacking`), re-deriving the whole MV — always correct, not
  algorithmically incremental (see
  [Materialized Views § Eligibility](materialized-views.md#eligibility-checked-at-create-time);
  true delta evaluation is tracked in `materialized-view-recursive-semi-naive-delta`).
- **`apply` writes, so it needs a delete key.** The binding tuple is projected
  onto the backing table's physical PK via attribute provenance (passthrough ids
  forward; aggregate group-by ids resolve through the aggregate's producing
  expression). When the projection isn't clean (e.g. an `order by`-seeded physical
  PK), the relation falls back to a full rebuild — always correct.
- **Lateral-TVF fan-out uses a bounded *prefix* delete.** When a single base
  source feeds one correlated lateral TVF, the exact delete key is unavailable
  (the backing PK includes TVF-output columns), but `compile()` can still bound
  the delete by the base-PK prefix when (1) the base PK is a leading ascending
  prefix of the backing PK (prefix isolation) and (2) the TVF's
  `relationalAdvertisement` proves the TVF-derived backing-PK portion is a
  superkey of the TVF output (fan-out set-ness). It then emits `delete-by-prefix`
  + upserts per changed base row, converging arity-changing fan-outs that the
  exact-delete path could not. If either fact is unprovable the relation falls
  back to a full rebuild — see
  [Materialized Views § Eligibility](materialized-views.md#eligibility-checked-at-create-time).

The residual-injection machinery (`injectKeyFilter`) is shared with assertions in
`src/planner/analysis/key-filter.ts`.

### Cascading convergence (MV-over-MV) in one pass

When an incremental MV's body reads *another* incremental MV's backing table
(`mv2 as select … from mv1` resolves to `sqlite_mv_mv1`), the whole chain
converges in a single post-commit pass. Two seams on the otherwise consumer-
neutral kernel make this possible — both opt-in, so assertions and watchers
(which call `runAll()` with no options) are unaffected:

- **`runAll({ order, rescanPerSubscription })`.** `order` reorders the
  subscription snapshot; `rescanPerSubscription` recomputes
  `ctx.getChangedBaseTables()` before each `runOne`, so a producer's `apply` that
  grows the change source is visible to later subscriptions in the same pass.
- **`DeltaExecutorContext.isGloballyChanged?(base)`.** When a base changed
  opaquely (a producer rebuilt wholesale), `runOne` flags any relation on it for
  global re-evaluation instead of fetching per-tuple deltas.

The `MaterializedViewManager` drives both with manager-owned per-pass state, all
reset at the top of `runPostCommit`:

- **Topological order.** Edges run producer-backing-base → consumer (Kahn's
  algorithm over the incremental entries; rank cached, invalidated on
  register/unregister). The MV-dependency graph is a DAG — a body is fixed at
  create and any upstream MV must already exist — so a single ordered pass
  converges any chain. A (structurally impossible) cycle logs a diagnostic and
  falls back to insertion order rather than looping unbounded.
- **Delta overlay change source.** `getChangedBaseTables()` returns the
  TransactionManager set ∪ this pass's backing-table deltas (`pendingDelta`) ∪
  wholesale-rebuilt bases (`globallyChangedBacking`). `getChangedTuples(base, …)`
  reads the overlay when `base` is a captured backing table (projecting the
  requested columns out of the captured full rows, with the same insert→new,
  delete→old, update→old&new emission and de-dup as the change log) and delegates
  to the change log otherwise. Backing-table names use the reserved `sqlite_mv_`
  prefix, so per-base routing never collides with user tables.
- **Capture on write.** A producer's per-binding `apply` reads each touched
  backing row just before and just after its (synchronous, latched)
  `applyMaintenance`, synthesizing an insert/update/delete overlay change keyed by
  serialized PK. Any full rebuild instead marks the backing base in
  `globallyChangedBacking`, forcing dependents to rebuild (always correct). A
  `delete-by-prefix` batch (lateral-TVF fan-out) is treated like a wholesale
  rebuild for capture: it touches an unbounded set of backing PKs the per-row
  before/after capture cannot enumerate from the op, so the producer marks its
  backing `globallyChangedBacking` and dependents re-evaluate in full (a finer
  per-row fan-out capture is a later optimization). A Tier-2 divergence (even the
  rebuild failed) records nothing — see the cascading-divergence caveat in
  [Materialized Views § Limitations](materialized-views.md#limitations).

## Row-time write-through (synchronous, off the kernel)

A `row-time` materialized view ([Materialized Views § Row-time refresh](materialized-views.md#row-time-refresh))
is **not** a kernel consumer. The post-commit `DeltaExecutor` path above defers a
*delta computed from the change log* to COMMIT; row-time instead maintains the
backing table **synchronously, within the writing transaction**, driven from the
runtime DML write boundary (`runtime/emit/dml-executor.ts`) immediately after each
`_recordInsert/_recordUpdate/_recordDelete`. The distinction matters:

- **No `DeltaSubscription`, no residual scheduler, no change-log read.** Row-time
  is gated to the covering-index shape, where each source row maps to exactly one
  backing row, so the per-row backing delta is a pure projection of the changed
  row (delete old image's key, upsert new image) — bounded O(log n), no body
  re-execution. The `MaterializedViewManager` holds these plans in a separate map
  keyed by source base (`maintainRowTime`), not in the incremental subscription
  set.
- **In-transaction, reads-own-writes, no `pendingDelta` overlay.** The write goes
  to the backing table's *pending* `TransactionLayer` through the same connection a
  `select` from the MV uses (via `MemoryTableManager.applyMaintenanceToLayer`), so
  a later read in the same transaction sees it for free — the row-time analogue of,
  and replacement for, the post-commit `pendingDelta` cascade overlay. It commits /
  rolls back in lockstep with the source write via the coordinated commit.

So the post-commit `pendingDelta` overlay and `globallyChangedBacking` machinery
above are specific to the *post-commit* (`on-commit-incremental`) cascade; row-time
needs neither because the shared transaction layer already gives it
reads-own-writes within the commit.

## Plug-in pattern for future consumers

A new consumer follows the same shape — `Database.watch` and the
`MaterializedViewManager` (above) are the live templates; both surface a
registration path on `Database`:

```ts
// 1. Analyze the consumer's plan.
const bindings = extractBindings(plan);

// 2. Register projection capture demand for non-PK columns.
const disposers: Array<() => void> = [];
for (const [relKey, mode] of bindings.perRelation) {
  if (mode.kind === 'group') {
    const base = bindings.relationToBase.get(relKey)!;
    disposers.push(db.registerCaptureSpec(base, {
      extraColumns: new Set(mode.groupColumns),
    }));
  }
}

// 3. Build a residual scheduler per binding via injectKeyFilter equivalent.

// 4. Register a DeltaSubscription with the kernel.
const dispose = deltaExecutor.register({
  id: 'view:my_view',
  dependencies: /* set of base tables in plan */,
  bindings: bindings.perRelation,
  relationToBase: bindings.relationToBase,
  pkIndicesByBase: /* PK indices per base table */,
  async apply(input) {
    // Per-relation: bind tuples, run the residual, persist results.
    for (const [relKey, tuples] of input.perRelationTuples) { /* ... */ }
    // Global: re-run the full plan once.
    if (input.globalRelations.size > 0) { /* ... */ }
  },
  dispose() { for (const d of disposers) d(); },
});
```

### Design decisions worth knowing

- **Projection capture, not full-row capture.** Workloads without any active
  consumer pay only PK capture. Adding a consumer mid-transaction can't see
  retroactive projections — forbid mid-transaction subscription registration
  (today's consumers register at plan-compile or DDL time, not at run time).
- **Per-subscription residual cache.** Plan-shape generation is consumer-
  specific (violation-query SQL vs MV refresh). A shared cache would have to
  negotiate eviction.
- **Cost fallback by ratio.** The current threshold (`0.5`) is a first cut;
  a real cost comparator is a follow-up.

## Cross-references

- Optimizer surface: [Optimizer § Binding-aware Delta Planning](optimizer.md#binding-aware-delta-planning-reusable)
- Public reactive API: [Change-scope Documentation](change-scope.md)
- Layered schemas / lenses: [Lenses and Layered Schemas](lens.md)
- Source: `src/planner/analysis/binding-extractor.ts`, `src/planner/analysis/key-filter.ts`, `src/runtime/delta-executor.ts`, `src/core/database-transaction.ts`, `src/core/database-assertions.ts`, `src/core/database-watchers.ts`, `src/core/database-materialized-views.ts`
- Keyed derived relations / covering structures: [Materialized Views](materialized-views.md) (manual full-refresh, `on-commit-incremental`, and synchronous `row-time` write-through maintenance)
- Cross-process reactive transport: out of scope here; see the sync packages
  under `packages/quereus-sync-*`.
