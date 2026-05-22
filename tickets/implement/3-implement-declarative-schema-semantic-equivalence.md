description: Land an integration harness that asserts every constraint, default, generated column, partial-index `where` clause, FK action, and view body behaves identically when built via direct `create table` / `create view` vs `declare schema` + `apply schema`. Closes the integration-level gap behind issues #21 (view body compound-select round-trip lost), #22 (CHECK round-trip lost a parenthesisation), and #23 (CHECK round-trip lost `on delete`) — three regressions a single "direct ≡ declarative" probe would have caught. Two layers: a hand-curated witness suite (`.spec.ts` driver, not raw sqllogic — see Phase 0) and a `fast-check`-driven property suite.
prereq: implement-ast-stringify-roundtrip-property-test
files:
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/test/logic/50-declarative-schema.sqllogic
  packages/quereus/test/property.spec.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
  docs/architecture.md
  docs/schema.md
----

## Background

See `tickets/plan/3-plan-declarative-schema-semantic-equivalence.md`
(this ticket's source) for the motivation, the full bug walk for #21 /
#22 / #23, the corpus rationale, and the contract this harness guards.
tl;dr — the implicit contract is

```
direct = freshDb(); direct.exec(canonicalDDL(S))
applied = freshDb(); applied.exec(`declare schema main { ... } apply schema main`)
⇒ direct.schema ≡ applied.schema   AND   ∀ probe ∈ S: run(probe,direct) ≡ run(probe,applied)
```

No test enforces it today; this ticket lands the oracle.

The sibling AST round-trip ticket
(`implement-ast-stringify-roundtrip-property-test`) is a **prereq**
because the structural-expression compare here reuses its
`assertAstEquivalent`. If that helper has not landed when this work
starts, fall through to the "minimal stand-in" path described in
Phase 1.

## Approach

Two layers, complementary:

1. **Curated witness suite** — every shape in the corpus (CHECK,
   defaults, generated, FK, indexes, views, assertions, table
   decorations) appears as a named test row whose failure points
   straight at the responsible stringifier / parser path. Lives in
   a new `.spec.ts` driver, not `.sqllogic` (see Phase 0).

2. **Property suite** — `fast-check` arbitrary over a constrained
   `CreateTableStmt` / `CreateViewStmt` AST subset, serialised both
   as canonical DDL and as a declarative-schema body, applied to
   fresh DBs, compared. Acts as the dragnet against shapes the
   curated suite missed.

Probes drive DML against both DBs and compare row sets and error
classes. Catalog comparison runs in addition so that a probe set with
a coverage gap doesn't hide a `TableSchema` field mismatch.

## Phase 0 — Harness location decision

The original plan said `test/logic/51-declarative-equivalence.sqllogic`
"with a small extension". Reality check before committing to that:

- Inspect `packages/quereus/test/sqllogic.spec.ts` (the runner) to see
  whether each block can address two parallel DBs in the same file.
  The block-comparison pattern ("apply same schema to two DBs,
  diff their behaviour") is unusual for sqllogic, which assumes
  one database per file.
- **Recommended:** new file
  `packages/quereus/test/declarative-equivalence.spec.ts` — a Mocha
  driver that owns two `Database` instances per case. Each case is
  a `{ name, declarativeBody, canonicalDDL, probes }` tuple; the
  driver runs both DBs, asserts catalog equivalence, then iterates
  probes. This keeps the dual-DB plumbing in TypeScript where it
  belongs and lets us derive `canonicalDDL` programmatically from
  `declarativeBody` for most cases (run `diff schema main` on a
  fresh DB and capture the emitted DDL).
- If after reading the sqllogic runner you decide the `.sqllogic`
  extension is genuinely cheaper, document why in the spec file's
  header comment.

The corpus itself (the `Cases` array) stays human-readable and is
the durable artifact regardless of which harness wraps it.

## Phase 1 — `assertTableSchemaEqual`

Place in `packages/quereus/test/util/schema-equivalence.ts` (new).

Compare on the **live `TableSchema`** objects looked up from
`db.schemaManager` after each path applies. Fields that matter for
constraint evaluation (every one of these has either an existing or
plausible regression path):

- `columns[*]`: `name`, `logicalType`, `notNull`, `defaultExpr`
  (**structural — reuse `assertAstEquivalent` from prereq**),
  `collation`, `generated`, `primaryKey`, `pkOrder`, `tags`.
- `primaryKeyDefinition`.
- `checkConstraints[*]`: `name`, `expr` (structural — #22 shape),
  `operations` mask (#23 shape), `deferrable`, `initiallyDeferred`,
  `defaultConflict`, `tags`.
- `foreignKeys[*]`: parent table, child + parent column lists in
  order, `onDelete`, `onUpdate`, `deferrable`, `initiallyDeferred`.
- `indexes[*]`: columns + directions, uniqueness, partial `where`
  predicate (structural), tags.
- `vtabModuleName` + module args.
- `tags` at table level.

Views: equivalent function `assertViewSchemaEqual` comparing the
stored view body AST structurally (this is the #21 probe).

Helpers must produce a precise mismatch path on failure
(e.g. `checkConstraints[0].operations: 0b011 ≠ 0b111`), not a
40-line object diff. fast-check shrinking depends on a discriminating
failure message.

**Minimal stand-in** (if prereq's `assertAstEquivalent` is not yet
on `main`): inline a stripped expression comparator that handles only
the node kinds the corpus exercises (`LiteralExpr`, `IdentifierExpr`,
`BinaryExpr`, `UnaryExpr`, `InExpr`, `SubqueryExpr`,
`FunctionCallExpr`, `CaseExpr`). Mark with a `TODO(remove-once-prereq-lands)`
so it's deleted on rebase.

## Phase 2 — `assertProbeEquivalent`

Place alongside Phase 1's helper.

```ts
type Probe =
  | { sql: string; expect: { rows: any[]; ordered?: boolean } }
  | { sql: string; expect: { error: { status: StatusCode; messageIncludes?: string } } };

async function assertProbeEquivalent(a: Database, b: Database, p: Probe);
```

Behaviour:

- Run `p.sql` against both DBs. Collect either rows or the caught
  `QuereusError`.
- Both sides must agree on outcome class (rows vs error).
- For rows: compare against `p.expect.rows`; if `ordered: false`,
  sort by JSON-canonical row before compare. Use the existing
  row-comparison util in `property.spec.ts`
  (`deepEqualIgnoringZeroSign`) — promote it to a shared util if
  needed.
- For errors: assert `error instanceof QuereusError`, agree on
  `StatusCode`, agree on `p.expect.messageIncludes` substring if
  given. Allow the two DBs' human messages to differ; the **author's
  expectation** is the third oracle.

Three-oracle invariant: both DBs **and** the hand-written expectation
must agree. A regression that lands in both paths still fails the
expectation.

## Phase 3 — Curated corpus

Populate `Cases` (in the harness file from Phase 0) with the full
list from the plan ticket's "Corpus" section. Restate here as the
implement check-list:

**CHECK constraints** — row-only; cross-table `not in` subquery
(#22); cross-table `in` subquery; `on insert` / `on update` /
`on delete` and all paired masks (#23); each `on conflict` action;
`committed.<table>` transition CHECK; UDF-referencing CHECK; negative
forms `not exists (...)` and `not <p>`.

**Defaults** — literal; expression; references `with context`
variable; `case`-expression default; function-call default.

**Generated columns** — virtual; stored; subquery-bodied (if engine
supports — confirm via existing test files before writing).

**Foreign keys** — every `on delete` action × every `on update`
action (cartesian, but cheaply — one row per pair); multi-column
FK; `deferrable initially deferred`.

**Indexes** — plain; unique; partial with `where col not in (...)`
(the #22 shape applied to indexes).

**Assertions** — `create assertion ... check (not exists (select 1
from t where p))`. Probe: a query whose plan should fold to
EmptyRelation by the assertion's premise.

**Views** (#21 surface) — body is `union`, `union all`, `intersect`,
`except` (3 legs each so first-leg-only regressions show in row
count); body is `with cte as (...) select ...` (single + multi-CTE);
body is `values (...)`; body with `order by` / `limit` / `offset`;
body with `distinct`; body with window (`row_number() over ...`);
body with `full outer join` and `using`; body with correlated SELECT-
list subquery; `create view V (a, b) as ...` column-list rename.

**Cross-shape view probe** — `check (col in (select c from V))`
where `V` is a compound select; ensures equivalence carries through
to subquery-funneling.

**Decorations** — `with context (...)`; `with tags (...)` at
column / table / constraint / index level; vtab module + args.

For each entry: at least one DML probe that succeeds, one that the
constraint rejects, and one three-valued-logic edge (NULL on a
constrained column) where applicable.

## Phase 4 — Property suite

Add a new `describe('Declarative-schema equivalence (property)')`
block to `packages/quereus/test/property.spec.ts`.

Generator: a constrained `fast-check` arbitrary for a `TableShape`
plus an optional `ViewShape`. Arbitraries:

- columns: 1–4 columns, mixed types, optional `not null`, optional
  default (literal or simple expr).
- 0–2 CHECK constraints with bounded predicate complexity (no
  free-form subquery — use a small list of pre-vetted predicate
  shapes including `not in` and `is null`).
- 0–1 FK to a sibling generated table.
- 0–1 partial index `where`.
- 0–1 view defined as compound select over the table.

For each generated shape:

1. Render to canonical DDL (direct `create table` / `create view`).
2. Render to a declarative-schema body.
3. Fresh DB each; apply both.
4. `assertTableSchemaEqual` (+ `assertViewSchemaEqual` if a view).
5. Generate a small set of seed rows from the same arbitrary; run
   the same `insert` / `select` / `update` / `delete` against
   both DBs and compare via `assertProbeEquivalent`.

`fast-check` shrinker should report the SQL of both renders on
failure (i.e. include `canonicalDDL` and `declarativeBody` in the
generated value, not just the structural shape, so the dev sees
the exact SQL to paste into a repro).

Default `numRuns` is `50`; gate higher (`200`) behind
`process.env.PROPERTY_LONG`. Keep the per-run cost low — the suite
must remain runnable inside the default Mocha timeout.

## Phase 5 — Docs touch-ups

- `docs/architecture.md` — append a bullet under § Testing Strategy
  naming the equivalence layer and what it guards.
- `docs/schema.md` — single sentence under the declarative-schema
  description stating the equivalence guarantee is enforced by
  `test/declarative-equivalence.spec.ts` + property suite.

## Out of scope (do not expand into)

- Apply-schema *flow* properties (idempotency, dry-run, rename
  policy, version + hash). Already covered by
  `50-declarative-schema.sqllogic`.
- Performance / plan-shape equivalence. Covered by
  `test/plan/golden-plans.spec.ts`.
- Search-path matrix beyond a single non-`main` curated case.

## Expected failures on day one

Until #21 / #22 / #23 fixes land:

- View compound-select rows in Phase 3 should fail equivalence
  with `direct returns 3*n rows, applied returns n rows`. If they
  pass, the sibling
  `fix-check-on-delete-lost-in-declarative-apply` / view-body fix
  has already landed for them — note this in the PR.
- CHECK round-trip rows with `not in` subqueries should report
  `expected error CONSTRAINT, got rows` on `applied` until #22's
  parser fix lands.
- CHECK rows with `on delete` should report `operations: 0b111 ≠
  0b011` (the diff happens after constraint runs on the wrong
  events).

Either land this **after** those three fixes, or land it first with
the failing rows marked `it.skip` and a one-line link to the
expected-failure ticket; remove the skip when each fix lands. The
latter route is the recommended one — landing the harness first
means each fix is gated on it.

## TODO

Phase 0 — Harness location
- Read `packages/quereus/test/sqllogic.spec.ts` to confirm the dual-DB pattern won't fit cleanly; commit to `test/declarative-equivalence.spec.ts` (Mocha + chai). If you decide otherwise, document why in the file header.
- Sketch the `Case` record shape and the `runCase()` driver loop (build both DBs, call schema equivalence helper, iterate probes).

Phase 1 — Schema equivalence helper
- Read `packages/quereus/src/schema/table.ts` and capture the exact field set on `TableSchema` / `ColumnSchema` / `RowConstraintSchema` / `IndexSchema` / `ForeignKeyClause` (or equivalent type names in this codebase) so the comparator's coverage is exhaustive.
- Implement `packages/quereus/test/util/schema-equivalence.ts` with `assertTableSchemaEqual` and `assertViewSchemaEqual`. Reuse `assertAstEquivalent` from the prereq if present; otherwise inline the minimal stand-in and mark it `TODO(remove-once-prereq-lands)`.
- Self-test the helper with two trivially identical and two trivially divergent schemas before wiring into the corpus.

Phase 2 — Probe runner
- Implement `assertProbeEquivalent` in the same util file.
- Move `deepEqualIgnoringZeroSign` from `test/property.spec.ts` to `test/util/` if needed (only if it isn't already shared); update its sole call site.
- Confirm error path: thrown `QuereusError` exposes `.code` (or `.status` — check `src/common/errors.ts`) and that both DBs surface the same `StatusCode` for the same violation.

Phase 3 — Curated corpus
- Build out the `Cases` array case-by-case, in the order listed under "Phase 3" above (CHECK → Defaults → Generated → FK → Indexes → Assertions → Views → cross-shape → decorations). For each case, write the schema, the canonical DDL (or have it derived), and the probe list with hand-written expectations.
- For view cases, write probes that count rows AND select with deterministic ordering, so a "first-leg-only" regression shows in row count (the #21 fingerprint).
- For CHECK `operations` cases, write probes that fire on UPDATE-only vs INSERT-only vs DELETE-only paths so a wrong mask is observable.
- Mark expected-failure cases with `it.skip(...)` referencing the corresponding fix ticket if those fixes have not yet landed.

Phase 4 — Property suite
- Add `describe('Declarative-schema equivalence (property)')` in `packages/quereus/test/property.spec.ts`.
- Build the constrained `fast-check` arbitrary for table + optional view + small DML probe set.
- Wire to the same `assertTableSchemaEqual` / `assertProbeEquivalent` helpers.
- Gate high-run mode behind `PROPERTY_LONG` and keep default `numRuns` at `50`.

Phase 5 — Validation
- `yarn workspace @quereus/quereus run lint` — expect clean.
- `yarn workspace @quereus/quereus test` streamed with `tee` (see AGENTS.md). Confirm the new suite runs; expected failures (if any) match the "Expected failures on day one" list above. Any *unexpected* failures: investigate before merging.
- Do NOT run `yarn test:store` or `yarn test:full` — out of scope for this ticket per AGENTS.md.

Phase 6 — Docs
- Append the testing-strategy bullet in `docs/architecture.md`.
- Add the equivalence-guarantee sentence to `docs/schema.md`.
