description: Implement an AST-level round-trip property test for the DDL stringifier (`packages/quereus/src/emit/ast-stringify.ts`) so any field the parser captures but the stringifier silently drops fails the test by construction. Generative fast-check arbitraries drive AST instances (not SQL strings) through `parse(stringify(ast)) ≡ ast`, with a structural comparator that ignores positional metadata and a small set of documented default-equivalences. This closes the class of bug behind issues #21 (compound-select tail lost) and #23 (CHECK `on delete` lost), both fixed point-wise by the sibling `fix-ast-stringify-check-ops-and-compound-select` implement ticket — this ticket lands the oracle so the next stealth drop fails loud rather than silent.
prereq: fix-ast-stringify-check-ops-and-compound-select
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/common/types.ts
  packages/quereus/src/common/constants.ts
  packages/quereus/test/emit-roundtrip.spec.ts
  packages/quereus/test/property.spec.ts
  docs/architecture.md
----

## Background

See `tickets/plan/1-plan-ast-stringify-roundtrip-property-test.md` (this
ticket's source) for the motivation, full failure-mode walk, and
permutation surface. tl;dr — the existing string-based round-trip in
`packages/quereus/test/emit-roundtrip.spec.ts` is a hand-curated
allow-list; any AST field outside that list can be silently dropped (and
has been: #21 `compound`, #23 `operations`, plus suspects:
`deferrable`/`initiallyDeferred`/`onConflict` on CHECK, FK
deferrability, …). This ticket replaces "test the cases I thought to
write" with "test every shape the AST permits."

## Approach

Generative arbitraries produce AST instances directly. For each
generated AST `a`:

1. `stringify(a)` via the appropriate dispatch in `ast-stringify.ts`.
2. `parse(stringified)` to produce `b`.
3. `assertAstEquivalent(a, b)` — structural deep-equality after the
   normalizations below. On failure, report the minimal SQL (from
   `fast-check`'s shrinker) and the AST path of the divergent field.

Generating ASTs instead of SQL strings is deliberate: the test must
exhaust every constructor of every node *the parser can populate*.
Driving from SQL strings would couple the test to the parser's surface
grammar and miss exactly the kind of round-trip-only field the
stringifier drops.

## File layout

Place the property test in **a new file**:
`packages/quereus/test/emit-roundtrip-property.spec.ts`.

Rationale: `test/property.spec.ts` is already large (13 sections, ~1370
lines) and `test/emit-roundtrip.spec.ts` is the hand-curated string
round-trip — they should stay distinct. A new file makes the failure
locus obvious and keeps the comparator + generators co-located.

(Do **not** create a `test/emit/` folder — the rest of `test/` is flat;
match the convention.)

## Equivalence comparator

`assertAstEquivalent(a: AstNode, b: AstNode, path: string[] = []): void`.
Deep structural equality after normalizing:

- **Drop positional metadata** before compare: `loc`, `start`, `end`,
  `line`, `column`, source spans, any `comments` field. Audit
  `packages/quereus/src/parser/ast.ts` for the exact fields the parser
  attaches (search for `AstNode` extension fields) and add them to the
  ignore-set.
- **Identifier case**: compare case-folded. Identifiers, table/column
  names, keyword-derived strings are case-insensitive in the engine.
  (Bracket-quoted vs double-quoted vs unquoted forms with the same
  case-folded value must compare equal.)
- **Literal types**: `1` / `1.0` / `'1'` are **not** equivalent. The
  parser preserves storage class — round-trip exactly.
- **Defaults absent vs explicit**: where the parser fills in a default
  the stringifier may omit it (e.g. PK `direction === 'asc'`, GENERATED
  `stored === false` → VIRTUAL, conflict `ABORT`). The comparator must
  treat field-absent and field-equals-default as equivalent.
  **Centralize these defaults** in one object inside the comparator
  module — every entry needs a one-line comment explaining the default
  so a future agent adding a new field touches the same place.
- **CHECK `operations`**: empty list (`[]`) and the default mask
  (insert+update) must compare equal once the sibling fix lands and the
  stringifier emits `on <ops>` only for non-default lists. Until then,
  this is the kind of mismatch the property test is supposed to surface
  loudly — don't over-normalize.
- **Tags**: `tags` records compare by key-set + value, not by insertion
  order.
- **Comments**: any comment field is dropped before compare.

On mismatch, throw with: minimal-SQL repro, AST path
(`columns[2].constraints[0].operations`), and both values at that path
(JSON-serialized, BigInt-safe — reuse `safeJsonStringify` from
`util/serialization.ts`).

## AST arbitraries

Build under `describe('AST round-trip', …)` in the new spec file. Each
arbitrary returns an AST node already typed against `parser/ast.ts` —
this gives compile-time discovery when a node type changes shape.

Coverage matrix (non-exhaustive — design generators to compose; aim
for the cross-product on small leaves):

**Expressions** (transitive coverage via Stmt arbitraries is enough;
no need for a standalone expression test — `emit-roundtrip.spec.ts`
already covers a curated set):
- literal (every storage class incl. BLOB & big numbers)
- identifier / column (schema-qualified, table-qualified)
- binary / unary / function / cast / parameter
- subquery, exists, in (values + subquery), between, collate, case
- windowFunction (partition by, order by, frame)

**Statements** — the primary target:
- `CreateTableStmt`: `temp`, `ifNotExists`, schema-qualified name,
  `using <module>` with/without args, `with context (...)`,
  `with tags (...)`.
- `AlterTableStmt`: every `AlterTableAction` variant
  (`renameTable`, `renameColumn`, `addColumn`, `dropColumn`,
  `addConstraint`, `alterPrimaryKey`,
  `alterColumn(setDataType|setDefault|setNotNull)` with each branch).
- `CreateViewStmt`, `CreateIndexStmt` (partial via `where`),
  `CreateAssertionStmt`.
- `DeclareSchemaStmt`, `ApplySchemaStmt`, `DiffSchemaStmt`,
  `ExplainSchemaStmt`.
- `InsertStmt`, `UpdateStmt`, `DeleteStmt`, `SelectStmt`.

**Column constraints** (target `columnConstraintsToString` —
`ast-stringify.ts:889-941`):
- `primaryKey` with each `direction` × each `onConflict`.
- `notNull` / `null` with each `onConflict`.
- `unique` with each `onConflict`.
- `check` with every subset of `operations` (∅, {insert}, {update},
  {delete}, pairs, triple), `deferrable`, `initiallyDeferred`,
  `onConflict`, named/unnamed, with/without `tags`.
- `default` (literal expression — keep the expr arbitrary small).
- `collate` (registered collations: BINARY, NOCASE, RTRIM).
- `foreignKey` with every `onDelete`/`onUpdate` action,
  `deferrable`/`initiallyDeferred`, multi-column targets.
- `generated` (virtual + stored).

**Table constraints** (target `tableConstraintsToString` —
`ast-stringify.ts:944-976`):
- `primaryKey` (multi-column, mixed `direction`, `onConflict`).
- `unique` (multi-column, `onConflict`).
- `check` (same matrix as column-level CHECK).
- `foreignKey` (same matrix as column-level FK).

Each generator must construct a node that is **syntactically valid for
the parser** — e.g. don't generate `ColumnConstraint{type:'generated'}`
on a column that also has `default`, because the parser may reject it.
When in doubt, run one sample of the arbitrary through
`parse(stringify(ast))` during dev and adjust the generator to stay in
the parser's accepted subset.

## What the property looks like (sketch)

```ts
import * as fc from 'fast-check';
import { Parser } from '../src/parser/parser.js';
import { astToString } from '../src/emit/ast-stringify.js';
import { astArbitrary } from './emit-roundtrip-arbitraries.js';
// ^ optional helper file — split if the arbitraries get large

const parser = new Parser();

describe('AST round-trip property', () => {
    it('parse(stringify(ast)) ≡ ast for every generated AST', () => {
        fc.assert(fc.property(astArbitrary, (ast) => {
            const sql = astToString(ast);
            const reparsed = parser.parse(sql);  // single-statement
            assertAstEquivalent(ast, reparsed);
        }), { numRuns: 500 });
    });
});
```

Use `parser.parse(sql)` (single statement) for individual stmts; for
multi-statement scripts (e.g. `DeclareSchemaStmt`'s nested items), use
`parser.parseAll`. Check `packages/quereus/src/parser/parser.ts` for
the exact public surface — `emit-roundtrip.spec.ts` already imports
`parse` and `parseAll` from `../src/parser/index.js`; match that.

## Out of scope (explicit)

- **Fixing fields the property test will newly expose.** If the test
  catches, say, `ColumnConstraint.deferrable` being dropped on CHECK,
  open a separate fix ticket for each. This ticket lands the oracle,
  not the patches. Do **call out** the new findings in the review-stage
  handoff so the next agent can spin fix tickets — see Phase 5 TODO.
- DML round-tripping through the runtime (apply schema → observe
  catalog). The property test stays at the AST layer.
- Per-statement string-equality round-tripping. That's
  `emit-roundtrip.spec.ts`'s job and it stays unchanged; the two tests
  are complementary.

## Validation

- `yarn workspace @quereus/quereus run lint`
- `yarn workspace @quereus/quereus run build`
- `yarn workspace @quereus/quereus run test` — stream via `tee`. The
  property test runs ~500 cases × N arbitraries; if a single `it()`
  exceeds a few seconds, lower `numRuns` per section rather than at the
  top level so the budget is spent on the broad arbitraries.
- Confirm `test/emit-roundtrip.spec.ts` (string-based round-trip)
  still passes — the new test is additive, not a replacement.

Do **not** run `yarn test:store` or `yarn test:full` — this is a
parser/emit-layer test; the storage layer is unaffected.

## TODO

Phase 1 — verify parser surface (don't skip)

- [ ] Confirm `parser.parse` (single-statement) and `parser.parseAll`
      signatures and exports in `packages/quereus/src/parser/index.js`
      / `packages/quereus/src/parser/parser.ts`. Note any errors the
      parser throws — those should be caught and the run discarded
      (`fc.pre(false)`) so an invalid AST generator doesn't fail the
      property as a stringifier bug.
- [ ] Read `packages/quereus/src/parser/ast.ts` end-to-end and list
      every positional/metadata field on `AstNode` extensions so the
      comparator's ignore-set is complete (search for `loc`, `start`,
      `end`, `pos`, `span`, `comments`). Put the list in a comment at
      the top of the comparator function.
- [ ] List every parser-default the stringifier may omit and centralize
      them in the comparator's defaults table (one entry per
      field-path, with a citation to the relevant `ast-stringify.ts`
      line). Examples to seed it:
      - `ColumnConstraint{type:'primaryKey'}.direction === 'asc'`
      - `ColumnConstraint{type:'generated'}.generated.stored === false`
      - `*.onConflict === ConflictResolution.ABORT`
      - `ColumnConstraint{type:'check'}.operations` empty/missing ≡
        default mask (after the sibling fix lands).

Phase 2 — comparator

- [ ] Implement `assertAstEquivalent(a, b, path)` in a helper file
      `packages/quereus/test/emit-roundtrip-comparator.ts` (or inline
      if it stays small — judge once the ignore-set + defaults table
      sizes are clear).
- [ ] Unit-test the comparator itself first: two minimal hand-built
      ASTs that differ only in a positional field should compare equal;
      two that differ in a payload field should fail with a path
      report. Keep these tests in the same spec file.

Phase 3 — arbitraries + property

- [ ] Build leaf arbitraries (literal, identifier, simple expression)
      and one composite for `ColumnConstraint`. Drive `CreateTableStmt`
      through them — this is the densest field surface. Validate the
      round-trip locally on a handful of `fc.sample(astArbitrary, 20)`
      outputs before turning the property loose.
- [ ] Extend to `TableConstraint`, `AlterTableStmt` actions, view +
      index + assertion, then the declare/apply/diff/explain family,
      then DML smoke (one block — DML coverage is not the priority).
- [ ] Use one top-level `it()` per major node family so a failure
      identifies which arbitrary tripped without re-reading the seed.
      Keep `numRuns` reasonable (100–500 per `it()`).

Phase 4 — validate

- [ ] Run lint + build + `yarn test` from repo root, streamed.
- [ ] Re-run with the sibling fix landed (CHECK `operations` +
      `stmt.compound`) — those two known drops should no longer be
      findings. Anything else the property test surfaces is a **new**
      finding worth filing.

Phase 5 — handoff

- [ ] Write the review ticket. In it, list every drop the property
      test newly surfaced (field path + AST node + suggested fix
      location in `ast-stringify.ts`). The reviewer turns each into
      its own fix ticket — don't bundle multiple drops into one fix.
- [ ] Update `docs/architecture.md` § "Testing Strategy" → "Property-
      Based Tests" to mention the new AST round-trip test (one bullet,
      no narrative).
