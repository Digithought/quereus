---
description: Build a reusable DeltaExecutor kernel with FD-aware binding-key extraction, projection-capture in ChangeCapture, and migrate the assertion COMMIT path to it so 'group' classifications finally drive per-group-key residual execution instead of falling back to global.
prereq:
files:
  - packages/quereus/src/planner/analysis/binding-extractor.ts (new)
  - packages/quereus/src/runtime/delta-executor.ts (new)
  - packages/quereus/src/core/database-transaction.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/func/builtins/explain.ts
  - packages/quereus/test/optimizer/binding-extractor.spec.ts (new)
  - packages/quereus/test/incremental/delta-executor.spec.ts (new)
  - packages/quereus/test/logic/95-assertions.sqllogic
  - docs/optimizer.md
  - docs/architecture.md
  - docs/incremental-maintenance.md (new)
---

## Goal

Generalize the assertion delta machinery into a reusable kernel that any change-driven
consumer (assertions today; materialized views, reactive signals, triggers tomorrow) can
register against. Land the kernel, wire the assertion path to it as the first consumer,
and remove the `TODO(fd-view-maintenance-binding-keys)` global-fallback for `'group'`
classifications. Materialized-view DDL and storage remain out of scope — see
`tickets/backlog/4-materialized-views.md`.

The relevant `RowSpecificResult { classifications, groupKeys }` produced by
`analyzeRowSpecific` already carries everything we need on the optimizer side; what's
missing is (a) a value source for changed group keys at COMMIT, and (b) a kernel that
dispatches per-binding without each consumer rewriting the same loop.

## Architecture

### Components and data flow

```
DML emitter ──recordInsert/Update/Delete(row)──► TransactionManager (ChangeCapture)
                                                  │
                                                  │  (per-table projection registry
                                                  │   resolves PK + extra cols at
                                                  │   write time)
                                                  ▼
            on COMMIT ───────────────────► DeltaExecutor
                                                  │
                                  iterate subscriptions; for each:
                                  │   lookup BindingMode per dep table
                                  │   for 'row'/'group': fetch projected tuples
                                  │   for 'global': single-shot
                                                  ▼
                                          Subscription.apply(changes)
                                                  │
                                                  └─► assertion residual, future MV refresh, etc.
```

### BindingMode and BindingExtractor

New analyzer module `packages/quereus/src/planner/analysis/binding-extractor.ts`:

```ts
export type BindingMode =
  | { kind: 'global' }
  | { kind: 'row'; keyColumns: number[] }      // output-column indices on the table reference
  | { kind: 'group'; groupColumns: number[] }; // output-column indices on the table reference

export interface PlanBindings {
  /** For each TableReference instance in the plan, how this plan is bound to its changes. */
  perRelation: Map<string /* relationKey */, BindingMode>;
  /** Convenience: relationKey → base table name (lowercased schema.table). */
  relationToBase: Map<string, string>;
}

export function extractBindings(plan: RelationalPlanNode | PlanNode): PlanBindings;
```

`extractBindings`:

- Runs `analyzeRowSpecific(plan)` and walks the plan once to gather `TableReferenceNode`
  instances (replicates the existing `collectTables` walk).
- For each `relationKey`:
  - If `classifications.get(relKey) === 'row'`: read the covered unique key columns via
    the existing `extractCoveredKeysForTable(plan, relKey)` helper and choose the first
    covered key (today: PK preferred when present, else the lex-min covered key — keep
    the same selection as `database-assertions.ts:185`). `keyColumns` is that key.
  - If `'group'`: `groupColumns` = `groupKeys.get(relKey)` (already in table-output-column
    space).
  - If `'global'`: `{ kind: 'global' }`.

No new optimizer math here — this is purely a packaging/translation layer over the
previous ticket's output.

### ChangeCapture: column-projection support

Current shape (in `core/database-transaction.ts`): per-base-table set of serialized PK
tuples. To support `'group'` mode the kernel must know the **values** of the group-key
columns for each changed row (including the OLD values on DELETE/UPDATE-with-group-change).

Approach: **projection capture, on demand.** The DeltaExecutor registers, per base table,
the union of column indices any subscription cares about (PK is always implicit). The
TransactionManager exposes:

