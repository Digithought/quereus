description: Add a property-based round-trip test that the DDL stringifier (`packages/quereus/src/emit/ast-stringify.ts`) is information-preserving for every AST permutation we accept — `parse(stringify(parse(sql))) ≡ parse(sql)` at the AST level — so silent drops like the `check on delete` regression (issue #23) and the compound-select-in-view-body regression (issue #21) cannot recur
prereq:
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/schema/schema-differ.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/test/property.spec.ts
  packages/quereus/test/schema-differ.spec.ts
  docs/architecture.md
----
## Motivation

GitHub issues [#21](https://github.com/gotchoices/quereus/issues/21) and
[#23](https://github.com/gotchoices/quereus/issues/23) — both covered by
the sibling `fix-check-on-delete-lost-in-declarative-apply` ticket — are
narrow instances of a wider class of bug. The DDL stringifier in
`ast-stringify.ts` is on the hot path for every declarative-schema apply
(`declare schema` → `computeSchemaDiff` → `generateMigrationDDL` →
`createTableToString` / `createViewToString` / `alter table ... add
<tableConstraintsToString>` → re-execute as SQL). Any field the parser
captures but the stringifier silently drops becomes a stealth regression:
the round-trip turns it into the field's default (or, in #21, lops off
every compound-select tail leg after the first), and the test suite never
notices because no test asserts AST round-trip equivalence.

The CHECK constraint case dropped at least four candidate fields:

- `operations` (issue #23 — `on insert | update | delete`)
- `deferrable`
- `initiallyDeferred`
- `onConflict` (column- and table-level `CHECK (...) ON CONFLICT <action>`)

The view-body case (issue #21) drops `SelectStmt.compound` (the
`{ op, select }` chain that encodes `union` / `union all` / `intersect`
/ `except`) because the stringifier reads a non-existent `stmt.union`
field. Same root file, different field, identical "silent default"
failure mode.

FOREIGN KEY constraints have a comparable shape (`deferrable`,
`initiallyDeferred`).  Other AST nodes (views with CTEs / VALUES sources,
indexes, assertions, TVF/module argument lists, `with context`,
`with tags`) almost certainly have their own drops; without a generative
test we are flying blind.

This ticket adds the missing oracle so the class of bug is closed by
construction.

## Goal (acceptance criteria)

A new test asserts that for every SQL DDL string the parser accepts, the
following holds at the AST level:

```ts
const a = parser.parse(sql);
const b = parser.parse(stringify(a));
assertAstEquivalent(a, b);
```

`stringify` is the top-level dispatch in
`packages/quereus/src/emit/ast-stringify.ts` (`astToString` /
`createTableToString` / `alterTableToString` / `createViewToString` /
`createIndexToString` / `createAssertionToString`).

`assertAstEquivalent` is a structural comparator that ignores positional
metadata (source spans, comments) and treats certain normalizations as
equivalent (whitespace, case of keywords, equivalent literal forms — see
§ Equivalence rules). On mismatch it reports the *path* into the AST
where the divergence occurs, so the failure tells you which field the
stringifier dropped.

The corpus is generated, not hand-written. See § Test surface.

## Where this lives

Two layers, complementary:

1. **Generative property test** in `packages/quereus/test/property.spec.ts`
   (or a new `test/emit/ast-roundtrip.spec.ts` for isolation). Uses
   `fast-check` (already in the project — see § Parser Robustness in
   `property.spec.ts`) to generate AST instances directly, then runs
   `parse(stringify(ast))` and compares against `ast`. Generating ASTs
   rather than SQL strings is the right direction: it lets us exhaust
   every constructor of every node without coupling the test to the
   parser's surface grammar.

2. **Targeted unit tests** in `packages/quereus/test/emit/` (new folder)
   that cover the known-broken or high-risk cases as deterministic
   regression locks. Each one is one of the permutations the property
   test would also catch, pinned by hand so a CI failure points at a
   specific feature rather than a fuzz seed.

The property test is the spec; the unit tests are the human-readable
witnesses.

## Test surface — AST permutations to cover

(Non-exhaustive; the property generator should exercise the cross-product
where it makes sense.)

**Statements**
- `CreateTableStmt`: `temp`, `if not exists`, schema-qualified name,
  zero-column tables (where supported), `using <module>` with and without
  args, `with context (...)`, `with tags (...)`.
- `AlterTableStmt`: every action variant
  (`renameTable`, `renameColumn`, `addColumn`, `dropColumn`,
  `addConstraint`, `alterPrimaryKey`, `alterColumn(setDataType)`,
  `alterColumn(setDefault)`, `alterColumn(dropDefault)`,
  `alterColumn(setNotNull)`, `alterColumn(dropNotNull)`).
- `CreateViewStmt`, `CreateIndexStmt` (partial via `where`),
  `CreateAssertionStmt`.
- `DeclareSchemaStmt`, `ApplySchemaStmt`, `DiffSchemaStmt`,
  `ExplainSchemaStmt` (the round-trip target for the original bug).
- DML for completeness: `InsertStmt`, `UpdateStmt`, `DeleteStmt`,
  `SelectStmt` — each already has emitters in `ast-stringify.ts`.

**Column constraints** (`columnConstraintsToString`):
- `primaryKey` — with `asc` / `desc` and `on conflict <action>`.
- `notNull`, `null` — with `on conflict <action>`.
- `unique` — with `on conflict <action>`.
- `check` — with every subset of `operations`
  (`insert`, `update`, `delete`, and all pairs/triples), with
  `deferrable`, `initiallyDeferred`, `onConflict`, `tags`, and a named
  constraint variant.
- `default` — literal, expression, parameterised (where legal),
  context-variable reference.
- `collate` — every registered collation.
- `foreignKey` — every `onDelete`/`onUpdate` action,
  `deferrable`/`initiallyDeferred`, multi-column FKs.
- `generated` — virtual and stored.
- All of the above with and without a `constraint <name>` prefix and
  with/without `with tags (...)`.

**Table constraints** (`tableConstraintsToString`):
- `primaryKey` (multi-column, mixed direction, conflict).
- `unique` (multi-column, conflict).
- `check` (same matrix as column-level CHECK above).
- `foreignKey` (same matrix as column-level FK above).

**Expressions** (`expressionToString`): exercised transitively via the
above. A focused expression-level round-trip block can land in the same
property test for binary precedence, unary, `CASE`, function calls,
`IN (...)`, subqueries, `EXISTS`, window functions, `OVER`, `ORDER BY`,
collation expressions, type casts / conversion functions.

## Equivalence rules

`assertAstEquivalent(a, b)` is structural equality after the following
normalizations are applied to both sides:

- Discard positional metadata: source span / offset / line / column.
- Discard comments.
- Identifier case: compare case-folded, since the engine already
  resolves case-insensitively. (Bracket-quoted vs unquoted identifiers
  should compare equal — see prior fix
  `1-fix-bracket-quoted-identifier-case-returning` for the
  case-preservation rule that applies *only* to display, not to
  identifier identity.)
- Keyword case: irrelevant once parsed.
- Literal forms: `1`/`1.0`/`'1'` are *not* equivalent — these are
  distinct types and must round-trip exactly.
- Default omission: where the parser fills in a default the stringifier
  is allowed to omit it (e.g. `asc` direction); the comparator must
  treat "absent" as equal to the parser's default value for that field.
  Document the defaults centrally in the comparator so a new default
  added in one place doesn't silently slip past it.
- `operations`: an empty operations list must compare equal to
  `DEFAULT_ROWOP_MASK` semantics — i.e. the stringifier may emit either
  no `on …` clause or an explicit `on insert, update`, and both round-trip
  to the same mask. (After the fix in the sibling fix ticket the
  stringifier will emit `on <ops>` only when the list is non-empty and
  not the default.)

## Failure-mode reporting

When the comparator finds a mismatch it must report:

1. The minimal SQL string that reproduces it (re-stringified from the
   smaller AST when `fast-check` shrinks).
2. The AST path of the divergent field (`columns[2].constraints[0].operations`).
3. Both values at that path.

`fast-check`'s built-in shrinker plus a hand-written AST generator that
emits "simplest first" gives this for free; the failure message is the
ticket the implementer will work from when the next stringifier hole is
found.

## Out of scope

- Fixing the individual fields the property test will surface (CHECK
  `deferrable`/`initiallyDeferred`/`onConflict`, FK
  `deferrable`/`initiallyDeferred`, …). Each is its own fix ticket once
  the property test exposes it. The plan ticket only lands the oracle.
- Round-tripping through the *runtime* (i.e. apply schema, observe
  catalog) — that is end-to-end; the property test stays at the AST
  layer where signal-to-noise is highest.
- DML / SELECT round-tripping beyond a smoke-test block. The known
  pain is DDL, which is what the declarative schema flow re-serialises.
  DML round-tripping can ride the same harness later.

## Pointers

- `packages/quereus/src/emit/ast-stringify.ts` — every entry point the
  property test calls. The dispatch at `astToString` (top of file) is
  the umbrella.
- `packages/quereus/src/parser/ast.ts` — the AST type definitions. The
  property generator should be driven by these so a new node type added
  here fails compilation rather than silently going untested.
- `packages/quereus/test/property.spec.ts` — current `fast-check` usage
  patterns (Parser Robustness, Comparison Properties, JSON Roundtrip).
  The new block mirrors that style.
- `docs/architecture.md` § "Testing Strategy" → "Property-Based Tests"
  — extend this list when the test lands so the strategy doc reflects
  reality.
- Issue #23 — concrete instance of the class of bug this ticket exists
  to close.
