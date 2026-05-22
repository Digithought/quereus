description: Review the new direct-vs-declarative schema equivalence harness. Two layers: a curated corpus (`test/declarative-equivalence.spec.ts`) and a `fast-check` property block in `test/property.spec.ts`. Both share a structural schema comparator (`test/util/schema-equivalence.ts`) that reuses the AST round-trip comparator landed in the prereq.
files:
  packages/quereus/test/declarative-equivalence.spec.ts
  packages/quereus/test/util/schema-equivalence.ts
  packages/quereus/test/property.spec.ts
  packages/quereus/test/emit-roundtrip-comparator.ts
  docs/architecture.md
  docs/schema.md
----

## What landed

Three test artifacts plus two docs touch-ups:

1. **`packages/quereus/test/util/schema-equivalence.ts`** — three helpers:
   - `assertTableSchemaEqual(direct, applied)` — compares the live `TableSchema` from `db.schemaManager` field-by-field. Covers columns (name, logicalType.name, notNull, defaultValue *structural*, collation, generated, generatedExpr *structural*, primaryKey, pkOrder, pkDirection, defaultConflict, tags), `primaryKeyDefinition`, `primaryKeyDefaultConflict`, CHECK constraints (name, expr *structural*, operations mask, deferrable, initiallyDeferred, defaultConflict, tags), FKs (refTable, child/parent columns, onDelete, onUpdate, deferred, defaultConflict, tags), uniqueConstraints, indexes (cols + directions, unique, partial `where` predicate *structural*, tags), vtabModuleName + vtabArgs, isView/isTemporary/isReadOnly, and table-level tags.
   - `assertViewSchemaEqual(direct, applied)` — compares name + schemaName + explicit column list + tags, and runs `assertAstEquivalent` on `selectAst` (this is the #21 fingerprint).
   - `assertAssertionSchemaEqual` — name + flags; structural compare on `checkExpression` when both sides carry it, else falls back to comparing canonicalized `violationSql`.
   - `assertProbeEquivalent(direct, applied, probe)` — runs the probe against both DBs, enforces outcome-class agreement (rows vs error), validates row payloads (ordered / unordered) or error class (`QuereusError` + `StatusCode`), and cross-checks against the test author's expectation. **Three-oracle invariant** — a regression that lands in both DBs still fails the expectation.

   Structural expression compares delegate to `assertAstEquivalent` from `test/emit-roundtrip-comparator.ts` (the prereq landed). If that helper ever degrades, this helper degrades with it — by design, the surfaces stay in lock-step.

2. **`packages/quereus/test/declarative-equivalence.spec.ts`** — Mocha + chai driver. Each `Case` is `{ name, directDDL, declarativeBody, postSetup?, expectTables?, expectViews?, expectAssertions?, probes }`. `runCase()` builds two fresh `Database`s in parallel:
   - direct: runs `directDDL` sequentially via `db.exec`
   - applied: runs `declare schema main { ... } apply schema main`

   Then runs `postSetup` (data inserts run symmetrically on both) and finally walks the probes. Currently 23 cases:
   - 4 self-tests (identical schemas pass; NOT NULL divergence, wrong expectation, outcome-class mismatch all fail loudly)
   - 6 CHECK cases (row-only; on insert,update; on delete; on update only; on insert only; named with cross-table `not in` subquery — the #22 fingerprint)
   - 2 default cases (literal + expression)
   - 2 generated column cases (virtual + stored)
   - 2 FK cases (`on delete cascade`, `on delete restrict`)
   - 2 index cases (plain + unique)
   - 2 view cases (3-leg `union all` — the #21 fingerprint; explicit column-list rename)
   - 1 cross-shape case (CHECK against a compound-select view body)
   - 1 assertion case (`positive_balance` style)
   - 1 decoration case (table-level tags)

3. **`packages/quereus/test/property.spec.ts`** — new `Declarative-schema equivalence (property)` block in the existing `Property-Based Tests` describe. Generates a constrained `TableShape` (2–3 cols, PK first, optional defaults, ≤ 1 CHECK over a single non-PK column), renders both canonical DDL and a declarative body, applies to two DBs, asserts catalog equivalence + a count probe. Gated `numRuns: 50` by default, `200` under `PROPERTY_LONG=1`. The shape carries both renders into the failure message so a shrunk counterexample dumps the exact SQL to paste into a repro.

4. **Docs** — `docs/architecture.md` § Testing Strategy gets a bullet; `docs/schema.md` § Declarative Schema gets a sentence pointing at the spec files.

## Validation done

- `yarn workspace @quereus/quereus run lint` → clean
- `yarn workspace @quereus/quereus run test` → **3271 passing, 0 failing** (no regressions, ~2 min wall clock)
- `yarn test:store` / `yarn test:full` — NOT run, per AGENTS.md (out of scope for implement)

## Honest gaps the reviewer should chew on

Treat this work as a starting point, not the finish line. Concrete things to push back on:

- **Decoration coverage is one row.** The plan ticket called for `with tags` at column / constraint / index level and `with context` mutation variables; the current corpus only exercises a table-level tag. The schema comparator already walks the tag fields on every level, so missing rows are corpus gaps, not helper gaps. Worth adding rows that put a tag on a CHECK constraint and on a column, and one row that exercises `with context`.
- **No `on update` FK actions.** Only `on delete cascade` and `on delete restrict` are covered. The plan's cartesian `(onDelete × onUpdate)` set would catch any mask drop in the parser that affects `on update`. Cheap to add — same shape as the existing FK rows.
- **No partial index case.** Plan called for `where col not in (...)` — the #22 shape applied to indexes. The helper compares `indexes[*].predicate` structurally so the surface is there; just no row exercises it. **Recommended addition** if extending the corpus.
- **No `committed.<table>` transition CHECK.** Plan listed it; out of scope on landing because the existing transition-constraint surface is exercised by `test/logic/43-transition-constraints.sqllogic` separately. Worth a row if the engine's transition-constraint path ever changes parse shape.
- **No assertion with `not exists (subquery)` row but cross-table** — current assertion case is single-table. Cross-table would exercise the dependency walker too. Cheap add.
- **Property arbitrary is intentionally small.** Two-to-three columns, ≤ 1 CHECK, no FK / index / view. The arbitrary is shaped to converge fast (~200ms for 50 runs); broadening it would amplify any failure dump but also slow the suite. The curated corpus is the targeted oracle; the property test is the dragnet.
- **Probe payload comparator is JSON-sort-based for unordered rows.** Fine for the row shapes we generate (integers + short strings); a row with a `Uint8Array` payload would compare poorly here. The helper is local so easy to swap if the corpus grows toward BLOBs.
- **`schema-equivalence.ts:eq()` uses `safeJsonStringify` fallback for object comparisons.** This means two structurally-equal objects with key order differences should compare equal, but the failure message will print serialized JSON rather than a structural diff. Fine for the small shapes we hit; could be louder for nested objects.
- **No expected-failure rows.** The plan ticket suggested optionally landing with `it.skip` rows for the #21/#22/#23 fingerprints if those fixes hadn't landed yet. Empirically, all 23 rows pass on this branch — interpreted as those fixes having already landed; double-check that this matches `main` before merging (look for the sibling fix tickets in recent git log; if any are still in `tickets/`, the corresponding row here is genuinely passing and worth understanding why).
- **Harness location decision.** Phase 0 of the plan asked for an explicit comparison vs `.sqllogic`. The reasoning is in the file header comment: sqllogic assumes one DB per file and the Case-record shape doesn't translate. Worth a second opinion if the reviewer disagrees.

## How to extend

- **Add a curated row:** drop a `{ name, directDDL, declarativeBody, postSetup?, probes }` into the appropriate `describe` block. Both `directDDL` and `declarativeBody` must declare every table the case touches — `apply schema main` is destructive and drops anything not in the declared schema, so a "preamble" pattern doesn't work (the harness deliberately has no `preamble` field for this reason).
- **Tighten the property arbitrary:** add FK / index / view branches to `tableShapeArb` in `test/property.spec.ts`. Keep `numRuns` reasonable — `200` is the long mode.
- **Track a new schema field:** add a comparison line in `assertTableSchemaEqual` (or one of its sub-helpers). The pattern is `eq(a.field, b.field, path)` for primitives, `eqExpr(...)` for AST nodes, `eqRecord(...)` for tag maps.

## Out of scope (per plan ticket)

- Apply-schema *flow* properties (idempotency, dry-run, rename policy, version + hash) — already covered by `test/logic/50-declarative-schema.sqllogic`.
- Performance / plan-shape equivalence — covered by `test/plan/golden-plans.spec.ts`.
- Search-path matrix beyond `main`.