```ts
interface CaptureSpec {
  /** Column indices on the base table (PK columns are always captured implicitly). */
  extraColumns: ReadonlySet<number>;
}

class TransactionManager {
  /** Register/unregister projection demand for a base table. Returns a dispose handle. */
  registerCaptureSpec(baseTable: string, spec: CaptureSpec): () => void;

  /** Per-row capture API replacing the bare PK variants. The full row is passed; only
   *  PK + currently-registered extraColumns are retained. */
  recordInsert(baseTable: string, newRow: Row, pkIndices: number[]): void;
  recordUpdate(baseTable: string, oldRow: Row, newRow: Row, pkIndices: number[]): void;
  recordDelete(baseTable: string, oldRow: Row, pkIndices: number[]): void;

  /** What the kernel reads at COMMIT. */
  getChangedTuples(base: string, columnIndices: readonly number[]): Iterable<SqlValue[]>;
}
```

Notes on the shape:

- Capture is **opt-in by column-set**: when no consumer has registered a non-empty
  `extraColumns`, only PK is stored — preserving today's footprint for plain workloads.
- On UPDATE: if any captured column (including PK) changes value, both OLD and NEW
  projections are recorded. Otherwise a single tuple suffices (idempotent set semantics).
  This is what makes group-membership transitions visible to per-group refresh
  ("customer 5 lost an order" → its group key must be re-evaluated even if customer 5
  has no rows left).
- Storage: replace the inner `Set<string>` of PK-only with `Map<string /* PK */,
  CapturedRow>` where `CapturedRow` carries `{ op: 'insert' | 'update' | 'delete';
  oldProjection?: SqlValue[]; newProjection?: SqlValue[] }`. Serialization of the PK
  key remains the JSON string used today. Savepoint layers carry the same shape;
  RELEASE merges with last-write-wins per PK except that DELETE-after-INSERT collapses
  to no-op (already implied by today's set semantics, but explicit now since op kind
  matters for `getChangedTuples`).
- `getChangedKeyTuples(base)` stays for back-compat with anything not yet migrated, but
  the assertion path moves to `getChangedTuples(base, columns)`.

The DML emitter changes are mechanical: pass the full `oldRow`/`newRow` (already in
scope at each call site in `dml-executor.ts`) plus `pkIndices` to the new signatures.

### DeltaExecutor kernel

New module `packages/quereus/src/runtime/delta-executor.ts`:

```ts
export interface DeltaSubscription {
  /** Diagnostic id, e.g. "assertion:no_negative_balance" or "view:orders_per_customer". */
  readonly id: string;
  /** Base tables this subscription depends on (lowercased "schema.table"). */
  readonly dependencies: ReadonlySet<string>;
  /** BindingMode per dependency relationKey instance (from BindingExtractor). */
  readonly bindings: ReadonlyMap<string /* relationKey */, BindingMode>;
  /** relationKey → base table (from PlanBindings). */
  readonly relationToBase: ReadonlyMap<string, string>;
  /** Invoked with per-relation binding-tuple batches. */
  apply(input: DeltaApplyInput): Promise<void>;
  /** Free any external resources (cached plans, captures, etc.). */
  dispose(): void;
}

export interface DeltaApplyInput {
  /** For 'row'/'group' bindings: the parameter tuples to bind for that relationKey.
   *  Order matches the BindingMode's keyColumns/groupColumns. */
  readonly perRelationTuples: ReadonlyMap<string /* relationKey */, readonly SqlValue[][]>;
  /** RelationKeys that should be re-evaluated globally because their dependency changed
   *  AND the mode is 'global', or because a fallback was triggered. */
  readonly globalRelations: ReadonlySet<string>;
}

export class DeltaExecutor {
  constructor(private readonly ctx: DeltaExecutorContext) { }
  register(sub: DeltaSubscription): () => void;
  /** Run all impacted subscriptions for the current commit. */
  async runAll(): Promise<void>;
}
```

`runAll()` algorithm:

