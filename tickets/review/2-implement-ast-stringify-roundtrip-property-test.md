description: Review the AST-level round-trip property test landed in `packages/quereus/test/emit-roundtrip-property.spec.ts` + comparator in `test/emit-roundtrip-comparator.ts`. The implement stage delivered a working oracle (20 new specs, all green) and surfaced several stringifier↔parser mismatches that this ticket should triage into separate fix tickets.
files:
  packages/quereus/test/emit-roundtrip-property.spec.ts
  packages/quereus/test/emit-roundtrip-comparator.ts
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/parser.ts
  docs/architecture.md
----

## What landed

- `test/emit-roundtrip-property.spec.ts` — fast-check property suite that
  generates ASTs (not SQL) and asserts `parse(stringify(ast)) ≡ ast`
  structurally for each major DDL family + transactional + DML smoke.
  One `it()` per AST family so failures localize.
- `test/emit-roundtrip-comparator.ts` — `assertAstEquivalent(a, b)` deep
  structural compare with documented default-equivalence tables
  (`DEFAULT_EQUIVALENCES`, `FALSE_DEFAULT_FIELDS`, `EMPTY_RECORD_DEFAULT_FIELDS`).
  Self-tested in the spec file (8 explicit cases — positional drop,
  case-fold, default-equivalence both directions, plus a positive
  "this is what a real drop looks like" case via `operations`).
- `docs/architecture.md` — added a bullet under § Testing Strategy
  Property-Based Tests pointing at the new spec.

