description: Review the `nondeterministic_schema` database option / PRAGMA that relaxes the strict static prohibition on non-deterministic expressions in DEFAULT, CHECK, and GENERATED ALWAYS AS clauses. Default behavior unchanged; opt-in via `pragma nondeterministic_schema = true` or `db.setOption('nondeterministic_schema', true)`. Treat this as a starting point — see Known gaps below.
files: packages/quereus/src/core/database.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/constraint-builder.ts, packages/quereus/test/logic/44.1-nondeterministic-schema.sqllogic, packages/quereus/test/planner/validation.spec.ts, docs/runtime.md, docs/architecture.md, docs/module-authoring.md, docs/sql.md
----

## What landed

A single boolean option, `nondeterministic_schema` (alias
`allow_nondeterministic_schema_expressions`), default `false`, lifts the
static rejection of non-deterministic expressions in DEFAULT, CHECK, and
`GENERATED ALWAYS AS` clauses when set to `true`. The validators themselves
remain strict; only the call sites are gated.

### Code changes

1. **Option registration** — `packages/quereus/src/core/database.ts` adds the
   `nondeterministic_schema` boolean option in `setupOptionListeners()` next to
   `foreign_keys`. PRAGMA access ("pragma nondeterministic_schema [= true]")
   and `db.setOption(...)` / `db.getOption(...)` both work via the existing
   `DatabaseOptionsManager` plumbing — no further code needed for those
   surfaces.

2. **Five gated validation sites.** Each reads
   `ctx.db.options.getBooleanOption('nondeterministic_schema')` (or
   `this.db.options.getBooleanOption(...)` in the schema-manager case) and
   skips the validator call when `true`:
   - `packages/quereus/src/schema/manager.ts:1490` — wraps both
     `validateDefaultDeterminism` and `validateCheckConstraintDeterminism`
     (the two DDL-time checks).
   - `packages/quereus/src/planner/building/insert.ts:131` —
     `validateDeterministicDefault` at INSERT build time.
   - `packages/quereus/src/planner/building/insert.ts:199` —
     `validateDeterministicGenerated` at INSERT build time.
   - `packages/quereus/src/planner/building/update.ts:115` —
     `validateDeterministicGenerated` at UPDATE build time.
   - `packages/quereus/src/planner/building/constraint-builder.ts:150` —
     `validateDeterministicConstraint` at INSERT/UPDATE/DELETE build time
     (this was the site the original ticket missed; immediate-CHECK
     non-determinism otherwise re-fires inside `buildConstraintChecks`).

### Test changes

- **New** `packages/quereus/test/logic/44.1-nondeterministic-schema.sqllogic`
  exercises:
  - Default-off rejection paths (DEFAULT random(), CHECK random(),
    GENERATED random()) — confirms the validators still fire under the
    default pragma value.
  - Pragma roundtrip via canonical name and via the alias
    `allow_nondeterministic_schema_expressions`.
  - Relaxed-mode DEFAULT `random()`, DEFAULT `datetime('now')`, immediate
    CHECK using `datetime('now')`, immediate CHECK using `random() IS NOT
    NULL`, GENERATED `random()`, and a CREATE ASSERTION with `random()`.
  - The "pragma off after on" scope: schema persists, reads still work,
    INSERTs that *would* fire the relaxed DEFAULT re-validate against the
    new (strict) pragma value and are rejected — flipping back to true
    restores INSERT compilability.
- `packages/quereus/test/planner/validation.spec.ts` gains a
  "validators remain strict when called directly" section that locks the
  contract that the relaxation lives in the *callers*, not the validators
  themselves.

### Doc changes

- `docs/runtime.md` § "Determinism Validation" — rewritten lede from
  prohibition narrative to capture/replay-contract narrative, with the
  option table, scope rules, and the strict-mode-still-rejects table. The
  "Validation Timing" subsection is annotated to note that all four
  determinism-rejection sites skip when the option is on (pre-walks for
  bind params / column refs remain strict in both modes).
- `docs/architecture.md` § Constraints — `Determinism Enforcement` bullet
  updated to describe the option and cross-link
  `module-authoring.md#mutation-statements`; includes the deferred-CHECK
  replay-safety sentence from the ticket.
- `docs/module-authoring.md` § "Mutation Statements" — tightened the
  replay-contract wording (audit/transport encoding at the module
  boundary; full-DML-pipeline replay is explicitly not supported) and
  added a bullet noting that DEFAULT/GENERATED resolution still produces
  literals even when the source expression was non-deterministic.
- `docs/sql.md` § 9.2 — new entry `9.2.4 nondeterministic_schema` mirroring
  the `default_column_nullability` analog, with example, scope notes, and
  cross-references; subsequent section numbers renumbered.

## Validation runs

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — **3674 passing, 9 pending,
  0 failing** (memory store).
- `yarn workspace @quereus/quereus run lint` — clean.

