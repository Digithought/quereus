# Incremental Maintenance

Quereus exposes a single, reusable change-driven kernel that runs at every COMMIT.
Two consumers are live today: **assertions** (pre-commit, can roll the commit
back) and **`Database.watch` reactive signals** (post-commit, fire-and-forget).
Still to come — keyed derived relations: materialized views and covering
structures (indexes / unique-constraint enforcement), plus triggers — all of
which plug into the same surface without reinventing change capture or
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
                                            on COMMIT (precedes vtab commit)
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

## Plug-in pattern for future consumers

A new consumer follows the same shape — `Database.watch` (above) is the live
template; the keyed-derived-relation ticket will surface a shared registration
path on `Database` (see
[`tickets/backlog/known/updatable-views.md`](../tickets/backlog/known/updatable-views.md)):

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
- Source: `src/planner/analysis/binding-extractor.ts`, `src/runtime/delta-executor.ts`, `src/core/database-transaction.ts`, `src/core/database-assertions.ts`, `src/core/database-watchers.ts`
- Keyed derived relations / covering structures (planned consumer): `tickets/backlog/known/updatable-views.md`
- Cross-process reactive transport: out of scope here; see the sync packages
  under `packages/quereus-sync-*`.
