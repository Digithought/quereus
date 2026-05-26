---
description: Keyed derived relations (materialized views) — cached query results with refresh strategies, AND covering structures (a materialized index = a materialized view with `order by`) that physically realize/enforce constraints (e.g. a unique constraint via row-time existence lookup) while keeping the constraint itself logical. Substrate beneath the lens layer (docs/lens.md).
prereq: unified-key-inference-surface
files: packages/quereus/src/schema/view.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/planner/building/create-view.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, docs/incremental-maintenance.md, docs/optimizer.md, docs/lens.md
---

## Overview

Materialized views are views whose results are cached in a backing (virtual) table for fast reads. Unlike regular views (which re-execute the SELECT on each access), materialized views store their result set and are kept current by refresh — manual at first, incremental later.

Framed in Quereus terms (all tables virtual, key-addressed, no rowids), a materialized view is a **keyed derived relation**: a stored relation defined by a query, with a primary key, maintained as its base data changes. Several existing concepts are special cases of this one primitive:

- a **secondary index** is a keyed derived relation projecting the indexed columns + PK, keyed/ordered on the index columns (covers *reads*: lookup/ordering);
- a **unique constraint's physical structure** is a keyed derived relation over the constraint columns that can *detect duplicates* (covers *enforcement*);
- a general **materialized view** is the unrestricted case.

Today the unique-constraint case is hardcoded: declaring `unique(x, y)` auto-creates a secondary BTree via `LayerManager.ensureUniqueConstraintIndexes()` (`vtab/memory/layer/manager.ts`), fusing the logical key claim with a physical structure at declaration time. A goal of this work is to **separate those concepts** (see "Covering structures" below).

This is lower priority than FK constraints, computed columns, and ALTER TABLE. The design below captures the key decisions; detailed planning (and likely a split into several plan/implement tickets — read-caching vs. constraint-covering are largely independent) should happen when this moves to plan stage.

The implement stage should create a timeless `docs/materialized-views.md` reflecting what is actually built, register it in the docs index in `docs/architecture.md`, and cross-reference it from `docs/optimizer.md`, `docs/schema.md`, `docs/incremental-maintenance.md`, and `docs/lens.md` the way the shipped features already are — the design prose here graduates into that doc rather than living in two places.

