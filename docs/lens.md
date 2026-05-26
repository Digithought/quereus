# Lenses and Layered Schemas

## Overview

Quereus separates a database into three relational layers, in the Codd / ANSI-SPARC tradition but expressed entirely in Quereus's own primitives (all relations virtual, key-addressed, no rowids):

- **Logical** — the relations a developer designs and reasons about, free of any storage commitment. A logical schema declares tables with columns, types, and *logical* constraints (primary key, unique, check, foreign key, not null) and nothing physical: no module association, no indexes, no storage hints. It is a pure design.
- **Basis** — the relations that modules actually back. Basis tables are ordinary `using module(...)` tables and may be spread across many modules (a single logical table can map to a columnar decomposition over several basis tables). Basis is still *relational*; it is the lowest layer a developer reasons about as relations. Covering structures — secondary indexes, unique-enforcement structures — live here as materialized views (see [Materialized Views](#relationship-to-materialized-views)).
- **Mapping (the lens)** — for each logical table, a bidirectional relational expression that realizes it over basis relations. `get` is the query that produces the logical relation; `put` is the update propagation that pushes logical mutations down to basis. The lens is *not* a schema; it is a per-logical-table **slot**, populated either by explicit `declare lens` syntax or generated internally when absent.

Below basis sits the **physical** layer — module storage layout and the on-disk/in-memory realization of covering structures. The lens never sees physical concerns; it composes over basis relations, and modules handle storage beneath.

The decisive property is **decoupling**: a logical design carries no embodiment, so one logical schema can be paired with different basis schemas (a row-store, a columnar split, an exotic module) at different deployments. The lens is where a design meets a storage.

## What a Lens Is

A lens is the bidirectional-transformation (`get` / `put`) pair that Quereus's [view updateability](view-updateability.md) already provides: `get` is an ordinary `select`, and `put` is the existing predicate-driven propagation pass. The lens layer adds no new algebra. **There is exactly one operator set — relational algebra — used in both directions.** This is a deliberate design constraint:

- **`get` is relationally complete.** Any mapping expressible as a view is expressible as a lens, because a lens body *is* a view body.
- **`put` is the invertible fragment plus explicit disambiguation.** Not every relational expression has a sound, total inverse. Where propagation can infer the inverse it does; where it cannot, the gap is filled by explicit hints (`default_for`-style tags) or the mutation surfaces a structured diagnostic. Invertibility is made explicit rather than restricting the language.

To the query processor, a logical table is simply a view that is "out there, ready to go." Selecting from `Logical.T` resolves to the lens-compiled body over basis; mutating it propagates through that body via the standard view-update machinery. All lens-specific work happens at compile time: **validate, generate, and attach semantics**.

## Schema Kinds

`Schema` carries a `kind`:

- **`physical`** — module-backed schema. Tables declare `using module(...)`, may carry indexes (as index declarations or materialized views), storage tags, and the full physical surface.
- **`logical`** — declarative-only. Tables declare columns, types, logical constraints, and `with tags`. The following are rejected at build time for a logical schema: module association, indexes, and any physical storage construct. Tags *are* allowed — they are engine-facing metadata, not a physical commitment, and they survive into the compiled view.

There is no `lens` schema kind. The mapping for a logical table lives in that table's lens slot.

## The Lens Slot

Every logical table has one **lens slot** holding:

- the mapping body (a relational expression over basis), and
- the attachment of the logical spec's constraints and tags onto that body.

The slot is populated by one of two paths:

1. **Explicit** — a `declare lens` block supplies an override body for some logical tables (and may cover only some columns of a table).
2. **Generated** — when no override exists, or for columns an override does not cover, the default mapper generates the body.

At any deployment a logical table has exactly **one** active lens (its inlined body). Portability across embodiments is a *source-level* property — the same logical schema can be written against different lens+basis pairs for different targets — not a simultaneous-catalog property.

## The Default Mapper

When a lens body is not authored, it is generated. The generator is **module-specific and customizable**: the strategy of a standard row-store is the default, but modules can advertise their own logical→basis mapping so that exotic storage strategies (columnar decomposition, EAV, column-family) are accommodated without the developer authoring the join.

The default mapper is an **aligner over two independently-authored models**. Given a logical schema and a basis schema, it matches logical relations and columns to basis by name, type, and structure — and by module advertisements (e.g. "these five basis tables are a columnar decomposition sharing key `id`," from which the mapper generates the n-way join). The developer's overrides are *corrections to the alignment* plus intentional transforms; a rename is simply an alignment the developer overrode on purpose.

## Sparse Overrides

The authoring goal is **override without takeover**: a developer renaming one column of a logical table that maps to an n-way join over columnar basis tables must not be forced to write the join. Two mechanisms make this work.

### The baseline is never authored text

The generated mapping is never written into source. The authored artifact contains **only deviations**, so the source is all signal and no noise — which is precisely why full code-generation fails (it buries the intentional, abnormal mappings in generated noise). The full effective mapping is inspectable on demand ("show effective mapping") but is not the thing the developer edits.

### Overrides are merged per-attribute, on the plan tree

An override authored as ordinary SQL is consumed as a **sparse patch keyed by attribute**, not as opaque text. At compile time, for each logical table:

1. The override `select` (if any) is parsed to a relational expression.
2. Its output **attribute provenance** is read — which logical columns it covers, and from which basis expressions. Overrides are addressed by **stable attribute ID**, not by name or position, so they survive regeneration of the baseline (this rides on the existing [attribute-provenance](optimizer.md#attribute-provenance) system).
3. For every logical column the override does not cover, the default mapper generates the mapping and composes it in.

So renaming a column and later adding a column compose cleanly: the rename override is untouched, and the new column appears as an uncovered attribute the mapper fills. The merge happens at the relational-plan level — Quereus has the full parser and attribute system — never at the text level.

Most overrides cap the generated body at the boundary (rename = projection-with-alias, hide = projection-away, compute = extend, filter = restrict) and never touch the join interior. A change that *must* reach inside the join (a column now originating from a different basis table) is genuinely structural, cannot reduce to a boundary cap, and therefore correctly costs more authoring and surfaces as signal.

## Constraint Attachment

A view predicate is a read-time filter, not a write-time invariant ([view-updateability §Interaction with Constraints](view-updateability.md#interaction-with-constraints)). The lens layer is therefore where the logical spec's constraints become **real constraints on the compiled view**, attached explicitly from the logical declaration rather than inferred from the body. Enforcement splits by class:

- **Row-local (`not null`, `check`)** — evaluable on the projected row being written, so a non-materialized lens enforces them for free at the write boundary. This is the common case; most mappings need nothing extra.
- **Set-level (`unique`, primary key)** — enforced by an existence lookup: "does a row with this key already exist?" The lookup uses a basis covering structure (a materialized index) when one exists — O(log n), row-time, which also enables `insert or replace` / `or ignore` conflict resolution — and otherwise falls back to the commit-time group/global assertion scan via `DeltaExecutor` (O(n), detection-only).
- **Foreign key** — a cross-relation existence invariant, enforced at commit via `DeltaExecutor` against the referenced relation. A covering structure is optional.

This realizes the principle that **a constraint is a logical claim, and the structure that enforces it is an optional physical optimization** — see [Materialized Views](#relationship-to-materialized-views).

## Validation: lens laws as the completeness check

Because the logical spec and the lens body are authored (or generated) independently, the lens layer **proves they agree**. Each constraint in the logical spec plays one of two roles, decided by whether the lens body already guarantees it:

- **Body proves it** → the spec entry is a *proof obligation* (a completeness check). It contributes keys/FDs to the optimizer at zero enforcement cost. Example: the spec declares `unique(x,y)` and the body is `group by x,y`, or `select * from t` where basis already guarantees it.
- **Body does not prove it** → the spec entry is an *enforced boundary constraint*, per [Constraint Attachment](#constraint-attachment).

These proof obligations are the lens laws restated in Quereus's own terms: **PutGet** ("the mapping loses no logical guarantee") and **GetPut** ("round-tripping basis through the lens is faithful") are exactly the cross-checks that the compiled view's inferred FD / key / domain surface conforms to the logical spec. The prover is a consumer of the same key-inference surface the optimizer uses; what it cannot prove, it reports — it never silently assumes coverage.

## Deployment Is a Compile Step

Quereus is a query-processing engine, not a deployment system, but it exposes the ingredients an application needs to assemble a complete deployment story. Deploying a logical schema against a basis is a **compile**:

1. **Generate / diff the basis.** The basis is a generated-then-frozen artifact. On each deploy it is diffed against the deployed representation by the declarative-schema differ. Logical evolution produces *additive* basis diffs (new column / table). A column removed from the logical schema does **not** cascade to a basis drop: the mapping detaches and the basis column is retained for later garbage collection. This asymmetry — logical removals never drop basis storage — is what keeps the basis append-mostly and migrations safe.
2. **Compile the lens.** For each logical table, merge the override (if any) with generated gaps into an effective view body over basis, addressed by stable attribute ID.
3. **Register inline.** `Logical.X.T` resolves to that effective body; the query processor sees an ordinary view. The logical spec's constraints are attached at the lens boundary.

The authored source stays sparse (signal only). The *compiled* effective mapping is the inspectable, generated-on-demand artifact (the noise). Because the basis is frozen and the effective lens is recomputed at compile from frozen inputs, the result is deterministic, not a moving target.

### The deployed basis representation

Migrations require a stable record of *what is deployed*, so that augmentations can be generated against it and basis invariants verified to be intact. The deployed basis is therefore persisted and **hash-coded** (reusing the schema hasher). A deploy compares the freshly generated basis against the deployed hash, computes the additive diff, and — for data-effecting changes (column adds with backfill, decomposition changes) — emits DDL the application can run with custom backfills, exactly as the declarative-schema pipeline already supports. Schema-only changes (rename, hide) are metadata; data-effecting changes (split / merge / pivot) carry a backfill obligation.

## Relationship to Materialized Views

Indexes are a basis-layer concern, expressed as **materialized views**: a materialized view with an `order by` describes a clustered/ordered structure — an index. A unique *constraint* is a logical claim (it lives in the logical schema); the *index* that covers it is a basis-layer materialized view. The two legitimately sit at opposite ends of the stack, and the lens carries the constraint down to a level where it is enforceable while the index attaches at basis.

Unique enforcement is a key existence lookup against that covering materialized view when present (row-time, conflict-resolution-capable), falling back to a commit-time `DeltaExecutor` scan when absent. See the materialized-views design for the keyed-derived-relation framing, covering-structure semantics, and the incremental-maintenance path.

## Syntax

```sql
-- Logical: design only. Constraints and tags allowed; no module, no indexes.
declare logical schema X {
  table Car (
    id int primary key,
    maxSpeed int,
    ...
  ) with tags ("domain.unit.maxSpeed" = 'kph');
}

-- Basis: today's physical schema — module-backed tables plus index materialized views.
declare schema Y {
  table CarCore (id int primary key, ...) using mem();
  table CarPerf (id int primary key, speed int, ...) using mem();
  create materialized view ix_carperf_speed as
    select speed, id from CarPerf order by speed;   -- clustered index over CarPerf
}

-- Lens: binds logical X to default basis Y; supplies sparse overrides.
declare lens for X over Y {
  view Car as
    select id, speed as maxSpeed              -- rename override
    from Y.CarCore join Y.CarPerf using (id);  -- other Car columns gap-filled
  -- tables of X not mentioned here are auto-mapped against Y entirely
}
```

- `declare logical schema X { ... }` — `kind: 'logical'`, declarative end-state, diffed by the schema differ.
- `declare lens for X over Y { ... }` — names the logical schema (`for X`) and the default basis (`over Y`), and populates lens slots. Unmentioned tables are auto-mapped; columns unmentioned within a mentioned table are gap-filled. The basis binding lives on the lens, never on the logical schema — that is what keeps the logical schema embodiment-free and lets one logical schema target multiple bases across deployments.

## Implementation Surface

- `src/schema/schema.ts` — `Schema.kind: 'physical' | 'logical'`.
- `src/schema/table.ts` — `vtabModule` optional for logical tables; a logical table is represented like a view (full constraints, deferred body) so downstream code follows the existing `isView` path.
- `src/schema/lens.ts` — the per-logical-table lens slot: override AST, default-basis binding, compiled effective body, attached constraints.
- `src/planner/building/declare-schema.ts` — extended to parse `declare logical schema` and `declare lens for … over …`; rejects physical constructs under `kind: 'logical'`.
- `src/schema/lens-compiler.ts` — compile step: aligner + per-attribute merge of override ⊕ generated gaps, addressed by stable attribute ID; emits the inline effective view body.
- `src/schema/lens-prover.ts` — proves the compiled body's FD / key / domain surface conforms to the logical spec (the PutGet / GetPut completeness checks); reports unproven obligations.
- `src/schema/schema-differ.ts`, `src/schema/schema-hasher.ts` — basis generation/diff with the logical-removals-do-not-drop-basis asymmetry, and the deployed-basis hash.
- Module mapping advertisement — modules optionally advertise a default logical→basis mapping strategy consumed by the aligner.

The lens layer introduces no new runtime: at execution time a logical table is an inlined view, driven by the existing optimizer, [view updateability](view-updateability.md), and [materialized-view](incremental-maintenance.md) machinery. All lens-specific behavior is compile-time validate / generate / attach.

## Background

- **Codd, E. F. (1970); ANSI-SPARC three-schema architecture.** The external / conceptual / internal separation. Quereus's logical / mapping / basis layering is this separation expressed over virtual, key-addressed relations.
- **Foster et al. (2007). "Combinators for Bidirectional Tree Transformations" (lenses).** The `get` / `put` formulation and the GetPut / PutGet laws. Quereus realizes lenses without a dedicated combinator language — relational algebra is the lens vocabulary, and the laws become the completeness checks the lens prover discharges.
- **Date & Darwen, "The Third Manifesto."** Any relation expression is a first-class mutation target — the basis on which a logical table can be an inlined, mutable view.
- **Dataphor (Alphora, D4).** Precedent for view-as-first-class-target with mapping metadata; Quereus extends it with FD/EC-driven default recovery and the sparse-override-over-generated-baseline authoring model.

## Departures and Non-Goals

| Topic | Quereus | Rationale |
|---|---|---|
| Logical-table indexes | Not allowed. | Indexes are basis-layer materialized views; logical is embodiment-free. |
| `with check option` on a lens | Not a separate feature. | Constraints are attached from the logical spec and enforced at the lens boundary; predicates remain read-time filters. |
| Separate lens algebra | None. | Relational algebra is the lens vocabulary in both directions. |
| Deployment orchestration | Out of scope. | Quereus exposes generate / diff / hash / emit-DDL ingredients; the application assembles the deployment. |
