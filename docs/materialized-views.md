# Materialized Views

A **materialized view** in Quereus is a *keyed derived relation*: a query body
stored once into a backing relation, primary-keyed by the body's inferred key,
and addressable like any other (virtual) table. Where a plain
[view](schema.md#viewschema) re-evaluates its body on every reference, a
materialized view evaluates the body at create time, stores the result, and
serves subsequent reads from that stored copy. Phase 1 (what ships today) is
**manual full-refresh**: source mutations do not update the stored rows until
an explicit `REFRESH MATERIALIZED VIEW`.

This document covers the substrate as it exists today. The incremental,
concurrent-refresh, write-through, and lens-integration extensions are tracked
in [Out of scope / roadmap](#out-of-scope--roadmap).

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
- **A duplicate-row body fails loudly.** If the body emits two identical rows
  under an all-columns key, materialization hits a `UNIQUE constraint failed`
  on the backing PK and the `CREATE` / `REFRESH` statement fails. A body that
  becomes duplicate-producing only after source edits therefore fails at the
  next `REFRESH`, not at create time. This is a loud failure, not silent
  corruption; choosing a friendlier contract for bag bodies is tracked
  separately (`materialized-view-bag-body-duplicates`).

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
  [with tags (...)];
```

- `<body>` is any relation-producing `QueryExpr` — a `SELECT`, a bare
  `VALUES`, or a compound (`union all`, …). A DML-with-`RETURNING` body parses
  but is rejected by the planner (replaying a write per materialization is
  incoherent).
- An explicit column list renames the body's output columns (arity must match).
- The body is evaluated immediately and the result stored. On any failure
  during the fill, the backing table is rolled back and the MV is **not**
  registered — a create is all-or-nothing.

### `REFRESH MATERIALIZED VIEW`

```sql
refresh materialized view mv;
```

Re-evaluates the body against current source data and atomically replaces the
backing table's contents (`replaceBaseLayer` builds a fresh base layer, guards
duplicate PKs, and swaps it under the schema-change latch). Readers use
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

## Out of scope / roadmap

Phase 1 deliberately stops at manual full-refresh. The following extensions are
tracked separately and build on this substrate:

- **Concurrent refresh** (`materialized-view-concurrent-refresh`) — overlapping
  refreshes and refresh-while-read beyond today's atomic base-layer swap.
- **Incremental refresh** (`materialized-view-incremental-refresh`) — consume
  the reusable change-driven kernel ([Incremental Maintenance](incremental-maintenance.md))
  to apply ΔQ instead of re-materializing in full. Requires an inferable key
  (all-columns-fallback views are ineligible).
- **Write-through** (`materialized-view-writes-through-body`) — accept DML
  against an MV and propagate to sources via [view updateability](view-updateability.md).
- **Backing-module pluggability** — honor `USING <module>(...)` so the stored
  relation can live in a module other than the in-memory table.
- **Lens / covering structures** — indexes and set-level constraint enforcement
  expressed as covering materialized views in the basis layer. See
  [Lenses and Layered Schemas](lens.md).
- **Bag-body contract** (`materialized-view-bag-body-duplicates`) — a chosen
  contract for keyless, duplicate-producing bodies in place of the current raw
  `UNIQUE constraint failed`.