1. Snapshot `changedBases = ctx.transactionManager.getChangedBaseTables()`.
2. For each subscription:
   - Compute `impactedDeps = sub.dependencies ∩ changedBases`. Skip if empty.
   - For each relationKey in `sub.bindings`:
     - Let `base = sub.relationToBase.get(relKey)`. Skip if `!changedBases.has(base)`.
     - Switch on the binding mode:
       - `global`: add to `globalRelations`.
       - `row { keyColumns }`: project the PK tuples for that base into the keyColumns
         order (a no-op when keyColumns is the PK itself; otherwise via the table's
         column index map). De-duplicate. Push to `perRelationTuples[relKey]`.
       - `group { groupColumns }`: read changed tuples projected onto `groupColumns`.
         De-duplicate. Push.
   - Apply cost-fallback (next paragraph), then invoke `sub.apply(input)`.
3. Wrap each subscription's `apply` in a try/catch that re-throws so the COMMIT path
   rolls back; do not eat exceptions.

**Cost fallback to global re-evaluation.** Before invoking `apply`, count distinct
binding tuples per relationKey. If `distinctTuples >= tableRowCount * tuning.deltaPerRowFallbackRatio`
(default `0.5`) AND the subscription provides a `globalCost` estimate that beats the
sum of per-tuple costs, demote that relationKey from `'row'`/`'group'` to `'global'` for
this run. The first cut can implement this as a simple ratio check using
`PhysicalProperties.estimatedRows` from the cached plan; refining the cost comparison
is left for follow-up.

**Cache key.** Subscriptions own their own residual plan cache keyed by
`(relationKey, BindingMode.kind, columnArrayJoined)` — there's no shared cache, since
plan-shape generation is consumer-specific (assertion-violation SQL vs MV-refresh).

### Savepoint awareness

Inherited from ChangeCapture: the captured projections live in the same layered
structure as PK tuples; SAVEPOINT pushes a new layer, ROLLBACK TO discards, RELEASE
merges with last-write-wins (delete-after-insert collapse). The kernel runs only at
top-level COMMIT, so it sees the net effect — no intra-savepoint dispatch needed.

### Assertion path migration

`AssertionEvaluator.runGlobalAssertions()` becomes:

1. For each assertion (cached or freshly compiled):
   - Build `PlanBindings = extractBindings(analyzedPlan)`.
   - For each `relationKey` with `bindings.kind === 'group'`: pre-compile a residual
     variant by injecting `FilterNode(table.col_i = :gk{i})` on the underlying
     `TableReferenceNode` (mirror `injectPkFilter` but for arbitrary column lists; rename
     the existing helper `injectKeyFilter(plan, relKey, columns, paramPrefix)` and reuse
     it for both `'row'` and `'group'`).
   - Register projection capture demand: for each `'group'` binding, the union of group
     columns gets registered with `TransactionManager.registerCaptureSpec`. Done at
     plan-compile time inside `getOrCompilePlan`; the dispose handle is held on the
     cached entry and freed on `invalidateAssertion`/`dispose`.
   - Construct a `DeltaSubscription` whose `apply` runs the pre-compiled residual N
     times per relationKey, mirroring the existing `executeViolationPerChangedKeys` but
     parameterized as `gk0`, `gk1`, ... for group bindings (still `pk0`, `pk1`, ... for
     row bindings).

2. The `TransactionManagerContext.runGlobalAssertions()` call delegates to
   `DeltaExecutor.runAll()`, which dispatches to each assertion subscription.

3. Remove the `requiresGlobal` short-circuit-on-group fallback in `evaluateAssertion`
   (lines 226-237). `'group'` now drives parameterized execution; only `'global'` (and
   the cost-fallback case) take the unparameterized path.

`explain.ts` keeps emitting `'group'` + group-key column names in `prepared_pk_params`
(no diagnostic change), but the `'group'` paths are now actually executed by the
runtime — update the inline doc on lines 226-227 of `database-assertions.ts` and the
deferred-runtime caveat in `docs/optimizer.md:1334` and `:1398`.

### Out-of-scope handling for the materialized-view consumer

The plan mentions wiring `MaterializedViewSchema` as a kernel consumer. Materialized
view DDL/storage doesn't exist yet (`tickets/backlog/4-materialized-views.md`), so this
ticket does **not** add a `MaterializedViewSchema` type or registration path. The
DeltaExecutor's public surface is shaped so the future MV ticket can plug in by:

1. Defining `MaterializedViewSchema` (separate work).
2. On view creation: call `BindingExtractor.extractBindings(viewSelectPlan)`, register
   one `DeltaSubscription` whose `apply` does delete-then-upsert into the backing
   table per binding tuple.