`yarn test:store` was not run (it exercises the LevelDB store path); this
change is engine-side and store-agnostic — the option lives on `Database`
options and the validators are at planning time, so store-mode results
should be identical. Worth a smoke run during review if cheap.

## Known gaps / things to scrutinize

1. **The strict-mode determinism check at INSERT/UPDATE build time fires
   per compilation, not per row.** When the pragma is flipped from `true`
   back to `false`, an existing table whose DEFAULT is `random()` will
   still serve reads, and an INSERT that *supplies* the column compiles
   fine, but an INSERT that *omits* the column re-fires the validator
   against the current pragma value and is rejected. This is documented
   in the sqllogic test and is consistent with "the option is not baked
   into the schema" — but the user-facing implication ("a relaxed-mode
   table becomes write-restricted to explicit-column INSERTs under strict
   mode without warning") is footgun-shaped. Consider whether this is the
   right semantics or whether the option should be sampled-and-baked at
   CREATE TABLE time. Not in scope for this ticket; flagging.

2. **ALTER TABLE remains a known follow-up.** The original ticket noted
   that the DDL-time validators only fire on CREATE TABLE; ALTER TABLE
   (`ADD COLUMN`, `ADD CONSTRAINT`, `ALTER COLUMN ... SET DEFAULT`)
   doesn't currently route through the determinism validators at DDL
   time. That gap exists in both strict and relaxed modes and is
   unchanged by this ticket — the gate I added covers it transparently
   when those paths do start validating, since they'd use the same
   validators.

3. **The constraint-builder call site (#5 above) was not in the ticket's
   list of "four validation sites";** the ticket said four, but in
   practice the CHECK constraint expression is re-validated when the
   row-context scope is established by `buildConstraintChecks`, not just
   at the AST-walk pass in `validateCheckConstraintDeterminism`. The
   AST-walk catches the easy cases (function calls without scope), but
   the constraint-builder catches everything (including non-deterministic
   sub-expressions reached only after scope resolution). Both need to be
   gated; failing to gate the constraint-builder caused the first round
   of test failures during implementation. The runtime.md "Validation
   Timing" section now says "all four determinism-rejection sites" — that
   count refers to the four logical points (CREATE-TABLE DEFAULT,
   CREATE-TABLE CHECK, DML-time DEFAULT, DML-time GENERATED) and folds
   the constraint-builder check into the "DML-time CHECK" bucket. If
   that's confusing, consider rewording.

4. **Pragma echoes alias name when queried by alias.** My sqllogic test
   asserts that `PRAGMA allow_nondeterministic_schema_expressions;`
   returns `[{"name":"allow_nondeterministic_schema_expressions",
   "value":true}]` rather than the canonical name. This is pre-existing
   behavior of the PRAGMA emitter — `runtime/emit/pragma.ts` yields
   `[pragmaName, currentValue]` where `pragmaName` is the literal name as
   written. Possibly worth a follow-up to resolve aliases for the row
   shape, but it is consistent across the option machinery and not new
   here.

5. **Probabilistic tests in the sqllogic.** I followed the ticket's
   suggestion to avoid probabilistic assertions and used predicates that
   are functionally always true (`random() IS NOT NULL`,
   `datetime('now') >= '2020-01-01'`) plus COUNT(non_null_col)
   assertions. There's no test that exercises a CHECK whose predicate
   *can* reject a row under non-determinism; that's a design choice (the
   ticket warned against probabilistic flakiness). If the reviewer wants
   coverage of that path, it would need a deterministic "non-det" test
   function — registering one was sketched in the ticket but I did not
   pursue it.

6. **No `runtime.md` rewrite of the "Validation Rules" lists.** I kept
   the rejected/accepted-functions bullet lists under the new heading,
   prefixed with "Strict-mode behaviour (default)". That preserves the
   original content as a reference but doubles up on the prose-level
   description above it. Tightening is a judgment call.

7. **The validator-contract unit tests assert message regex `/Non-
   deterministic expression not allowed/`** rather than the
   site-specific message — kept light because the existing per-site
   message tests above them already lock those strings.

## Review checklist for the reviewer

- The five gating sites are the complete set under default planning;
  walk the `validateDeterministic*` references to confirm nothing was
  missed (Workflow: `mcp__code-search__find_references
  validateDeterministic`).
- The `db.options.getBooleanOption('nondeterministic_schema')` pattern at
  each call site is correct and reaches the right `db`/`ctx.db`. The
  schema-manager site uses `this.db.options` directly; the planner sites
  use `ctx.db.options`. Both should be in scope at each location.
- Sanity-check the docs against the actual surface (pragma name, alias,
  default value, option type).
- The "pragma off after on" semantics (#1 above) — confirm the chosen
  behavior is what we want, or open a follow-up.
- Consider whether the ALTER TABLE gap deserves a backlog ticket now
  that this option exists (since the gate is also a `prereq:` of any
  future ALTER-TABLE-determinism work).
