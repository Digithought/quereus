description: Lens-layer foundation + default name-based mapper. Shipped: `Schema.kind: 'physical' | 'logical'`, the `declare logical schema X { ... }` parser surface + DDL round-trip, the per-`Schema` lens-slot registry (`schema/lens.ts`), the default single-source name-based aligner (`schema/lens-compiler.ts`) wired into `apply schema X`, kind-aware diff/hash with asymmetric removal. A logical schema deploys against a name-equivalent basis with NO explicit lens; the compiled body is registered as an ordinary `ViewSchema` so reads ride the view path and writes ride view updateability. Design source: `docs/lens.md`.
files: packages/quereus/src/schema/lens.ts, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/schema/schema.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/schema/schema-hasher.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/runtime/emit/schema-declarative.ts, packages/quereus/test/lens-foundation.spec.ts, packages/quereus/test/logic/51-lens-foundation.sqllogic, docs/lens.md, docs/schema.md, docs/architecture.md
----

# Complete: Lens foundation + default mapper

Adversarial review of the landed lens substrate (implement commit `4d6b3d79`). The
implementation is sound and the load-bearing decision — representing a logical table as a
registered `ViewSchema` + a lens slot for the spec — holds up: reads ride the view path,
writes ride view updateability, and the spec lives in the slot for the override/prover
tickets to consume. Two real (minor) bugs were found and fixed inline, write-through
coverage was added (the prereq has now landed), and the deferred gaps are correctly scoped
to their follow-up tickets.

## Review findings

### Aspect coverage checked

- **SRP / DRY / modularity** — `lens.ts` (slot model) vs `lens-compiler.ts` (deploy/align)
  vs the catalog/differ/hasher wiring are cleanly separated; `buildLogicalTableSchema` reuses
  the existing column/PK/constraint extractors rather than re-modelling. No duplication found.
- **Type safety** — `vtabModule` made optional; verified **all** module-backed consumers are
  guarded by `requireVtabModule` (createIndex, analyze, add-constraint, alter-table ×7,
  mv-helpers). Searched every remaining `tableSchema.vtabModule.` / passed-as-arg site: the
  only survivors are `vtabModuleName` (a string, always set) and planner-local `vtabModule`
  vars sourced from `TableReferenceNode` (a distinct field), which logical tables never reach
  (they resolve as views, never as `TableReferenceNode`). `requireVtabModule` throws
  `INTERNAL` rather than silently deref'ing `undefined`. Clean.
- **Parser** — `LOGICAL` is a *contextual* keyword (`matchKeyword` falls back to an
  `IDENTIFIER` lexeme match), so a schema literally named `logical` still parses, and the
  `DECLARE` dispatch is unaffected. Verified by reading `peekKeyword`/`matchKeyword`.
- **Error handling / atomicity** — deploy compiles all bodies before mutating the catalog, so
  a failed re-apply (name mismatch, etc.) leaves existing lens state untouched. Confirmed.
- **Docs** — `docs/lens.md` (incl. the audit note on `ViewSchema` representation),
  `docs/schema.md` (Schema kinds + `requireVtabModule`), and `docs/architecture.md` (Phase-1
  shipped note) all read true against the code. No stale claims.
- **Differ / hasher** — asymmetric removal (`lensToDetach`, never `tablesToDrop`), the
  `logical\n` hash prefix, and DDL round-trip are correctly implemented and unit-tested.

### Minor — fixed inline (this pass)

1. **Column-name contract leak.** `select * from Logical.T` surfaced the **basis** column
   casing (e.g. `ID`/`Name`) instead of the **logical** declared names (`id`/`name`). Root
   cause is engine-wide, not lens-specific: view `*`-expansion canonicalizes a bare column ref
   to the base column's stored casing, and an alias that is a case-variant of the reference is
   dropped — so neither `select <logical> from B.T` nor `select <basis> as <logical> …` pins
   the output name through a view. The logical schema is the consumer-facing contract, so its
   names must be authoritative. **Fix:** populate the registered lens view's explicit `columns`
   list with the logical column names (the `create view T(cols) as …` mechanism), which *does*
   drive `select *` output naming and is unaffected by write-through (positional passthrough).
   Body now references basis-actual names; the view column list pins the logical names.
   (`lens-compiler.ts`; regression test "output column names follow the LOGICAL declaration".)