A short pointer block in `docs/incremental-maintenance.md` describes the integration
shape so the MV ticket can pick it up without rediscovery.

## Design decisions worth surfacing

These are the calls made above that are easy to revisit if the implementer hits
friction; flag them in the review handoff if you deviate.

- **Projection capture, not full-row capture.** Cheaper and avoids changing the
  on-write storage model for tables without registered consumers. Tradeoff: when a new
  subscription registers mid-transaction (unlikely today; theoretically possible via a
  future `CREATE ASSERTION` inside a txn), it can't see retroactive captures. Document
  this explicitly; the simple fix is to forbid mid-transaction subscription registration
  for now.
- **Per-subscription residual cache, not shared.** Each consumer owns its keys/shapes,
  and a global cache would need to negotiate eviction. Revisit when a second consumer
  lands and a duplication pattern emerges.
- **Cost fallback by ratio, not full plan comparison.** A first-cut threshold (`0.5`)
  in `tuning` is enough to avoid pathological per-row dispatch when ~everything changed.
  A real cost comparator is a follow-up (`tickets/backlog/3-incremental-delta-runtime.md`
  has space for it; close that backlog ticket once this lands and the work is captured
  here).

## Phased TODO

### Phase 1 — Plumbing

- Update `TransactionManager` (`database-transaction.ts`):
  - Replace inner `Set<string>` (PK-only) with `Map<string /* PK JSON */, CapturedRow>`
    where `CapturedRow = { op; oldProjection?; newProjection? }`.
  - Add `registerCaptureSpec(baseTable, { extraColumns }): () => void`. Maintain a
    union of currently-registered column sets per base table.
  - Change `recordInsert/recordUpdate/recordDelete` signatures to take the row(s) +
    `pkIndices`; internally derive PK and project the registered extra columns.
  - Add `getChangedTuples(base, columnIndices)` returning de-duplicated tuples projected
    onto `columnIndices` across all layers and ops. For UPDATE, yield both OLD and NEW
    projections when any captured column changed.
  - Keep `getChangedKeyTuples(base)` as a back-compat thin wrapper over
    `getChangedTuples(base, pkIndices)`.
  - Adjust savepoint layer push/pop/release to preserve the new value shape (currently
    set-merge becomes map-merge with last-write-wins; DELETE-after-INSERT collapses to
    no entry — verify via savepoint tests).
- Update `dml-executor.ts` and any other `_recordInsert/_recordUpdate/_recordDelete`
  callers: pass full rows + PK column indices. The rows are already in scope at each
  call site; this is a mechanical change.
- `Database._recordInsert/...` thin wrappers in `core/database.ts` get the new
  signatures.

### Phase 2 — BindingExtractor

- New file `packages/quereus/src/planner/analysis/binding-extractor.ts`:
  - Implement `extractBindings(plan)` returning `PlanBindings`.
  - For `'row'`: pick the same key the assertion path picks today (PK preferred via
    `tableSchema.primaryKeyDefinition.map(d => d.index)`, falling back to first covered
    key from `extractCoveredKeysForTable`).
  - For `'group'`: copy `groupKeys.get(relKey)`.
- Unit tests `test/optimizer/binding-extractor.spec.ts`:
  - Plain SELECT with PK equality → `'row'` with keyColumns = PK indices.
  - SELECT with equality on a UNIQUE non-PK column → `'row'` with the covered key
    selection (assert deterministic).
  - GROUP BY query → `'group'` with `groupColumns` matching `analyzeRowSpecific.groupKeys`.
  - Join with one side row-covered, other side group-covered → independent BindingMode
    per relationKey.

### Phase 3 — DeltaExecutor kernel

- New file `packages/quereus/src/runtime/delta-executor.ts`:
  - `DeltaSubscription` / `DeltaApplyInput` / `DeltaExecutor` per the shapes above.
  - `DeltaExecutorContext` exposes the slice of `Database` the kernel needs:
    `getChangedBaseTables()`, `getChangedTuples(base, cols)`, optionally
    `getRowCount(base)` for the cost ratio.
- `tuning` option: `deltaPerRowFallbackRatio` (default `0.5`) in `core/database-options.ts`
  alongside existing tuning knobs.
