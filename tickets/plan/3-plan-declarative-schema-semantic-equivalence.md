description: Integration harness that asserts every constraint, default, generated column, partial-index `where` clause, and view body behaves identically when the same schema is built via direct `create table` / `create view` vs `declare schema` + `apply schema`. Closes the structural gap behind issues #21 (view body compound-select round-trip lost), #22 (CHECK round-trip lost a parenthesisation), and #23 (CHECK round-trip lost `on delete`) at the layer where they actually became user-visible.
prereq:
files:
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
  packages/quereus/test/property.spec.ts
  docs/architecture.md
  docs/schema.md
----
## Motivation

Issues [#21](https://github.com/gotchoices/quereus/issues/21),
[#22](https://github.com/gotchoices/quereus/issues/22), and
[#23](https://github.com/gotchoices/quereus/issues/23) are all
instances of the same architectural pattern: a constraint or view body
that *evaluates correctly under direct `create table` / `create view`*
but *evaluates differently after the same DDL is re-emitted by the
schema differ and re-parsed*. #21 loses compound-select tails in view
bodies (`union all` → single leg); #22 silently re-parenthesises a
CHECK predicate; #23 drops the `on insert|update|delete` operations
mask. All three would have failed a "direct ≡ declarative" probe.

The architecture doc (`docs/architecture.md` § Key Design Decisions →
*Declarative Schema*) presents `declare schema` / `apply schema` as a
shape-equivalent alternative to writing canonical DDL by hand: the
engine "computes diffs … and emits canonical DDL", and the user "may
auto-apply via `apply schema` or fetch the DDL and run it yourself".
The implicit contract is that the two paths converge to the **same
live schema** — same column types, same constraints, same evaluation
semantics.

Today no test enforces that contract. The sibling AST round-trip ticket
(`plan-ast-stringify-roundtrip-property-test`) closes the structural
*upstream* leak — fields the stringifier drops on the way out. This
ticket closes the *downstream* leak — semantics that diverge even when
the AST round-trips faithfully (e.g. because the parser itself
mis-handles the round-tripped shape, as in #22).

The two layers are complementary:

- **AST round-trip** catches stringifier omissions
  (`parse(stringify(parse(sql))) ≡ parse(sql)`).
- **Schema equivalence** catches everything else: parser precedence
  bugs surfaced only by re-parsing, schema-differ ordering bugs, seed-
  data application bugs, deferred-constraint setup differences, any
  optimizer transformation keyed on table provenance.

## Goal (acceptance criteria)

For a curated corpus of schemas `S`, the following must hold:

```ts
const direct  = freshDb();
const applied = freshDb();
await direct.exec(canonicalDDL(S));
await applied.exec(`declare schema main { ${declarativeBody(S)} } apply schema main;`);

// Catalog equivalence
assertTableSchemaEqual(direct, applied);

// Runtime equivalence — every probe statement in S.probes must produce
// identical results (same rows / same error code+message prefix) on both DBs
for (const probe of S.probes) {
    assertProbeEquivalent(direct, applied, probe);
}
```

Where:
- `assertTableSchemaEqual` compares the *live* `TableSchema` objects
  (columns, types, PK, FKs, CHECK constraints incl. `operations` /
  `deferrable` / `initiallyDeferred` / `onConflict`, indexes, generated
  expressions, vtab module). Bitmasks and AST sub-fields included.
- `assertProbeEquivalent` runs the same SQL on both DBs and compares
  rows (set or ordered as the probe specifies) or error class. Errors
  must agree on `QuereusError` subclass and `StatusCode`; the human
  message is allowed to differ.

The first probe failure is the integration-level twin of the
declarative-schema regressions; the catalog assert catches divergences
that aren't observable through SQL probes (e.g. operation-mask
mismatch that happens to align with the test's probe set).

## Where this lives

Two layers, complementary:

1. **Hand-curated equivalence corpus** in
   `packages/quereus/test/logic/51-declarative-equivalence.sqllogic`
   (new file) — declarative form, sqllogic-style, but each block ships
   the *same* schema twice and asserts the probe set runs identically
   on both. The sqllogic harness needs a small extension (or a
   companion `.spec.ts` driver) to load each block into two DBs and
   compare; details below.

2. **Property-based corpus** in
   `packages/quereus/test/property.spec.ts` (new `describe` block).
   Generator emits a `TableSchema`-ish object (or a constrained AST
   subset of `CreateTableStmt`), serialises it as both canonical DDL
   and declarative-schema body, applies each to a fresh DB, and
   compares. `fast-check` already drives the parser-robustness block;
   the new generator follows the same idiom.

The hand-curated tests are the human-readable witnesses; the property
tests are the dragnet.

## Corpus — schemas the curated layer must cover

Each entry is `(schema, probes)`. Probes are designed to *bisect* the
constraint: at least one row that succeeds, one that fails, and one
that exercises a three-valued-logic edge.

**CHECK constraints**

- Row-only CHECK over current row (`check (col >= 0)`).
- Cross-table CHECK with subquery — `check (x not in (select y from u))`,
  `check (x in (select y from u))`, both subquery directions. (#22's
  shape.)
- CHECK with `on insert` / `on update` / `on delete` / paired masks.
  (#23's shape.)
- CHECK with `on conflict <action>` (every action: IGNORE / REPLACE /
  FAIL / ABORT / ROLLBACK).
- CHECK referencing `committed.<table>` (transition constraint —
  `architecture.md` § Constraints).
- CHECK using a registered deterministic UDF.
- Negative-form CHECK: `not exists (...)`, `not <p>` for each predicate
  the parser accepts. (Plan-ticket-2 covers the parser side; this
  ticket covers the apply-schema integration side.)

**Defaults**

- Literal default, expression default, default referencing
  `with context` variable.
- Default that involves a `case` expression or a function call.

**Generated columns**

- Virtual generated column referencing other columns.
- Stored generated column.
- Generated column with a subquery (where supported).

**Foreign keys**

- Every `on delete` / `on update` action.
- Multi-column FK.
- FK with `deferrable` / `initially deferred`.

**Indexes**

- Plain index.
- Unique index.
- Partial index with `where ...` clause (round-tripping a non-trivial
  predicate — including a `not in` body — is the #22 shape for indexes).

**Assertions**

- `create assertion ... check (not exists (select 1 from t where p))`
  — the hoisting-to-premise path described in `architecture.md` §
  Constraints. Probe: a query the assertion's premise should fold to
  EmptyRelation for.

**Views** (added for issue #21 — view body shapes silently dropped by the
DDL stringifier during `declare schema` → `diff` → `apply` round-trip)

- View whose body is a compound select — one row per operator:
  `union`, `union all`, `intersect`, `except`. Each with three legs
  minimum, so a "first-leg-only" regression (the #21 shape) is visible
  in the probe row count, not just by inspecting which legs survived.
- View whose body is a `WITH cte AS (...) SELECT ...` (single CTE and
  multi-CTE). CTEs are a distinct `SelectStmt` decoration and may have
  their own drop path.
- View whose body sources from `VALUES (...)` — direct table-construction
  literal, a different `FromClause` shape than `from <table>`.
- View body with `ORDER BY` / `LIMIT` / `OFFSET` — handled separately
  from the inner select in some stringifier paths; worth a row.
- View body with `DISTINCT`, window function (`row_number() over ...`),
  and a non-trivial JOIN shape (FULL OUTER, USING) — one row each.
- View body with a correlated subquery in the SELECT list.
- View with explicit column-list rename (`create view V (a, b) as ...`)
  applied via `declare schema`.
- Probes for each: `select count(*) from V` against the canonical DB
  and the applied DB must match; for views with deterministic ordering
  (`order by` in probe), full row equality.
- Same body shapes also exercised inside a **CHECK subquery body** in
  one paired schema (`check (col in (select c from V))` where V is
  built two ways) — confirms the equivalence guarantee extends to the
  subquery-funneling path, not just top-level view bodies.

**Table-level decorations**

- `with context (...)` survives apply.
- `with tags (...)` survives apply (column-, table-, constraint-,
  index-level).
- vtab module + args survive apply.

## Probe authoring rules

- Every probe must have an *expected behaviour* (rows or error). The
  oracle is the canonical-DDL DB, but the probe author writes the
  expected value too so a regression in *both* paths cannot hide.
- For error probes, assert on `StatusCode` (`CONSTRAINT`, `MISUSE`,
  etc.) and a stable substring of the message (e.g. the constraint
  name), not the full string.
- DML probes must include at least one INSERT that should succeed,
  one that should be rejected by the constraint, and where relevant
  one that exercises three-valued logic via NULL.

## What the schema-equivalence comparator inspects

Pulled from `packages/quereus/src/schema/table.ts` and friends; the
intent is to lock every field that constraint evaluation depends on.

- `TableSchema.columns[*]`: `name`, `logicalType`, `notNull`,
  `defaultExpr` (structural compare), `collation`, `generated`,
  `primaryKey`, `pkOrder`, `tags`.
- `TableSchema.primaryKeyDefinition`.
- `TableSchema.checkConstraints[*]`: `name`, `expr` (structural —
  *this is the field #22 silently rewrote*), `operations` mask
  (#23), `deferrable`, `initiallyDeferred`, `defaultConflict`, `tags`.
- `TableSchema.foreignKeys[*]`: parent table, column lists,
  `onDelete`, `onUpdate`, `deferrable`, `initiallyDeferred`.
- `TableSchema.indexes[*]`: columns + directions, uniqueness, partial
  `where` predicate (structural), tags.
- `TableSchema.vtabModuleName` + module args.
- `TableSchema.tags`.

Structural-expression compare is non-trivial; the natural reuse is
the same `assertAstEquivalent` helper introduced by
`plan-ast-stringify-roundtrip-property-test`. Treat this as a
dependency: if that ticket has not landed, this ticket lands a
minimal stand-in scoped to expressions actually used here.

## Out of scope

- **Apply-schema *flow* properties** (idempotency, dry-run, rename
  policy, version + hash semantics, seed application order). Those
  are orthogonal — already covered in part by
  `50-declarative-schema.sqllogic` — and not implicated in the two
  reporter bugs.
- **Performance equivalence** (plan shape, cardinality estimates).
  Equivalence here is functional, not physical. A separate
  golden-plan suite (`test/plan/golden-plans.spec.ts`) covers the
  physical side.
- **Multi-schema search paths** beyond a single curated test that
  asserts equivalence still holds for a non-`main` schema. The
  cross-schema search-path matrix is its own concern
  (`06.4-schema-search-path.sqllogic`).

## Pointers

- `packages/quereus/src/runtime/emit/schema-declarative.ts` —
  `emitApplySchema`. The diff → DDL → re-parse loop is the
  semantic boundary this ticket guards.
- `packages/quereus/src/schema/schema-differ.ts` — `computeSchemaDiff`,
  `generateMigrationDDL`. Where dropped fields originate.
- `packages/quereus/src/emit/ast-stringify.ts` — every stringifier
  this corpus exercises end-to-end.
- `packages/quereus/test/logic/50-declarative-schema.sqllogic` —
  current declarative-schema test style. New file mirrors it.
- `docs/architecture.md` § "Key Design Decisions" → *Declarative
  Schema*; § "Testing Strategy". Extend testing-strategy bullet for
  the new equivalence layer when it lands.
- `docs/schema.md` — the user-facing description of the declarative
  flow. Worth a sentence on the equivalence guarantee once this test
  layer lands.
- Issues #21, #22, and #23 — all three shapes belong in the corpus on
  day one (they are also covered by sibling fix tickets — #21 and #23
  share `fix-check-on-delete-lost-in-declarative-apply`; #22 has
  `fix-prefix-not-precedence-against-comparison` — but here as
  cross-cutting equivalence rows so a regression of any of them shows
  up at the integration layer too).
