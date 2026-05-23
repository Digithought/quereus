---
description: Materialized views as keyed derived relations — cached query results with refresh strategies, AND covering structures that physically realize/enforce constraints (e.g. a unique constraint) while keeping the constraint itself logical.
prereq: unified-key-inference-surface
files: packages/quereus/src/schema/view.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/planner/building/create-view.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, docs/incremental-maintenance.md, docs/optimizer.md
---

## Overview

Materialized views are views whose results are cached in a backing (virtual) table for fast reads. Unlike regular views (which re-execute the SELECT on each access), materialized views store their result set and are kept current by refresh — manual at first, incremental later.

Framed in Quereus terms (all tables virtual, key-addressed, no rowids), a materialized view is a **keyed derived relation**: a stored relation defined by a query, with a primary key, maintained as its base data changes. Several existing concepts are special cases of this one primitive:

- a **secondary index** is a keyed derived relation projecting the indexed columns + PK, keyed/ordered on the index columns (covers *reads*: lookup/ordering);
- a **unique constraint's physical structure** is a keyed derived relation over the constraint columns that can *detect duplicates* (covers *enforcement*);
- a general **materialized view** is the unrestricted case.

Today the unique-constraint case is hardcoded: declaring `unique(x, y)` auto-creates a secondary BTree via `LayerManager.ensureUniqueConstraintIndexes()` (`vtab/memory/layer/manager.ts`), fusing the logical key claim with a physical structure at declaration time. A goal of this work is to **separate those concepts** (see "Covering structures" below).

This is lower priority than FK constraints, computed columns, and ALTER TABLE. The design below captures the key decisions; detailed planning (and likely a split into several plan/implement tickets — read-caching vs. constraint-covering are largely independent) should happen when this moves to plan stage.

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

### The multiplicity rule (why `select distinct` does NOT cover)

Enforcement coverage requires the view to **preserve multiplicity** over the constraint columns. A view defined as `select distinct x, y` (or any dedup) is the *wrong* shape: it collapses duplicate `(x,y)` rows into one, so a duplicate insert produces no observable change and the violation is silently absorbed. A `distinct` view is also *total* — satisfiable on every base, duplicates included — so its maintenance can never fail, and a structure that can never fail enforces nothing. Its `(x,y)` key is definitionally true (DISTINCT manufactures it) and carries zero information about the base.

The covering form preserves the count:

```sql
create materialized view mv_t_xy as
  select x, y, count(*) as n from t group by x, y;   -- pk inferred: (x, y)
-- covering invariant:  n <= 1   ⟺   unique(x, y) on t
```

Here the PK `(x,y)` is inferred soundly from `group by` (not from a tautological DISTINCT), the count `n` makes the violation observable (1 → 2 on a duplicate), and the invariant `n <= 1` *can fail*, which is the point. This is exactly `group by x,y having count(*) > 1` — the textbook duplicate finder — so recognition is structural rather than vacuous. It maps onto a `DeltaExecutor` `{kind:'group', groupColumns:[x,y]}` subscription with the `n ≤ 1` invariant as the group-delta assertion.

(The alternative — `select x, y from t` with no dedup and a declared PK `(x,y)` — also covers, but that is just a unique index expressed as a view: the PK declaration *is* the constraint, so it gains nothing from the MV framing. The count form is the MV-native one and generalizes to "at most N".)

### Conditions and gotchas

- **NULL semantics diverge.** `unique` treats NULLs as *distinct* — the memory vtab skips rows where any constrained column is NULL (`manager.ts`, `checkSingleUniqueConstraint`). `group by` / the delta group mode treat NULLs as *equal* (one group). A count-form view over a *nullable* constraint would falsely flag two NULL-bearing rows; it must carry `where x is not null and y is not null` to mirror the skip rule. Quereus's NOT-NULL-by-default makes this moot for most columns but it is a real soundness condition for explicitly-nullable ones.
- **Deferred detection ≠ immediate resolution.** `DeltaExecutor` maintains/enforces at COMMIT. That can detect-and-abort but cannot do the *row-time, in-place* substitution that `insert or replace` / `or ignore` need against a unique constraint (today handled by the row-time index in `checkUniqueViaIndex`). So a commit-maintained covering view covers *detection* but not *conflict resolution*; the immediacy is part of what the current index "covers." Resolve whether covering-for-detection is sufficient, or whether conflict-resolution clauses still require a row-time structure.
- **Recognition / declaration model.** How does the engine know a view covers a constraint? Decide between: (a) *explicit + matched* — user declares both the constraint and the view; the engine proves coverage (view's group key = constraint columns ∧ view filter ≡ constraint predicate ∧ multiplicity preserved ∧ `n ≤ 1` invariant). The prover is a consumer of `keysOf`/`isUnique`. (b) *implicit* — a logical `unique` optionally auto-materializes a covering view (today's auto-index, re-expressed). (c) *hybrid* — `unique` is logical-only; an explicit clause/DDL opts into the covering structure, falling back to the group/global assertion when none is declared. (c) best matches the "structure is optional, correctness isn't" goal.

## Interaction with Other Features

- Indexes can be created on materialized views (they are backed by real tables) — and, per the framing above, an index *is* such a view.
- Declarative schema should support materialized views (including any constraint-covering declaration).
- `drop materialized view` drops the backing table and detaches any `DeltaSubscription`.
- A covering view's lifecycle is tied to its constraint: dropping the constraint should drop (or orphan) the covering structure, and vice versa per the chosen declaration model.

## Open Questions

- Should `create materialized view` use a specific module for the backing table, or always use MemoryTable?
- Should there be a `concurrently` option for refresh (allowing reads during refresh)?
- How to handle schema changes in source tables — invalidate the materialized view?
- Is commit-time (deferred) enforcement coverage sufficient, or must `insert or {replace,ignore}` against a covered constraint still fall back to a row-time structure?
- Which declaration/recognition model (explicit-matched / implicit / hybrid) — and is the coverage prover worth building before the implicit fallback exists?