Existing `test/emit-roundtrip.spec.ts` (string round-trip) and
`test/emit/ast-stringify.spec.ts` (the prereq's pinpoint tests) both stay
green; the new test is additive.

Validation run from repo root:

- `yarn workspace @quereus/quereus run lint` → clean
- `yarn workspace @quereus/quereus run build` → clean
- `yarn workspace @quereus/quereus run test` → 3246 passing, 0 failing

## What it caught (open as separate fix tickets)

The property test was deliberately constrained to **not** generate the
combinations below — the test would fail today because the stringifier
drops the field or emits SQL the parser can't read. Each is documented
in the arbitrary as a "Note:" comment so future work can lift the
constraint after the fix lands. Reviewer: spin one fix ticket per item.

1. **`CREATE TEMP TABLE` / `CREATE TEMP VIEW` cannot round-trip.**
   `ast-stringify.ts:1034-1037` / `:739-742` emits `create temp …`, but
   `parser.ts:2144 createStatement` dispatches directly on
   TABLE/INDEX/VIEW/ASSERTION/UNIQUE with no TEMP/TEMPORARY hop —
   so `create temp table x (…)` fails with "Expected TABLE, [UNIQUE]
   INDEX, VIEW, ASSERTION, or VIRTUAL after CREATE." The TEMP/TEMPORARY
   detection at `createTableStatement:2171` and
   `createViewStatement:2350` is unreachable because TABLE/VIEW has
   already been consumed by the dispatcher.
   - Fix location: add a TEMP/TEMPORARY peek in `createStatement`
     before dispatch (or in the top-level CREATE switch in `parse`).
   - Property test: drop the `isTemporary: false` constraint in
     `createTableArb` / `createViewArb` (each carries a `Note:` comment
     citing this finding).

2. **`INSERT … on conflict <res>` (legacy) cannot round-trip.**
   `ast-stringify.ts:566-568` emits `on conflict <res>` for a non-ABORT
   `InsertStmt.onConflict`, but `parser.ts:410` now requires the
   UPSERT shape (`ON CONFLICT [(cols)] DO …`); the legacy trailing form
   was retired. The `onConflict` field is populated *only* by the
   `INSERT OR <res>` lead-in (`parser.ts:333-339`), so the stringifier
   should emit `insert or <res> into …` instead of the trailing form.
   - Fix location: in `insertToString`, prepend `or <res>` after `insert`
     when `onConflict` is set; remove the trailing emission at line 566.
   - Property test: drop the "Note: onConflict can't round-trip"
     constraint in `insertArb` (the arb currently omits the field).

3. **`analyze <schema-only>` cannot round-trip.**
   `ast-stringify.ts:807-811`'s final clause emits `analyze <schemaName>`
   when only `schemaName` is set, but `parser.ts:2700-2705` only ever
   produces `analyze` with `tableName` (and optionally `schemaName`
   when a dotted name was parsed) — it parses a single bare identifier
   as `tableName`, not `schemaName`. So the AST shape
   `{schemaName, tableName: undefined}` is unreachable from any SQL
   input, but the stringifier emits SQL that *re-parses to a different
   shape*.
   - Fix candidates: (a) treat the schema-only branch as a planner
     contract violation and throw in the stringifier; or (b) emit a
     SQLite-style `analyze <schemaName>.*` if/when the parser learns
     that syntax. Discuss with project owner before fixing — this is a
     spec choice as much as a bug.
   - Property test: `analyzeArb` only generates none / `tableName` /
     `schemaName+tableName`; schema-only is excluded.

## Other gaps the property test does **not** yet probe (worth filing)

The property test is intentionally bounded; these are known drops the
ticket left out of scope. Each warrants its own fix ticket:

4. **`ForeignKeyClause.deferrable` / `initiallyDeferred` dropped.** Parser
   sets them (`parser.ts:3680-3720`), stringifier never emits — the
   `ast-stringify.ts:1-13` header even calls this out as a TODO. Easy
   fix: emit `[not ]deferrable [initially deferred|immediate]` after the
   `on delete`/`on update` clauses in both `columnConstraintsToString`
   (column-level FK) and `tableConstraintsToString` (table-level FK).
   After landing, extend the FK arbitraries in `emit-roundtrip-property.spec.ts`
   (search for `// REFERENCES`) to generate these fields.

5. **`ColumnConstraint.deferrable` / `initiallyDeferred` are never
   populated by the parser** (only the embedded ForeignKeyClause has
   them — see Phase 1 audit). The fields exist on the type but are
   dead. Either remove from the type, or wire the parser to set them
   when a `[not ]deferrable …` clause follows a CHECK/UNIQUE/PK
   constraint (SQLite syntax). Same for `TableConstraint`.

6. **DeclareSchema items are stubbed in the stringifier.**
   `ast-stringify.ts:870-887 declareItemToString` emits placeholders
   like `table X { ... }` — the actual table/view/index bodies are
   not serialized. No round-trip is possible. Out of scope of the
   property test (the arbitrary skips `DeclareSchema` entirely), but
   worth filing.

7. **Booleans defaulting to `false` are not distinguished from "missing"
   in the AST.** The comparator now treats missing ≡ false for
   `distinct`, `all`, `ifNotExists`, `isTemporary`, `isUnique`, and
   `ifExists`. If any downstream code (planner) starts to care about
   the absence/presence distinction, this normalization would mask a
   regression. Currently safe because the planner reads booleans only.

## What the comparator absorbs (documented, intended)

Centralized in `emit-roundtrip-comparator.ts`:

- Positional metadata: `loc`, `start`, `end`, `line`, `column`,
  `offset`, `pos`, `span`, `comments`.
- Lexeme on literals — dropped from compare (storage class captured by
  `typeof value`).
- Identifier-shaped string keys (`name`, `table`, `schema`, `alias`,
  `collation`, `tableName`, `schemaName`, `columnName`, `oldName`,
  `newName`, `savepoint`, `moduleName`, `targetType`) compared
  case-insensitively.
- `DEFAULT_EQUIVALENCES` — PK direction, generated stored,
  indexed-column direction, conflict resolution, CHECK operations.
- `FALSE_DEFAULT_FIELDS` — `false` booleans treated as missing.
- `EMPTY_RECORD_DEFAULT_FIELDS` — `{}` records treated as missing
  (specifically `createTable.moduleArgs`, which the parser
  unconditionally initializes).
- Tags compared as a record (order-insensitive key-set + value).

Future agent adding a new normalization: add an entry to the
appropriate table with a one-line comment citing the stringifier
location. Don't add ad-hoc branches in the comparator body.

## Risks / things to look at

- **Arbitrary tightness.** The arbitraries deliberately avoid known
  drops (TEMP, INSERT onConflict, schema-only ANALYZE) and the
  unimplemented FK deferrability. They also keep expressions tiny
  (literal / column / one shape of comparison binary) since the goal
  is DDL coverage, not expression coverage. Reviewer: verify the
  arbitraries actually exercise what they claim — `fc.sample` the
  generators briefly in the REPL or sanity-check by reading the
  `oneof` branches.
- **Numbers of runs.** 100–200 per `it()`. Whole spec runs in ~70ms
  on this machine, well under any test budget.
- **Comparator self-tests.** 8 cases including one positive failure
  (`flags a dropped CHECK operations list`). Should add one more
  positive failure once a *new* drop fix lands — e.g. once FK
  deferrability is fixed, the comparator's self-test should include
  a "missing deferrable would fail" case.
- **The `parentTypeTagOf` heuristic** for distinguishing
  ColumnConstraint vs TableConstraint by `columns` presence is
  structural rather than nominal — fragile if the AST grows a
  `ColumnConstraint.columns`. Worth a comment-block review.

## End
