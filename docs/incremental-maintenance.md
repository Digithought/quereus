# Incremental Maintenance

Quereus exposes a single, reusable change-driven kernel that runs at every COMMIT.
Assertions are its first consumer; materialized views, reactive signals, and
triggers will plug into the same surface without reinventing change capture or
binding-key analysis.

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
                                            on COMMIT (precedes vtab commit)
                                                              ▼
                                                       DeltaExecutor
                                                              │
                            ┌─────────────────────┬──────────┴────────┐
                            │                     │                   │
                            ▼                     ▼                   ▼
                  AssertionEvaluator     [future] MV refresh    [future] signals
                  (residual scheduler    (delete-then-upsert
                   per tuple)             per binding tuple)
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

A `'row'` binding does not need any extra capture — PK is always present.
A `'group'` binding registers its group-key columns so changes preserve the
values needed to bind per-group at COMMIT.

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
the merged change log. Exceptions from `apply` propagate unchanged, causing
the COMMIT path to roll back.

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
  else the lex-min covered key (by length then by joined indices). Coverage
  uses FD closure under the table's local FDs and FK→PK / equality-derived
  ECs.
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
5. Register a `DeltaSubscription` whose `apply`:
   - For each per-relation tuple batch, runs the cached residual scheduler
     once per tuple (early-exiting on the first violating row).
   - For any `globalRelations` entry, runs the full violation SQL once.

`DROP ASSERTION` or schema changes invalidate the cached entry — including
dispatch handle, capture demand, and residual schedulers.

## Plug-in pattern for future consumers

A new consumer follows the same shape (today the kernel is owned by the
`AssertionEvaluator`; the MV ticket will surface a shared registration path
on `Database` — see [`tickets/backlog/4-materialized-views.md`](../tickets/backlog/4-materialized-views.md)):

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
- Source: `src/planner/analysis/binding-extractor.ts`, `src/runtime/delta-executor.ts`, `src/core/database-transaction.ts`, `src/core/database-assertions.ts`
- Materialized views (planned consumer): `tickets/backlog/4-materialized-views.md`
- Cross-process reactive transport: out of scope here; see the sync packages
  under `packages/quereus-sync-*`.