2. **Empty-schema re-apply failed on basis ambiguity.** `inferDefaultBasis` was called
   unconditionally at deploy, so re-applying an *emptied* logical schema (all tables removed —
   a pure detach) would spuriously throw "cannot infer a default basis" whenever ≥2 populated
   physical schemas exist. This contradicts the asymmetric-removal invariant (removal never
   depends on the basis). **Fix:** infer the basis **lazily**, only when there is ≥1 declared
   logical table. (`lens-compiler.ts`; regression test "re-applying an emptied logical schema
   detaches all lenses even when the basis is now ambiguous".)

3. **Missing write-through coverage (gap closed).** The implementer deferred write tests
   because `view-updateability-phase-1` was still in `implement/`. It has since landed
   (`tickets/complete/1-view-updateability-phase-1.md`), so the gap is now closable.
   **Added:** insert/update/delete through `x.t` all propagate to the basis (verified). The
   default-mapper body shape (single-source projection) is accepted by the propagation pass
   verbatim, as the implementer predicted.

### Adversarial probes run — behaved correctly, no fix needed

- **Case-insensitive name alignment** (mixed-case logical vs basis): resolves correctly;
  now also surfaces logical casing in output (finding #1). Covered.
- **Column ordering differs from basis order**: projection follows *logical* declaration
  order. Confirmed.
- **Multiple populated physical schemas incl. `main`**: errors with the 2-candidate
  `declare lens for X over …` hint — does **not** silently pick `main`. Confirmed.
- **Basis table dropped after lens deploy**: `select * from x.t` surfaces a "Table not
  found: y.t" diagnostic, the same shape an ordinary dangling view produces. Acceptable.

### Known gaps — correctly deferred, NOT blocking (already have follow-up tickets)

- **Type/nullability conformance is not gated**, and `attachedConstraints` are stored
  verbatim, not routed to enforcement → `tickets/plan/3-lens-prover-and-constraint-attachment.md`.
- **`diff schema X` for a logical schema yields no DDL rows** (the diff *object* carries
  `lensToAttach`/`lensToDetach`, unit-tested; the SQL command emits `[]` because lens
  attach/detach happens in the compiler at apply, not via runnable DDL). Acceptable MVP.
- **Re-apply is clear-and-rebuild**, so an unchanged logical schema fires remove/add events
  rather than being a no-op. Deterministic and correct; not event-idempotent. Acknowledged.
- **Plain `view` / `assertion` / `seed` items in a logical schema** are neither rejected nor
  processed (only `declaredTable` becomes a slot). Out of scope; a future decision point.
- **Schema introspection** (`schema()` TVF) lists a logical schema's lens bodies as ordinary
  `view` rows exposing the *compiled* body SQL — informational, not a crash; it does not flag
  them as logical/lens tables. Overlaps with `tickets/plan/view-information-schema-surface.md`;
  no new ticket filed to avoid duplication.
- **n-way decomposition / surrogate keys / module advertisements / re-decomposition backfill**
  remain out of scope → `tickets/plan/lens-multi-source-decomposition.md`,
  `lens-module-mapping-advertisement.md`, `lens-re-decomposition-backfill-ddl.md`.

### Validation performed

- `yarn workspace @quereus/quereus run build` (tsc) — **clean** (caught a narrowing slip in
  the lazy-basis edit during review; fixed).
- `yarn workspace @quereus/quereus run lint` — **clean**.
- Full quereus suite (`mocha test/**/*.spec.ts`) — **3814 passing, 9 pending, 0 failing**
  (includes the original 18 lens cases + 3 added: write-through, column-name contract,
  empty-schema detach).
- No `.pre-existing-error.md` written — no unrelated failures surfaced.

## End