(Naming: this ticket's filename — `4-materialized-views` — undersells its scope; it is really *keyed derived relations / covering structures*, the substrate beneath both materialized views and the lens layer. Rename via the tess workflow if/when convenient; the filename is left as-is here to avoid breaking ticket references.)

### Foundations already in place

- `ViewSchema` (`schema/view.ts`) stores `sql` + parsed `selectAst`; views are also registered as `TableSchema` with `isView: true` and `viewDefinition: AST.SelectStmt`. A backing table can reuse this bridge.
- `DeltaExecutor` (`runtime/delta-executor.ts`) already classifies per-table change deltas as `{kind:'global'}` / `{kind:'row', keyColumns}` / `{kind:'group', groupColumns}` and dispatches incrementally at COMMIT. Assertions are its first consumer (`core/database-assertions.ts`); the doc explicitly names materialized views as the next one (`docs/incremental-maintenance.md`).
- Partial-unique handling and guarded FDs exist (`planner/analysis/partial-unique-extraction.ts`).

## Design Sketch

### Syntax

```sql
create materialized view mv_name as select ...;
refresh materialized view mv_name;
drop materialized view mv_name;
```

### Storage Model

A materialized view is backed by an internal MemoryTable (or configurable module). On creation, the SELECT is executed and results stored. On manual refresh, the backing table is truncated and repopulated. The backing table has a primary key derived from the view's relational key (see Query Resolution / key inference).

### Schema Representation

Extend `ViewSchema` or create a new `MaterializedViewSchema`:
- Stores the SELECT AST (like a regular view)
- References the backing table
- Tracks last refresh timestamp
- Optional: refresh strategy metadata (manual-only initially)
- For covering structures: the constraint(s) this view covers, if any (see below)

### Query Resolution

When a materialized view is referenced in a query, resolve to the backing table (not the SELECT) for fast reads. The backing table's declared key comes from inferring the view's relational key from its definition (e.g. a `group by`'d view is keyed by its group columns) — this is the same key-inference surface introduced by `unified-key-inference-surface` (`keysOf`/`isUnique`), so the MV's PK and the optimizer's view of it agree.

### Refresh Strategies

Phase 1: Manual refresh only (`refresh materialized view`) — full re-execution into the backing table.

Phase 2: Incremental refresh built directly on `DeltaExecutor`. The MV registers a `DeltaSubscription`; its `apply()` performs delete-then-upsert per changed binding tuple. A `group by` view maps onto `{kind:'group', groupColumns}`, a key-filtered view onto `{kind:'row', keyColumns}`, anything else onto `{kind:'global'}`. The 50%-of-table fallback ratio already in `DeltaExecutor` applies. This is the same kernel constraint enforcement uses, so an MV that covers a constraint is maintained and enforced by one mechanism.

## Covering structures: materialized views as constraint enforcement

The second purpose of this primitive is to **physically realize a constraint while keeping the constraint logical**. Target separation:

- `unique(x, y)` (and CHECK, FK, …) is a **logical** claim. It always contributes keys/FDs to the optimizer via `keysOf`/`isUnique`, *independent of whether any structure backs it*. With no covering structure, it is correct-but-slow: enforced through the existing commit-time group/global assertion path (`DeltaExecutor`).
- A **covering structure** (a materialized view, of which an index is a degenerate case) is an *optional physical optimization* that upgrades enforcement from an O(n) scan to O(Δ) incremental maintenance and provides an access path. It is not the source of the constraint's existence.

### What "covers" means

Two independent senses, only one of which is subtle:

1. **Answering coverage** (the classic index sense): the view can serve a query/read — its columns ⊇ what's needed and its key/ordering fit. The constraint's *optimizer* benefit needs no structure at all; the logical declaration already yields the FD/key.
2. **Enforcement coverage**: maintaining the view necessarily detects any violation of the constraint.

### Covering form: a materialized index (NOT a count-form view)

The covering structure for a constraint is a **materialized index**: a materialized view whose `order by` describes an ordered/clustered structure over the constraint columns. A `select distinct x, y` (or any dedup) is the *wrong* shape — it collapses duplicate `(x,y)` rows into one, losing the very rows the index must store, so a duplicate insert produces no observable change and the violation is silently absorbed.

```sql
create materialized view ix_t_xy as
  select x, y, <pk...> from t order by x, y;   -- ordered/clustered index over (x, y)
```

Enforcement is **not** a self-validating invariant on the structure's shape (the earlier `select x,y,count(*) ... having n>1` count-form is rejected: it only detects at COMMIT and cannot do row-time conflict resolution). Instead, uniqueness is an **existence lookup against the structure**:

> "Does a row with this key already exist?" → point-lookup against the materialized index if present (O(log n), **row-time**, so `insert or replace` / `or ignore` conflict resolution works — exactly what `checkUniqueViaIndex` does today); else fall back to the commit-time group/global assertion scan via `DeltaExecutor` (O(n), detection-only).

The structure is thus an **access path for enforcement**, not an invariant that fails on maintenance. The index itself is maintained incrementally as the base changes via `DeltaExecutor` `{kind:'row', keyColumns}`; the row-time lookup must see pending in-statement writes (read-your-writes), like the live BTree does today — not a commit snapshot. This generalizes to non-unique indexes (no lookup-rejection, just the ordered access path) and to "at most N" (lookup-and-count).

### Conditions and gotchas

- **NULL semantics diverge.** `unique` treats NULLs as *distinct* — the memory vtab skips rows where any constrained column is NULL (`manager.ts`, `checkSingleUniqueConstraint`). The existence-lookup form must mirror the skip rule: a lookup over a NULL-bearing key tuple does not match (NULLs distinct), so the index should carry `where x is not null and y is not null` (or the lookup must short-circuit on NULL). Quereus's NOT-NULL-by-default makes this moot for most columns but it is a real soundness condition for explicitly-nullable ones.
- **Row-time vs commit-time enforcement.** The materialized-index form resolves the earlier deferred-detection gotcha: the row-time existence lookup does the *in-place* detection/substitution that `insert or replace` / `or ignore` need (as `checkUniqueViaIndex` does today). Only the no-covering-structure fallback is commit-time (detection-only via `DeltaExecutor`); there, non-default conflict resolution against a covered-but-unstructured constraint either upgrades to a structure or is rejected as unsupported.
- **Recognition / declaration model.** How does the engine know a view covers a constraint? Decide between: (a) *explicit + matched* — user declares both the constraint and the view; the engine proves coverage (view's group key = constraint columns ∧ view filter ≡ constraint predicate ∧ multiplicity preserved ∧ `n ≤ 1` invariant). The prover is a consumer of `keysOf`/`isUnique`. (b) *implicit* — a logical `unique` optionally auto-materializes a covering view (today's auto-index, re-expressed). (c) *hybrid* — `unique` is logical-only; an explicit clause/DDL opts into the covering structure, falling back to the group/global assertion when none is declared. (c) best matches the "structure is optional, correctness isn't" goal.

## Interaction with Other Features

- Indexes can be created on materialized views (they are backed by real tables) — and, per the framing above, an index *is* such a view (a materialized view with `order by`).
- **Layered schemas / lenses** (`docs/lens.md`) build directly on this primitive. Indexes are a *basis-layer* concern expressed as materialized views; a unique *constraint* is a *logical* claim, and the materialized index that covers it is its optional physical structure. The lens layer attaches the logical constraint at the mapping boundary and routes set-level enforcement to the existence-lookup described here. This ticket is the covering-structure substrate the lens work assumes — they should be planned with awareness of each other.
- Declarative schema should support materialized views (including any constraint-covering declaration).
- `drop materialized view` drops the backing table and detaches any `DeltaSubscription`.
- A covering view's lifecycle is tied to its constraint: dropping the constraint should drop (or orphan) the covering structure, and vice versa per the chosen declaration model.

## Open Questions

- Should `create materialized view` use a specific module for the backing table, or always use MemoryTable?
- Should there be a `concurrently` option for refresh (allowing reads during refresh)?
- How to handle schema changes in source tables — invalidate the materialized view?
- ~~Is commit-time (deferred) enforcement coverage sufficient, or must `insert or {replace,ignore}` against a covered constraint still fall back to a row-time structure?~~ **Resolved:** the covering structure is a materialized index supporting a row-time existence lookup; commit-time `DeltaExecutor` is only the no-structure fallback. See "Covering form" above.
- Which declaration/recognition model (explicit-matched / implicit / hybrid) — and is the coverage prover worth building before the implicit fallback exists? (Note: the lens layer in `docs/lens.md` adopts the hybrid/explicit-attached model — the constraint is logical and attached by the lens, the structure optional — and folds the "coverage prover" into the lens prover that discharges GetPut/PutGet.)
