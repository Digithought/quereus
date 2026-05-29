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
[Incremental refresh](#incremental-refresh).

This document covers the substrate as it exists today. The concurrent-refresh,
write-through, and lens-integration extensions are tracked in
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
  statically rejected. Quereus does **not** silently de-duplicate, and does
  **not** synthesize a row identity.

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
  [with refresh = 'manual' | 'on-commit-incremental']
  [with tags (...)];
```

- `<body>` is any relation-producing `QueryExpr` — a `SELECT`, a bare
  `VALUES`, or a compound (`union all`, …). A DML-with-`RETURNING` body parses
  but is rejected by the planner (replaying a write per materialization is
  incoherent).
- An explicit column list renames the body's output columns (arity must match).
- `with refresh = '...'` selects the refresh policy (trailing, alongside the
  existing `with tags`; default `manual`). `on-commit-incremental` is gated to
  incrementally-maintainable bodies — see [Incremental refresh](#incremental-refresh).
- The body is evaluated immediately and the result stored. On any failure
  during the fill — or if an `on-commit-incremental` body is ineligible — the
  backing table is rolled back and the MV is **not** registered; a create is
  all-or-nothing.

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
`INSERT` / `UPDATE` / `DELETE` never set the flag.

## Incremental refresh

An MV created `with refresh = 'on-commit-incremental'` is maintained at every
COMMIT that touches a source table — no manual refresh needed. It is the third
consumer of the reusable change-driven kernel
([Incremental Maintenance](incremental-maintenance.md)): the
`MaterializedViewManager` registers a `DeltaSubscription` whose `apply` **writes**
the backing table (delete-then-upsert per affected binding), running in the
post-commit window (change log alive, all connections committed). A failed apply
**logs and skips** — it never rolls the user's commit back (the watcher
contract, not the assertion one).

### Eligibility (checked at create time)

`on-commit-incremental` is rejected at create — rolling the MV back — unless the
body is incrementally maintainable. v1 accepts **single-source** bodies of two
shapes:

- **row-preserving** (projection / filter, no aggregate): maintenance binds on
  the source's **primary key**. Each changed source row recomputes its MV
  row(s). The source must have a primary key.
- **single-source aggregate** with `GROUP BY` over **bare source columns**:
  maintenance binds on the **group key**. Each changed group (OLD and NEW on an
  update that moves a row between groups) is recomputed.

Rejected up front with a diagnostic: multiple sources / joins, set operations
other than `union all` (`materialized-view-incremental-set-ops`), recursive CTE
bodies (`materialized-view-incremental-recursive-cte`), whole-table aggregates
(no `GROUP BY`), and `GROUP BY` over non-column expressions. A `manual` MV over
the same body is always allowed (no gate).

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

### Cost fallback and global rebuild

The kernel demotes a binding to `'global'` when the changed-tuple count is a large
fraction of the table (`deltaPerRowFallbackRatio`). For an MV, `'global'` means a
full rebuild via the same `replaceBaseLayer` path manual refresh uses
(`rebuildBacking`) — so a bulk change re-materializes once instead of issuing
thousands of per-row patches. The manual `refresh materialized view` statement
also works on an incremental MV and is the resync escape valve.

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

- **Cascading MVs (MV-over-MV) may need more than one commit to converge.** A
  leaf MV's backing-table write happens *during* the post-commit pass and is not
  itself in the current change log, so a dependent MV does not observe it this
  commit. Tracked: `materialized-view-incremental-cascading-convergence`.
- **Keyless / bag bodies** (all-columns PK) raise the same "must be a set"
  diagnostic on a duplicate-producing rebuild that manual refresh raises (a
  `'global'` rebuild routes through `rebuildBacking` → `replaceBaseLayer`). In
  practice a bag body is incremental-ineligible, so this path should not see one;
  it inherits the better message for free.
- **`getChangeScope()` projection is conservative.** `Database.watch` on an
  incremental MV now fires on *source* mutations (delivered — see
  [Change-scope projection](#change-scope-projection)), but v1 projects to a
  whole-table (`full`) watch per source. A precise per-source row/group scope,
  mirroring the maintenance bindings the manager already derives, is a future
  refinement.

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
enforcement; an explicit MV's backing table **cannot**:

- MV-core materializes the backing table once at create / refresh (manual
  refresh); source DML does not update it.
- Even the sibling commit-time `materialized-view-incremental-refresh` maintains
  backing tables at COMMIT, not at row-write time.

So routing row-time enforcement through an explicit MV's backing table is
**unsound until row-time write-through MV maintenance exists**. For *physical*
schemas this is moot: the auto-index already enforces, so an explicit covering MV
adds a read-answering copy plus the recognized link. The explicit MV becomes the
*sole* enforcement structure only in the **logical-schema** world (the lens
layer), where the auto-index is retired; that work is gated on row-time
write-through. The `materialized-view` variant of `CoveringStructure` exists so
that surface is stable to compile against, but `findIndexForConstraint` never
returns it today — the unsound path fails loudly (`StatusCode.UNSUPPORTED`) if
ever reached.

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
enforcement through a covering MV, blocked on
`materialized-view-rowtime-write-through`) and
`coverage-prover-inner-join-fk-preservation` (admit an `inner`/`cross` lookup
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
- **Incremental refresh** — *delivered* for single-source row-preserving and
  single-source aggregate bodies (`with refresh = 'on-commit-incremental'`; see
  [Incremental refresh](#incremental-refresh)). Remaining work: multi-source /
  join bodies, set-ops (`materialized-view-incremental-set-ops`), recursive CTEs
  (`materialized-view-incremental-recursive-cte`), cascading-MV convergence
  (`materialized-view-incremental-cascading-convergence`), and the
  `getChangeScope()` source projection (`materialized-view-incremental-changescope`).
- **Write-through** (`materialized-view-writes-through-body`) — accept DML
  against an MV and propagate to sources via [view updateability](view-updateability.md).
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
  de-duplication and no synthetic row identity.