- Tests `test/incremental/delta-executor.spec.ts`:
  - Subscription with `'row'` binding receives correct per-row tuples on INSERT/UPDATE/
    DELETE (mock `apply` records calls).
  - Subscription with `'group'` binding receives de-duplicated per-group tuples when
    multiple rows in the same group change.
  - UPDATE that changes a row's group-key value yields *both* OLD and NEW group tuples
    to `apply` (group-membership transition).
  - `'global'` binding fires once per affected dependency.
  - Multi-dependency subscription (binds different modes per relationKey) gets the
    right batch shape.
  - Cost fallback: when changed distinct tuples >= ratio × estimatedRows, the
    subscription gets `globalRelations` entry instead of per-tuple.
  - Savepoint: ROLLBACK TO SAVEPOINT after some changes; only post-savepoint changes
    remain visible at COMMIT.
  - Exception in `apply` propagates (no swallowing).

### Phase 4 — AssertionEvaluator migration

- Generalize the existing `injectPkFilter` to `injectKeyFilter(block, relKey, columns,
  paramPrefix)`. Existing `'row'` callsite uses `pkIndices, 'pk'`; new `'group'`
  callsite uses `groupColumns, 'gk'`.
- `getOrCompilePlan` now produces residual artifacts for both `'row'` and `'group'`
  relations. Cache entry tracks the `registerCaptureSpec` dispose handle (the union of
  group columns is the projection demand). On `invalidateAssertion`/`dispose`, call it.
- `AssertionEvaluator` constructs and registers one `DeltaSubscription` per assertion
  on first compile; `Database.runGlobalAssertions` delegates to
  `DeltaExecutor.runAll()`. Drop `evaluateAssertion`'s `requiresGlobal` fallback that
  treats `'group'` as `'global'`; the kernel now handles dispatch.
- Update the TODO at `database-assertions.ts:226-227` — remove (work landed).
- Tests:
  - Re-run `test/logic/95-assertions.sqllogic`; existing `'row'`/`'global'` cases stay
    green. Add an `explain_assertion` case for a `'group'` assertion that asserts the
    `prepared_pk_params` column lists the group-key column names AND the assertion now
    runs through the parameterized path (assert via a sample assertion that would scan
    the whole table in `'global'` mode but only touches one group when the dispatch is
    parameterized — verify via a probe: an assertion whose violation predicate references
    a side-effect-tracking table).
  - New stress case: an assertion using `'group'` mode does O(changed_groups) residual
    runs, not O(total_groups). Use a base table with 100 groups, mutate one row in one
    group, assert one residual execution.

### Phase 5 — Docs

- `docs/optimizer.md` § *Binding-aware Delta Planning (Reusable)* (lines 1392–1420):
  flesh out with the concrete kernel design, `BindingMode` shape, projection-capture
  rationale, cost-model fallback. Replace the deferred-runtime caveat language with
  current-state.
- Update the `'group'` caveat in § *Classification API* (line 1334) and § *Modes of
  Specificity* (line 1398) — runtime is now wired.
- `docs/architecture.md`: short paragraph under the assertion/constraint section
  pointing to `incremental-maintenance.md` for the reusable kernel.
- New `docs/incremental-maintenance.md`:
  - Architecture: ChangeCapture → DeltaExecutor → Subscription.
  - Lifecycle: subscription registration, projection-capture spec, COMMIT dispatch,
    savepoints.
  - `BindingMode` and how `BindingExtractor` produces it.
  - First consumer: AssertionEvaluator.
  - Plug-in pattern for future consumers (materialized views, reactive signals,
    triggers): expected `apply` shape, residual construction guidance, cost-model
    integration.
  - Out-of-scope cross-references: MV DDL (`tickets/backlog/4-materialized-views.md`),
    cross-process reactive transport.

### Validation

- `yarn workspace @quereus/quereus run lint` — must be clean.
- `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/dx-test.log; tail -n 80 /tmp/dx-test.log`
  — must pass. Watch in particular the assertion sqllogic file, the savepoint tests,
  and the new spec files.
- Spot-check `yarn test:store` if any change in `database-transaction.ts` could affect
  the store-backed path; skip the full sweep unless an issue surfaces.
- Once landed, close `tickets/backlog/3-incremental-delta-runtime.md` (mark superseded
  by this ticket's complete artifact).
