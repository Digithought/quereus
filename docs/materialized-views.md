# Materialized Views

A **materialized view** in Quereus is a *keyed derived relation*: a query body
stored once into a backing relation, primary-keyed by the body's inferred key,
and addressable like any other (virtual) table. Where a plain
[view](schema.md#viewschema) re-evaluates its body on every reference, a
materialized view evaluates the body at create time, stores the result, and
serves subsequent reads from that stored copy. The default refresh policy is
**manual full-refresh**: source mutations do not update the stored rows until
an explicit `REFRESH MATERIALIZED VIEW`. An MV may instead opt into
**`on-commit-incremental`** refresh (`with refresh = 'on-commit-incremental'`),
which maintains the backing table at every COMMIT that touches a source — see
[Incremental refresh](#incremental-refresh) — or into **`row-time`** refresh
(`with refresh = 'row-time'`), which maintains the backing table *synchronously*
with each source row-write (visible mid-transaction, not at COMMIT), gated to the
covering-index shape — see [Row-time refresh](#row-time-refresh).

The refresh-policy spectrum, weakest to strongest coupling:

```
manual  →  on-commit-incremental  →  row-time
(refresh)   (post-commit delta)      (synchronous write-through)
```

This document covers the substrate as it exists today. The concurrent-refresh and
broader lens-integration extensions are tracked in
[Out of scope / roadmap](#out-of-scope--roadmap).

## Substrate: a keyed derived relation

A materialized view is realized as two cooperating schema objects:

```
CREATE MATERIALIZED VIEW mv AS <body>
        │
        ├─ backing TableSchema      "sqlite_mv_mv"   ← stored rows, real virtual table
        │     (memory module in v1; primary-keyed; hidden from user catalog)
        │
        └─ MaterializedViewSchema   "mv"             ← the name users reference
              (body AST, inferred PK, bodyHash, sourceTables, backingTableName)
```

- **Backing table.** The materialized rows live in an ordinary `TableSchema`
  registered under the reserved derived name `sqlite_mv_<name>`
  (`backingTableNameFor`). In v1 the backing module is always the in-memory
  table module; a `USING <module>(...)` clause parses and is retained for
  forward compatibility but is otherwise ignored. Backing tables are excluded
  from user-facing catalog enumeration — they are an implementation detail.

- **MV record.** A `MaterializedViewSchema` is registered in
  `Schema.materializedViews` (separate from `Schema.tables` and
  `Schema.views`). It retains the parsed body AST, the inferred logical primary
  key, the `bodyHash`, the qualified source-table dependencies, and the backing
  table's name.

- **Dual registration / name disjointness.** A name may belong to at most one of
  {table, view, materialized view} in a schema. `addTable` / `addView` reject a
  name already held by a materialized view, and `addMaterializedView` rejects a
  name already held by a table or view — enforced in both directions.

### Primary key inference (and the all-columns fallback)

The backing table's logical primary key is the **first usable key** returned by
`keysOf` over the optimized body relation (the unified FD/keys surface — see
[Optimizer § Functional Dependency Tracking](optimizer.md#functional-dependency-tracking)).
A body like `select id, x from t` (where `id` is `t`'s key) yields a clean
single-column key.

When `keysOf` yields no usable key, the materialized view falls back to the
**all-columns key** — the Quereus default for keyless relations (no rowids).
This keeps every materialized view addressable, but has two consequences:

- **Such a view is incremental-ineligible** until the Phase-2 incremental path
  lands: with the whole row as the key there is no stable identity to apply a
  delta against.
- **A materialized view must be a set.** The all-columns fallback is itself a
  legitimate key *only* when the body's rows are all distinct — a duplicate-free
  keyless body (e.g. `select y from pt` where the `y` values differ)
  materializes fine on the all-columns key. The contract is violated only when
  the body actually emits a **duplicate row** under the backing key. A v1
  materialized view is a keyed derived relation, so a duplicate-producing
  ("bag") body is rejected with a purpose-built diagnostic
  (`materializedViewNotASetError`) that names the view and explains the
  contract — *"... body produces duplicate rows, but a materialized view must be
  a set: its body needs a unique key. Add `distinct`, a `group by`/aggregation,
  or project a key column ..."* — rather than the raw
  `UNIQUE constraint failed: sqlite_mv_<name> PK` that leaked the hidden backing
  table. The diagnostic fires at `CREATE` (loud, immediate) for a body that is
  already a bag, or at the next `REFRESH` for a body that is duplicate-free at
  create but becomes duplicate-producing after source edits. This late-refresh
  failure is inherent to the bag case under set semantics: enforcement stays at
  fill time (where the collision is detected with the backing table's real,
  collation/desc/composite-correct key comparison), so keyless bodies are *not*
  statically rejected. On this create/refresh full-rebuild path Quereus does
  **not** silently de-duplicate, and does **not** synthesize a row identity.
  (The `on-commit-incremental` per-binding path is a known exception that
  *does* silently de-duplicate a late bag — see the incremental
  [Limitations](#limitations).)

> **Physical vs logical key.** The backing table's *physical*
> `primaryKeyDefinition` may lead with the body's `order by` columns (so a btree
> scan reproduces the body order), appending the logical key as a
> uniqueness-preserving tiebreaker. `MaterializedViewSchema.primaryKey` keeps
> the logical `keysOf` identity. This divergence is a v1 expedient that the
> covering-structure work replaces with a proper materialized index.

## DDL statements

Three statements manage materialized views. `MATERIALIZED` and `REFRESH` are
contextual keywords — no new reserved words are introduced.

### `CREATE MATERIALIZED VIEW`

```sql
create materialized view mv [if not exists] [(col, ...)]
  [using <module>(...)]
  as <body>
  [with refresh = 'manual' | 'on-commit-incremental' | 'row-time']
  [with tags (...)];
```

- `<body>` is any relation-producing `QueryExpr` — a `SELECT`, a bare
  `VALUES`, or a compound (`union all`, …). A DML-with-`RETURNING` body parses
  but is rejected by the planner (replaying a write per materialization is
  incoherent).
- An explicit column list renames the body's output columns (arity must match).
- `with refresh = '...'` selects the refresh policy (trailing, alongside the
  existing `with tags`; default `manual`). `on-commit-incremental` is gated to
  incrementally-maintainable bodies — see [Incremental refresh](#incremental-refresh);
  `row-time` is gated to the covering-index shape — see [Row-time refresh](#row-time-refresh).
- The body is evaluated immediately and the result stored. On any failure
  during the fill — or if an `on-commit-incremental` / `row-time` body is
  ineligible — the backing table is rolled back and the MV is **not** registered;
  a create is all-or-nothing.

### `REFRESH MATERIALIZED VIEW`

```sql
refresh materialized view mv;
```

Re-evaluates the body against current source data and atomically replaces the
backing table's contents (`replaceBaseLayer` builds a fresh base layer, guards
duplicate PKs — raising the caller-supplied "must be a set" diagnostic for a
bag MV body — and swaps it under the schema-change latch). Readers use
start-of-call snapshot isolation, so a concurrent scan sees either the old
contents or the new — never a torn state. Refresh clears the staleness flag (see
below).

### `DROP MATERIALIZED VIEW`

```sql
drop materialized view [if exists] mv;
```

Drops both the MV record and its backing table. `DROP TABLE` / `DROP VIEW`
reject a materialized-view name and redirect the user to
`DROP MATERIALIZED VIEW`; conversely `DROP MATERIALIZED VIEW` on a plain
table/view name redirects to the right statement.

## Query resolution

A reference to `mv` in a query resolves to a `TableReferenceNode` against the
**backing table**, not to a body expansion. Reads therefore go straight to the
stored rows and cost like a table scan, not like re-running the body. (An
unqualified MV reference resolves against the current schema; a materialized
view in a non-current schema must be qualified.)

## Write boundary (read-only)

A materialized view is **read-only to direct DML**. `INSERT` / `UPDATE` /
`DELETE` targeting an MV name are rejected at build time
(`assertNotMaterializedView` is wired into all three DML builders). The stored
contents change only through `REFRESH` (or a declarative rebuild). The *source*
tables remain fully writable — writing a source does not error; it simply does
not propagate until the next refresh. Write-through (`put` semantics on an MV)
is future work.

## Schema-change staleness

Manual refresh means an MV can drift from its sources between refreshes — that
is expected. But a *schema* change to a source (drop / alter) can break the body
outright. The `MaterializedViewManager` subscribes to `table_removed` /
`table_modified` change events and marks any MV whose `sourceTables` includes
the changed table as **stale**.

- On the next **reference**, a stale MV re-validates its body against the
  current source schemas. If the body no longer plans, the reference errors with
  a staleness diagnostic ("a source changed in an incompatible way — drop and
  recreate") rather than serving rows against a broken definition.
- On the next successful **refresh**, the stale flag is cleared.

Staleness tracks *structural* breakage, not data drift: ordinary source
`INSERT` / `UPDATE` / `DELETE` never set the flag. Data drift caused by a
*failed* incremental apply that could not self-heal is a **distinct** signal —
the separate `diverged` flag, which makes reads error unconditionally (the body
still plans; it is the backing data that is wrong). See
[Apply-failure recovery](#apply-failure-recovery-two-tier). Reusing `stale` for
this would not work: the stale read-path only re-validates the body against
current source *schemas*, and a body that still plans resolves to the backing
table silently — serving the diverged rows.

## Incremental refresh

An MV created `with refresh = 'on-commit-incremental'` is maintained at every
COMMIT that touches a source table — no manual refresh needed. It is the third
consumer of the reusable change-driven kernel
([Incremental Maintenance](incremental-maintenance.md)): the
`MaterializedViewManager` registers a `DeltaSubscription` whose `apply` **writes**
the backing table (delete-then-upsert per affected binding), running in the
post-commit window (change log alive, all connections committed). The user's
commit always stands — a failed apply never rolls it back (the watcher contract,
not the assertion one) — but a failure is no longer silently skipped: see
[Apply-failure recovery](#apply-failure-recovery-two-tier).

### Eligibility (checked at create time)

`on-commit-incremental` is rejected at create — rolling the MV back — unless the
body is incrementally maintainable. The accepted shapes are:

- **row-preserving** (projection / filter, no aggregate) over **one or more**
  **inner/cross-joined** sources: maintenance binds **per source** on that
  source's **primary key**. Each changed source row recomputes its affected MV
  slice. A source whose PK cleanly covers the backing physical PK maintains
  incrementally; a source that fans out (its PK does not determine the physical
  PK) falls back to a full rebuild — see [Apply contract](#apply-contract). Every
  source must have a primary key.
- **lateral table-valued function fan-out** — a single base source feeding one
  correlated lateral TVF
  (`base t cross join lateral json_each(t.arr) je`): a base-row change maps to
  MANY backing rows (the TVF's per-row fan-out), which the exact per-binding
  `delete-key` cannot express. When two facts hold the maintainer instead deletes
  the changed base row's whole fan-out by its **base-PK prefix** and re-inserts
  the recomputed fan-out (the `delete-by-prefix` maintenance op):
  1. **Prefix isolation** — the backing physical PK leads with a run of columns
     that resolve (via attribute provenance) to base-PK columns and cover *all* of
     the base PK, followed by TVF-supplied columns. The base PK is unique, so
     deleting every backing row sharing that prefix removes exactly the changed
     base row's fan-out and nothing else.
  2. **Fan-out set-ness** — the TVF's `relationalAdvertisement` proves the
     TVF-derived portion of the backing PK is a *superkey* of the TVF output
     (some advertised `keys` entry is covered by it, or `isSet` plus all TVF
     output columns present), so the per-base-row re-insert is a set on the
     backing PK and never silently collapses distinct fan-out rows.

  When either fact is unprovable — base PK not a leading prefix (e.g. a TVF column
  projected first), advertisement insufficient (no usable key, not `isSet`), or a
  non-ascending leading prefix column — the body **falls back to a full rebuild**
  (always correct, never a wrong result). Multiple base sources each feeding TVFs,
  a TVF correlated to more than one source, and nested/chained TVFs are out of
  scope (rebuild). A lateral *subquery* over a base table is **not** this shape —
  its inner tables are visible source references, so it routes through the
  inner/cross-join path above. The general fix that would let `keysOf` surface the
  keyed cross-product key (and so make this MV-local consumption unnecessary) is
  filed as `optimizer-keyed-cross-product-join-keys`.
- **single-source aggregate** with `GROUP BY` over **bare source columns**:
  maintenance binds on the **group key**. Each changed group (OLD and NEW on an
  update that moves a row between groups) is recomputed.
- **recursive CTE** (transitive closure / fixpoint) over one or more sources:
  *accepted, but maintained as a whole-MV `'global'` rebuild.* A recursive
  fixpoint has no bounded per-binding residual — a single changed source row can
  ripple through arbitrarily many iterations — so `compile()` classifies every
  source as `'global'` and any source mutation re-derives the **entire** fixpoint
  at COMMIT via `rebuildBacking` (the same recompute manual `refresh` runs). This
  is always correct (including shrinking-closure deletes, which a from-scratch
  recompute handles trivially) but is **not** algorithmically incremental: even a
  one-row source change triggers a full recompute, so there is no per-row fast
  path. True semi-naïve insert + DRed delete delta evaluation is deferred to
  `materialized-view-recursive-semi-naive-delta`. (A recursive body that reads no
  source table is still rejected by the empty-source guard — there is nothing to
  bind on or to trigger a rebuild from.)
- **set operation** (`union` / `intersect` / `except` / `union all`) over one or
  more sources: *accepted, but maintained as a whole-MV `'global'` rebuild* —
  exactly like the recursive-CTE bullet above, and via the same `compile()`
  short-circuit (a `containsNodeType(analyzed, SetOperation)` walk, so a set op
  nested in a subquery is caught too — not just a top-level compound). A set
  operation is bag-distinguishing across its branches: whether a recomputed row
  belongs in the MV depends on the *full* state of both branches (a row can
  *vanish* because the other branch's multiplicity changed), so there is no bounded
  per-binding residual. Every source classifies `'global'` and any source mutation
  re-derives the **entire** body at COMMIT via `rebuildBacking`. Always correct,
  not algorithmically incremental. The count-based delta path (multiplicity
  counters; per-binding bag-additive `union all` fast path) is deferred to
  `materialized-view-incremental-set-ops-delta`.

Rejected up front with a diagnostic: **outer/semi/anti joins**
(`materialized-view-incremental-outer-joins`), **aggregate over a join**
(`materialized-view-incremental-aggregate-join`), `DISTINCT` over a join,
whole-table aggregates (no `GROUP BY`), `GROUP BY` over non-column expressions,
and a source without a primary key. A `manual` MV over the same body is always
allowed (no gate). A `union all` (or recursive `union all`) body whose result
contains duplicate rows is still a bag, so it raises the "must be a set"
diagnostic at the create-time full-rebuild fill; a body that is set-clean at
create but becomes a bag after a source edit diverges at the COMMIT rebuild
(`diverged`, refresh required) — the loud, correct outcome, since a from-scratch
recompute cannot silently de-duplicate a `union all` bag.

> **Note on classification.** This eligibility is *not* the `extractBindings`
> 'row'/'group' classification used by assertions/watchers — that surface is
> *equality-pinned* and reports a bare MV scan (and a group-by over non-key
> columns) as `'global'`. MV maintenance instead binds on source *identity*
> (PK / group key), which the manager derives directly.

### Apply contract

For each affected binding tuple the manager: binds the residual (`pk0..` / `gk0..`),
runs a pre-compiled **residual scheduler** (the body with a key-equality filter
injected on the source — the same `injectKeyFilter` machinery assertions use),
**deletes** the backing rows for that binding's MV primary key, then **upserts**
the recomputed rows. Net effect per binding is a delete-then-upsert:

- a row/group that disappears (deleted, filtered out, or emptied) leaves only the
  delete — its MV row is removed;
- an aggregate `HAVING` that a recomputed group now fails likewise leaves the
  delete with no re-insert;
- an `UPDATE` moving a row between groups drives **both** the OLD and NEW group
  keys (the change log emits both projections), so both are recomputed.

The delete key is mapped from the binding tuple onto the backing table's physical
primary key via attribute provenance (passthrough column ids forward directly;
aggregate group-by output ids resolve through the aggregate's producing
expression). When that mapping is not clean — e.g. an `order by` body whose
physical PK is seeded with ordering columns outside the binding — the relation
falls back to a **full rebuild** (always correct, just not incremental).

For a **multi-source (inner-join) body**, each source is gated **independently**
by this same clean-mapping test — there is no whole-MV rejection. The source(s)
whose PK covers the backing physical PK (typically the child in a parent/child
flatten, e.g. `orders` in `orders o join customers c on o.cust_id = c.id` keyed
on `orders.id`) maintain incrementally: the residual is the whole join body with
that source filtered to the changed key, so it recomputes exactly the affected
MV row(s) — including the case where the row should *vanish* (an inner-join
partner went away ⇒ the residual yields zero rows ⇒ the delete stands). A source
that fans out (the parent, whose PK does **not** determine the physical PK)
maps to `null` and routes that source's delta to a full rebuild. When *both*
sides change in one commit, the fan-out side's rebuild also fixes the clean
side — correct regardless of dispatch order.

For a **lateral-TVF fan-out body** the delete is *bounded by prefix*, not by an
exact key. The exact per-binding `delete-key` maps to `null` (the backing PK
includes TVF-output columns with no base provenance), which would normally force
a rebuild; the gate above (prefix isolation + advertisement-proven fan-out
set-ness, both computed directly in `compile()` from the TVF's
`relationalAdvertisement`, since `keysOf` does not surface the keyed
cross-product key) instead records a *prefix-delete* residual. Per changed base
row the manager emits a `delete-by-prefix` op (the changed base row's PK values)
followed by upserts of the recomputed fan-out — so an arity-changing update (old
*n* rows → new *m* rows) converges exactly, the case the exact-delete path
provably could not handle. If the gate does not hold, the residual keeps
`deleteKeyOrder = null` and the relation full-rebuilds.

### Cost fallback and global rebuild

The kernel demotes a binding to `'global'` when the changed-tuple count is a large
fraction of the table (`deltaPerRowFallbackRatio`). For an MV, `'global'` means a
full rebuild via the same `replaceBaseLayer` path manual refresh uses
(`rebuildBacking`) — so a bulk change re-materializes once instead of issuing
thousands of per-row patches. The manual `refresh materialized view` statement
also works on an incremental MV and is the resync escape valve.

### Apply-failure recovery (two-tier)

The user's commit always stands, but a failed incremental apply must never
silently leave the MV diverged from its sources and keep serving wrong data with
no signal. On an apply error the manager escalates in two tiers:

- **Tier 1 — self-heal (the common case).** The `apply` catch logs, then attempts
  a full `rebuildBacking`. A full rebuild runs the *whole* body (`collectBodyRows`,
  no injected key filter) — a **different code path** from the per-binding
  `runResidual`/`applyMaintenance` that just failed — so a residual-specific or
  transient failure is very often recovered with correct data and no user-visible
  effect.
- **Tier 2 — visible divergence (the worst case).** If the recovery rebuild *also*
  throws, the MV genuinely cannot be re-materialized. The manager sets
  `MaterializedViewSchema.diverged`. **Reads then error unconditionally** (checked
  in `select.ts` *before* the `stale` body re-validation, with no body
  re-planning — the body is fine; the *data* is wrong) with a diagnostic naming the
  MV and pointing at `refresh materialized view`. This stops silent wrong reads
  in the persistent-failure case for any **freshly planned** query.

> **Caveat — cached prepared statements.** The `diverged` check (like the `stale`
> check beside it) runs at *plan-build* time in `select.ts`. `diverged` is set on
> the post-commit maintenance path without emitting a schema-change event, so a
> prepared statement that was already planned against the MV *before* it diverged
> keeps its cached plan and reads the backing table directly — bypassing the guard
> until something forces a recompile. A query planned *after* divergence always
> errors. This is a pre-existing limitation shared with `stale`; closing it
> (invalidating dependent plans when an MV's read-state toggles) is tracked
> separately.

`diverged` is cleared **only** by a full re-materialization, never by a later
incremental apply (a subsequent apply maintains only the *new* delta and would not
fix the old gap). The clearing paths are: a successful Tier-1 recovery rebuild
(which never sets the flag); a successful `refresh materialized view`; and the
**self-heal retry** — when `diverged` is already set, the next commit that touches
a source short-circuits the incremental delta and runs a full `rebuildBacking`, so
a deterministic failure that later becomes transient heals automatically.

> Forcing a deterministic apply failure for tests is awkward in production code,
> so `MaterializedViewManager` carries a narrow `@internal` fault-injection seam
> (`maintenanceFaultInjector`, installed via
> `Database._setMaterializedViewMaintenanceFault`) that can throw at the
> `'residual'`, `'apply'`, or `'rebuild'` phase. Production never sets it; see
> `test/materialized-view-diagnostics.spec.ts`.

### Change-scope projection

A `select` from an MV resolves to a reference on its backing table, so
`Statement.getChangeScope()` would naively report `sqlite_mv_<name>`. But an
`on-commit-incremental` MV's backing table is never written through the user
change log — it is maintained at COMMIT from its sources — so a `Database.watch`
on it would never fire. To fix this, the manager caches a **source-union
change-scope** on the MV at registration (`MaterializedViewSchema.sourceScope`,
v1 = a `full` watch per source via `buildSourceUnionScope`), and change-scope
analysis substitutes it for the backing-table watch (see
[change-scope.md](change-scope.md#materialized-view-reference-projection)). A
`Database.watch` on such an MV therefore fires on a **source** mutation. A
`manual` MV's backing table *is* user-observable state (refresh writes it), so it
keeps reporting the backing table.

### Limitations

- **Cascading MVs (MV-over-MV) converge in a single commit.** When an
  incremental MV's body reads another incremental MV's backing table, both are
  maintained in the same post-commit pass: the manager processes incremental MVs
  in dependency-topological order and feeds each producer's backing-table write
  to its dependents through a per-pass *delta overlay* layered on the change log
  (a producer's per-binding writes are captured as insert/update/delete deltas;
  a wholesale rebuild — global binding, cost-fallback, or recovery — forces a
  full rebuild of every dependent, always correct). A **lateral-TVF prefix-delete**
  producer is treated like a wholesale rebuild for cascade purposes: a
  `delete-by-prefix` removes an unbounded set of backing PKs the per-row overlay
  capture cannot enumerate from the op alone, so the manager marks the backing
  globally changed and its dependents re-evaluate in full (a finer per-row fan-out
  capture is a later optimization). Because the MV-dependency
  graph is a DAG (a body is fixed at create and any upstream MV must already
  exist), one topologically-ordered pass converges the whole chain — no fixpoint
  loop. A structurally-impossible cycle degrades loudly (a diagnostic plus
  insertion-order fallback) rather than looping. *Caveat — cascading divergence:*
  if an upstream MV itself diverges (Tier-2: even its rebuild failed), its
  dependents are maintained against the upstream's stale backing data without
  erroring — only direct reads of the diverged MV error (via the `diverged`
  read-guard). Propagating divergence to dependents is out of scope.
- **Keyless / bag bodies** (all-columns PK) inherit the "must be a set"
  diagnostic *only on the full-rebuild branch* — a `'global'` binding or a
  cost-fallback demotion routes through `rebuildBacking` → `replaceBaseLayer`,
  which raises it. The **per-binding** incremental branch does **not**: it is
  eligible for any row-preserving single-source body keyed on the source PK
  (eligibility is decided by the *source's* key, not the MV's output key — see
  `database-materialized-views.ts` `compile()`), so a projection that drops the
  source key (e.g. `select status from orders` keyed all-columns on `{status}`)
  is accepted. If such a body is duplicate-free at create (so the create-time
  `replaceBaseLayer` passes) but a later source mutation makes it a bag, the
  per-binding `upsert` collapses the colliding rows by MV key instead of raising
  the diagnostic — i.e. it **silently de-duplicates to the set** rather than
  enforcing "no silent de-dup" the way create/refresh do. This inconsistency
  between the loud full-rebuild path and the silent per-binding path is tracked
  in `materialized-view-incremental-bag-silent-dedup`.
- **`getChangeScope()` projection is conservative.** `Database.watch` on an
  incremental MV now fires on *source* mutations (delivered — see
  [Change-scope projection](#change-scope-projection)), but v1 projects to a
  whole-table (`full`) watch per source. A precise per-source row/group scope,
  mirroring the maintenance bindings the manager already derives, is a future
  refinement.

## Row-time refresh

An MV created `with refresh = 'row-time'` is maintained **synchronously with each
source row-write** — within the writing statement's transaction, visible
mid-statement (reads-own-writes), and committed/rolled-back in lockstep with the
source write. This is the strongest coupling point: unlike `on-commit-incremental`
(which defers a delta to COMMIT), a `select` from a row-time MV inside an open
transaction reflects rows the same transaction just wrote and has not yet
committed.

Row-time is implemented as user-declared, synchronously-maintained *materialized
index*: it is the maintenance capability the lens layer's row-time UNIQUE
enforcement is built on (enforcement routing through the backing table is a
separate downstream ticket; this section delivers maintenance only).

### Eligibility (checked at create time)

`row-time` is accepted **only** for the covering-index shape — a strict superset
of the coverage prover's recognized shape (`planner/analysis/coverage-prover.ts`),
recognized at create from the optimized/analyzed body. The MV is rolled back (like
the incremental gate) when any of these does not hold:

- a **single** source table `T` with a primary key (no joins / self-joins);
- a row-preserving linear body `TableReference → optional Filter → Project →
  optional Sort` — **no** aggregate, set operation, `DISTINCT`, recursive CTE,
  table-valued function, or `LIMIT`/`OFFSET`;
- a **passthrough** projection: every projected (backing) column resolves to a
  source column via attribute provenance — there are no computed/expression
  columns. (This makes maintenance a pure column permutation. An expression
  projection is rejected; use `on-commit-incremental`. *Known v1 gap.*)
- the projection includes **every** PK column of `T`, so each source row maps to a
  unique backing key (and the backing key identifies the source row);
- a partial `WHERE`, if present, must be evaluable on a single source row
  (compiled via `compilePredicate`; subqueries / cross-row references are
  rejected).

> Note: in Quereus a table declared without an explicit `primary key` defaults to
> an **all-columns** PK (`schema/table.ts`), so the "source without a PK" rejection
> is effectively unreachable for memory tables — a PK-less source is keyed on all
> its columns. The relevant create-time failure is "projection drops a source PK
> column."

### Maintenance (per source row-write)

For an eligible MV the manager caches a `RowTimeMaintenancePlan` (projection
column map + backing PK + optional predicate), keyed by source base. The per-row
backing delta is a **pure projection of the changed row** — no body re-execution,
no scan, no compiled residual:

| source op | maintenance |
|---|---|
| insert `r` | if `predicate(r)` → upsert `project(r)` |
| delete `r` | if `predicate(r)` (was in scope) → delete the backing key of `project(r)` |
| update `old→new` | delete old image if in scope; upsert new image if in scope |

The update arm covers predicate-scope transitions and key-changing updates. This
bounded O(log n) per-row cost (a btree delete + insert) — identical to the
secondary-index maintenance a UNIQUE auto-index already performs — is the whole
reason row-time is affordable for this shape and not for general bodies.

### Synchronous, transactional integration

Maintenance is driven from the **runtime DML write boundary**
(`runtime/emit/dml-executor.ts`), immediately after each source row is recorded
(`_recordInsert/_recordUpdate/_recordDelete`), via
`Database._maintainRowTimeCoveringStructures(sourceBase, change)`. A cheap
synchronous guard (`_hasRowTimeCoveringStructures`) makes this a no-op fast path
for tables no row-time MV reads, so non-covered writes pay effectively nothing.

The backing write is routed through the **same `MemoryTableConnection` a `select`
from the MV would use** in this transaction (obtained/registered lazily). A new
privileged transaction-layer write —
`MemoryTableManager.applyMaintenanceToLayer(connection, ops)`, the analogue of the
committed-base `applyMaintenance` — applies the ordered `delete-key` / `upsert`
ops to that connection's **pending** `TransactionLayer`, bypassing
`validateMutationPermissions` (backing tables are read-only to user DML) and
reusing `recordUpsert`/`recordDelete` so secondary-index bookkeeping stays
correct. Because the connection is in the Database's active set:

- a later read of the MV in the same transaction sees the pending writes **for
  free** (reads-own-writes — this is the row-time analogue of, and replacement
  for, the on-commit `pendingDelta` overlay; no overlay is needed);
- the pending layer is committed atomically by the existing coordinated commit
  (`database-transaction.ts`) and discarded by the existing rollback broadcast —
  so a rollback (or a failed source write inside the statement savepoint) reverts
  the backing delta in lockstep; and
- an autocommit `insert into T` rides the **statement-level** autocommit boundary
  (driven above the per-manager autocommit), so source and backing commit
  together — no orphaned/uncommitted backing pending layer.

`Database.watch` on a row-time MV projects to the MV's **sources** (the backing
table is maintained off the user change log), the same substitution
`on-commit-incremental` uses.

### What row-time does NOT do

- **No enforcement routing.** `findIndexForConstraint` still never returns the
  `materialized-view` covering variant, and `checkSingleUniqueConstraint`'s
  `materialized-view` arm still throws `UNSUPPORTED`. Consuming the now-row-time
  backing table for conflict resolution is the downstream
  `covering-structure-mv-rowtime-enforcement` ticket.
- **No general-body row-time** (joins, aggregates, recursion, set ops) — parked in
  `backlog/materialized-view-rowtime-general-bodies.md`.
- **No store-module path** — the runtime seam is module-agnostic, but the
  privileged transactional write is implemented for the memory module here; store
  parity rides the enforcement ticket.

## Declarative-schema integration

Materialized views participate in the [declarative-schema](schema.md#declarative-schema)
pipeline. A `declare schema { ... }` block accepts a `materialized view` item:

```sql
declare schema main {
  table t { id integer primary key, x integer not null }
  materialized view mv as select id, x from t
}
apply schema main;
```

- **DDL round-trip.** `apply schema` and schema export emit canonical
  `create materialized view ...` DDL via `ast-stringify`, so a schema survives
  `schema → DDL → parse → schema` with no shape change.
- **Body-change rebuild.** The differ keys rebuild detection on `bodyHash`
  (`toBase64Url(fnv1aHash(<canonical body SQL>))`, the single source of truth
  shared by MV creation and the differ). When a declared MV's body hash differs
  from the live MV's `bodyHash`, the differ schedules a **drop + recreate**
  (materialized views have no in-place `ALTER` primitive). The recreate
  re-materializes from current sources, in apply order — after source tables and
  views are created, before assertions. An unchanged body produces no create and
  no drop, and leaves the schema hash unchanged. Tags do not perturb the schema
  version (they are stripped before hashing).

## Covering structures

A UNIQUE constraint is *logical*; the structure that enforces it is *optional*
and may take more than one physical shape. Quereus describes every such shape in
one vocabulary — the **covering structure** — so the enforcement layer (and the
lens layer above it) can pattern-match a single surface
(`CoveringStructure` in `vtab/memory/layer/manager.ts`):

```
type CoveringStructure =
  | { kind: 'memory-index';      index: MemoryIndex }            // produced today
  | { kind: 'materialized-view'; view:  MaterializedViewSchema } // reserved (see soundness note)
```

### Implicit covering structures (the auto-index, reframed)

Every declared UNIQUE constraint auto-builds a synchronously-maintained
secondary BTree for efficient enforcement (`ensureUniqueConstraintIndexes`).
That BTree is reframed as an **implicit covering structure** —
`origin: 'implicit-from-unique-constraint'` in the materialized-view vocabulary —
held as a lightweight association on the memory-table manager (it is *not*
registered as a `MaterializedViewSchema`; the BTree is the structure). Row-time
enforcement (`findIndexForConstraint`) returns this `memory-index` variant. The
physical structure is unchanged from before the reframe — behavior is
observation-equivalent.

Implicit covering structures are a backing detail and are **hidden from
`collectSchemaCatalog` / schema export by default**, surfaced only when the
originating constraint carries the tag `quereus.expose_implicit_index = true`.

### Explicit covering structures (the coverage prover)

A user-declared materialized view can *cover* a UNIQUE constraint. The
**coverage prover** (`planner/analysis/coverage-prover.ts`) recognizes the
canonical covering shape and records the link eagerly at MV-creation time. For

```sql
create table t (id integer primary key, x integer not null, y integer not null, unique (x, y));
create materialized view ix_t_xy as select x, y, id from t order by x, y;   -- covers unique(x,y)
```

the prover proves `ix_t_xy` covers `unique(x, y)` and stamps the link (see
[Schema § Covering-structure links](schema.md#covering-structure-links)).

Recognition rules (narrow v1 — every check is conservative; a false *NotCovers*
only forgoes an optimization, a false *Covers* would be unsound):

- **Shape.** The optimized body walks down to a single constrained base table
  `T` (`TableReference → optional Filter/Alias → Project → optional Sort`;
  physical access nodes are transparent). A **binary join** is admitted when `T`
  provably contributes *exactly one* MV row per governed `T` row (see the join
  decomposition below). Aggregation, `DISTINCT`, set operations,
  `FanOutLookupJoin`, `AsofScan`, or a `LIMIT`/`OFFSET` row cap (which
  materializes only a prefix of the governed rows) ⇒ not covering.
- **Join (1:1) decomposition.** "Exactly one MV row per governed `T` row" splits
  into two independent obligations, each proven by a distinct surface:
    - *No row loss (≥1):* `T` must sit on the row-**preserving** side of every
      join between the body root and `T`'s reference — a `left` join with `T` in
      the left subtree, or a `right` join with `T` in the right subtree.
      `inner`/`cross` (drop unmatched `T` rows), `semi`/`anti` (filter), `full`
      (inject lookup-only rows), and `T` on the dropping side are all rejected as
      *shape*. This is a structural plan-walk check — FDs encode uniqueness, not
      existence, so they cannot prove it.
    - *No fan-out (≤1):* `T`'s primary key must be a unique key of the **topmost
      join's output relation** (read via `isUnique`). The optimizer emits
      `T.pk → all_join_cols` into the join's FDs exactly when the equi-pairs cover
      a unique key of the lookup side (each `T` row matches ≤1 lookup row); the
      moment the lookup side can multiply a `T` row, no such FD is emitted and the
      gate fails (`fanout`). The check is against the *join* frame, **not** the
      projected body root: a fanning `left` join still carries `T`'s own PK FD
      `T.pk → T-cols`, which — once the lookup columns are projected away — would
      make `T.pk` a derived key of the narrowed relation and silently mask the
      fan-out; at the join frame the retained lookup columns witness it. (Example:
      `orders o left join customers c on o.customer_id = c.id` covers
      `unique(customer_id, sku)` on `orders` iff `customers.id` is unique.) When
      the optimizer instead *eliminates* a key-preserving join (FK→PK aligned,
      lookup unprojected — see `rule-join-elimination`), the body collapses to a
      single-source chain and the v1 path covers it directly.
- **Projection.** The output must include every UC column **and** every primary
  key column of `T` (the PK identifies the source row for conflict resolution).
- **Ordering.** The body's `order by` columns must be a permutation of the UC
  columns. A missing `order by` does not cover — the prover never invents an
  ordering. (Ordering and the WHERE predicate are read from the **body AST**, not
  the optimized plan: the optimizer drops the `Sort` and absorbs a `WHERE` into
  an index range seek whenever an index already provides them, so the plan is not
  a faithful source for either.)
- **Predicate alignment.** The body's materialized row set must equal the set the
  constraint governs: the WHERE predicate must entail `uc.predicate` (for partial
  UNIQUE) and an `is not null` per nullable UC column (NULL-skip), and must add no
  restriction beyond that (else it would drop governed rows and miss conflicts).
  Entailment reuses the partial-UNIQUE clause vocabulary — see
  [Optimizer § Coverage proving](optimizer.md#coverage-proving).

### Soundness boundary — why nothing enforces through an explicit MV yet

The link the prover records is **informational in this release**. Row-time
UNIQUE enforcement (the in-place substitution of `insert or replace`, the skip of
`insert or ignore`, the conflict diagnostic of the default `abort`) requires the
covering structure to be consistent *at the moment of the write*. The implicit
secondary BTree is synchronously maintained, so it can drive row-time
enforcement; an explicit MV's backing table can do so **only once it is
write-through maintained**:

- A `manual` MV materializes the backing table once at create / refresh; source
  DML does not update it.
- The commit-time `on-commit-incremental` policy maintains backing tables at
  COMMIT, not at row-write time.
- The **`row-time`** policy (see [Row-time refresh](#row-time-refresh)) *does*
  maintain the backing table synchronously with each source row-write, for the
  covering-index shape — so the **write-through prerequisite now exists** for that
  shape.

The write-through prerequisite is therefore satisfied for a `row-time` covering MV,
but **enforcement routing is still not wired**: `findIndexForConstraint` never
returns the `materialized-view` variant of `CoveringStructure`, and
`checkSingleUniqueConstraint`'s `materialized-view` arm still fails loudly
(`StatusCode.UNSUPPORTED`) if ever reached. Consuming a row-time backing table for
conflict resolution is the downstream `covering-structure-mv-rowtime-enforcement`
ticket (which lists row-time write-through as its prereq). For *physical* schemas
this remains moot — the auto-index already enforces, so an explicit covering MV
adds a read-answering copy plus the recognized link; the explicit MV becomes the
*sole* enforcement structure only in the **logical-schema** world (the lens layer),
where the auto-index is retired.

**FD-derived "body proves it" is a different proof.** Separate from base-table
covering, `coverage-prover.ts` exposes `proveEffectiveKeyUnique`, which proves the
body's *own output relation* is unique on a set of output columns via its
effective key (FD closure) — e.g. a `group by x, y` body intrinsically one row per
`(x, y)`. This is the obligation primitive the lens layer's `obligation: proved`
class consumes; it is a proof about the **derived (output) relation**, **not** a
base-table covering structure, and is deliberately kept out of `proveCoverage`
because an FD-derived output key masks base-row duplicates (grouping collapses
two `x = 5` base rows into one output row) and so cannot witness a base-table
`unique`. See [Optimizer § Effective-key proving](optimizer.md#effective-key-proving-body-proves-it)
and [Lenses § the constraint-role split](lens.md).

Deferred follow-ups: `covering-structure-mv-rowtime-enforcement` (route
enforcement through a covering MV — its prereq, `materialized-view-rowtime-write-through`,
is now **delivered** for the covering-index shape, see [Row-time refresh](#row-time-refresh))
and `coverage-prover-inner-join-fk-preservation` (admit an `inner`/`cross` lookup
join when enforced referential integrity — a NOT-NULL FK aligned with the
equi-pairs — proves every `T` row matches, closing the no-row-loss obligation
the outer-join path gets structurally). Multi-source (join) bodies on the
*outer*-join 1:1 path are **delivered** (`coverage-prover-multi-source-bodies`).
Whether a covering *enforcement* structure (detection-only, ABORT) can ever be
FD-derived is a separate question for the row-time-enforcement / lens tickets —
`proveEffectiveKeyUnique` does not address it.

## Out of scope / roadmap

Phase 1 deliberately stops at manual full-refresh. The following extensions are
tracked separately and build on this substrate:

- **Concurrent refresh** (`materialized-view-concurrent-refresh`) — overlapping
  refreshes and refresh-while-read beyond today's atomic base-layer swap.
- **Incremental refresh** — *delivered* for row-preserving bodies over one or
  more **inner/cross-joined** sources and single-source aggregate bodies
  (`with refresh = 'on-commit-incremental'`; see
  [Incremental refresh](#incremental-refresh)). Recursive-CTE and set-operation
  (`union`/`intersect`/`except`/`union all`) bodies are *delivered as a whole-MV
  global rebuild* (full recompute on any source commit — correct, not
  algorithmically incremental); the true delta paths are deferred to
  `materialized-view-recursive-semi-naive-delta` (recursion) and
  `materialized-view-incremental-set-ops-delta` (count-based set-op deltas + the
  bag-additive `union all` per-binding fast path). Remaining work:
  outer/semi/anti join bodies (`materialized-view-incremental-outer-joins`),
  aggregate over a join (`materialized-view-incremental-aggregate-join`),
  cascading-MV convergence
  (`materialized-view-incremental-cascading-convergence`), and the
  `getChangeScope()` source projection (`materialized-view-incremental-changescope`).
- **Row-time write-through** — *delivered* for the covering-index shape
  (`with refresh = 'row-time'`; see [Row-time refresh](#row-time-refresh)). General
  bodies (joins, aggregates, recursion, set ops) are parked in
  `materialized-view-rowtime-general-bodies`; routing row-time UNIQUE enforcement
  through the maintained backing table is `covering-structure-mv-rowtime-enforcement`.
- **Write-through DML** (`materialized-view-writes-through-body`) — accept DML
  against an MV and propagate to sources via [view updateability](view-updateability.md).
  (Distinct from row-time *maintenance* above: this is writing *the MV*, not
  keeping it in sync with source writes.)
- **Backing-module pluggability** — honor `USING <module>(...)` so the stored
  relation can live in a module other than the in-memory table.
- **Lens / covering structures** — indexes and set-level constraint enforcement
  expressed as covering materialized views in the basis layer. See
  [Lenses and Layered Schemas](lens.md).
- **Bag-body contract** — *delivered.* A v1 materialized view must be a **set**:
  a duplicate-producing ("bag") body is rejected with a purpose-built "must be a
  set" diagnostic (at create, or at the next refresh if the body only later
  becomes duplicate-producing) instead of the raw `UNIQUE constraint failed` that
  named the hidden backing table. See [Primary key inference (and the all-columns
  fallback)](#primary-key-inference-and-the-all-columns-fallback). No silent
  de-duplication and no synthetic row identity *on the create/refresh
  full-rebuild path*. The `on-commit-incremental` per-binding path is not yet
  consistent with this contract (it silently de-duplicates a late bag) —
  tracked in `materialized-view-incremental-bag-silent-dedup`.
