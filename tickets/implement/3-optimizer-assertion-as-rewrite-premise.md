---
description: Hoist trivially-universal `create assertion` predicates (canonical form `not exists (select 1 from T [where P])`) into the optimizer's FD / EC / constant-binding / domain-constraint pipeline at the target table reference. Reuses ticket #1's `extractCheckConstraints` walker; consumed downstream by ticket #2's contradiction detector.
prereq: optimizer-check-derived-fds-and-domains, optimizer-predicate-contradiction-detection
files:
  - packages/quereus/src/schema/assertion.ts
  - packages/quereus/src/schema/schema.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/schema/change-events.ts
  - packages/quereus/src/runtime/emit/create-assertion.ts
  - packages/quereus/src/planner/nodes/create-assertion-node.ts
  - packages/quereus/src/planner/analysis/assertion-classifier.ts          (new)
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts          (new)
  - packages/quereus/src/planner/analysis/check-extraction.ts
  - packages/quereus/src/planner/analysis/predicate-shape.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/test/optimizer/assertion-as-premise.spec.ts            (new)
  - docs/optimizer.md
  - docs/architecture.md
---

## Goal

Treat each `create assertion` whose CHECK expression matches the canonical
"trivially universal" shape

```
not exists (select 1 from T [where P])
```

as if `T` carried a per-row `check (not P)`. Feed the negated predicate through
ticket #1's existing `extractCheckConstraints` walker so the resulting FDs,
ECs, constant bindings, and `domainConstraints` are surfaced on
`TableReferenceNode.computePhysical`. Ticket #2's contradiction detector then
folds queries that violate the assertion to `EmptyRelationNode` automatically
— no consumer changes required.

Hard scope: single-base-table assertions only. Multi-table joins, existential
shape (`exists (...)`), aggregate shape (`(select count(*) ...) = 0`),
`in`/`not in` shape, and any shape involving non-deterministic functions or
subqueries below the outer `not exists` are out of scope and silently fall
through to the existing commit-time enforcement path.

## Architecture

### 1. Persist the original CHECK AST

`emitCreateAssertion` currently throws away `CreateAssertionNode.checkExpression`
after stringifying it into `violationSql`. Add an optional field to
`IntegrityAssertionSchema`:

```ts
// schema/assertion.ts
checkExpression?: AST.Expression;
```

`emitCreateAssertion` populates it directly from `plan.checkExpression`.

(Round-tripping the AST from `violationSql` would also work but is fragile —
the violation form has an extra outer `NOT` and runs through `expressionToString`,
so collation/quoting nuances can drift. Storing the original AST is one extra
field reference and avoids the round-trip risk entirely.)

### 2. AST classifier

`planner/analysis/assertion-classifier.ts` exports:

```ts
export interface AssertionHoistCandidate {
  /** Lowercased qualified name "schema.table" */
  baseTableQualifiedName: string;
  /** Inner predicate P (or undefined → equivalent to `not exists (select 1 from T)`,
   *  i.e. T is unconditionally empty — out of scope for this pilot). */
  innerPredicate?: AST.Expression;
  /** Source assertion name, for provenance. */
  assertionName: string;
}

export function classifyAssertionForHoisting(
  assertion: IntegrityAssertionSchema,
  schemaManager: SchemaManager,
): AssertionHoistCandidate | undefined;
```

Recognized shape (purely syntactic on the AST):

- `expr.type === 'unary'` with `operator === 'NOT'`
- inner `expr.type === 'exists'` (or `expr.type === 'subquery'` whose statement
  is wrapped via the EXISTS pattern — check the actual AST representation
  during implement; both `ExistsExpr` and the parser's lowering must be
  considered)
- subquery is a `SelectStmt` with:
  - exactly one `from` entry, of type `'table'` (no joins, no subselects)
  - the `from` table resolves via `schemaManager.findTable(...)` to a base
    `TableSchema` (not a view, not a CTE, not a TVF)
  - no `groupBy`, no `having`, no `orderBy`, no `limit`, no set ops
  - `columns` is irrelevant — `not exists` ignores them
  - optional `where` clause becomes `innerPredicate`
- `innerPredicate` (if present) must reference only columns of `T` (column
  resolution against the table schema's `columnIndexMap`) — any unresolved
  column or any column with an unrecognized table qualifier disqualifies
- `containsNonDeterministicCall(expr, isDeterministicFn)` returns false for
  the ENTIRE assertion AST (reuse the helper from `check-extraction.ts` —
  export it from there if not already exported)

Rejection is silent — return `undefined`. Multi-table, existential, aggregate,
view-targeted, and non-deterministic forms all fall through to the existing
commit-time enforcement.

If `innerPredicate` is `undefined` (assertion says `T` is unconditionally
empty), the hoist would synthesize `check (false)` on T — which is correct but
a fairly aggressive optimizer signal. **Out of scope for this pilot**:
classifier returns `undefined` in that sub-case, with a brief comment.

### 3. AST-level NOT pusher

`extractCheckConstraints` does not recognize a top-level `NOT` wrapping
(`recognize()` has no `unary`/`NOT` branch — confirmed by reading
`check-extraction.ts:95`). To feed `NOT P` through it we need to push NOT
down to the leaves first.

Add a small AST-level helper next to `predicate-shape.ts` (or as a private
helper inside the new `assertion-classifier.ts`):

```ts
function negateAst(expr: AST.Expression): AST.Expression;
```

Rules (mirror the plan-level `predicate-normalizer.ts:pushNotDown`):

- `NOT (a AND b)` → `(NOT a) OR (NOT b)`
- `NOT (a OR b)`  → `(NOT a) AND (NOT b)`
- `NOT (NOT x)`   → `x`
- `NOT (a = b)`   → `a <> b`     (and `==` symmetrically)
- `NOT (a <> b)`  → `a = b`      (and `!=`)
- `NOT (a < b)`   → `a >= b`     (and the other three comparisons)
- `NOT (a IS NULL)` → `a IS NOT NULL` (and inverse)
- `NOT (a BETWEEN lo AND hi)` → flip the `not` flag on `BetweenExpr`
- `NOT (a IN (...))` → flip the `not` flag on `InExpr`
- All other shapes (function calls, CASE, etc.) → wrap in a single `NOT` node.
  `extractCheckConstraints` will then ignore them, which is the conservative
  outcome we want.

Do NOT distribute `OR`-of-conjuncts back into CNF — mirror the existing
normalizer's restraint. The result of `negateAst` is fed verbatim into
`extractCheckConstraints` via a synthetic `RowConstraintSchema`.

### 4. Hoist pipeline

`planner/analysis/assertion-hoist-cache.ts` exports:

```ts
export interface HoistedConstraintsForTable {
  readonly fds: ReadonlyArray<FunctionalDependency>;
  readonly equivPairs: ReadonlyArray<readonly [number, number]>;
  readonly constantBindings: ReadonlyArray<ConstantBinding>;
  readonly domainConstraints: ReadonlyArray<DomainConstraint>;
}

export function getAssertionHoistedConstraints(
  schemaManager: SchemaManager,
  table: TableSchema,
): HoistedConstraintsForTable;
```

Implementation:

- Iterate `schemaManager` over all schemas' assertions (exposed via a new
  `getAllAssertionsAcrossSchemas()` helper on `SchemaManager` — the existing
  `Schema.getAllAssertions` only yields per-schema).
- For each assertion, call `classifyAssertionForHoisting`. If the candidate's
  `baseTableQualifiedName` matches `table.schemaName + '.' + table.name`
  (lowercased), build a synthetic `RowConstraintSchema`:

  ```ts
  const synth: RowConstraintSchema = {
    name: `__assertion_${assertion.name}`,
    expr: negateAst(candidate.innerPredicate),
    operations: 0, // unused by extractCheckConstraints
  };
  ```

  Confirm the exact `RowConstraintSchema` shape required during implement —
  ticket #1's `extractCheckConstraints` only reads `check.expr`, so other
  fields can be left as no-ops.

- Pass `[synth]` (one synthetic check per assertion that targets this table)
  to `extractCheckConstraints` with `table.columnIndexMap` and
  `() => true` for determinism (the classifier already gated on determinism;
  belt-and-suspenders is fine).

- Tag each emitted FD/EC pair/binding/domain with provenance (see §5).

- Cache: keyed on `(SchemaManager, TableSchema)` via a `WeakMap`-backed
  registry, invalidated by schema-change events (see §6). `TableSchema`
  identity already swaps on ALTER TABLE so the table-side of the key handles
  schema mutation; the assertion-side requires a generation counter (see §6)
  that the cache reads and compares against.

### 5. Provenance tagging

Extend the relevant types in `planner/nodes/plan-node.ts`:

```ts
export interface ConstraintProvenance {
  kind: 'declared-check' | 'assertion';
  /** Assertion name (lowercased), only when kind === 'assertion' */
  name?: string;
}

// Add `readonly source?: ConstraintProvenance` to:
//   FunctionalDependency
//   ConstantBinding
//   DomainConstraint
```

Additive optional field — existing producers/consumers ignore it. Ticket #1's
`extractCheckConstraints` does not set `source`; `getAssertionHoistedConstraints`
sets `{ kind: 'assertion', name }` after extraction by mapping over the
returned arrays.

The dedup helpers in `fd-utils.ts` (`addFd`, `mergeConstantBindings`,
`mergeDomainConstraints`) currently dedup on structural identity. Rule:
**ignore `source` in dedup.** When two structurally-identical constraints
collide (e.g. an assertion duplicates a declared check), keep the first
encountered — which means declared-check provenance wins because table-ref
threads declared first, then merges hoisted assertions on top. Document the
rule in `fd-utils.ts` next to the comparators.

### 6. Schema-change invalidation

`SchemaChangeNotifier` currently emits `table_*` and `function_*` events but
no assertion events. Extend `change-events.ts`:

```ts
export type AssertionAddedEvent    = SchemaObjectAdded   <'assertion_added',    IntegrityAssertionSchema>;
export type AssertionRemovedEvent  = SchemaObjectRemoved <'assertion_removed',  IntegrityAssertionSchema>;
export type AssertionModifiedEvent = SchemaObjectModified<'assertion_modified', IntegrityAssertionSchema>;
```

Add to the `SchemaChangeEvent` union. `Schema.addAssertion` /
`Schema.removeAssertion` need to call `SchemaChangeNotifier.notifyChange`
(currently those methods don't fire — `Schema` doesn't hold a notifier
reference today; the notifier lives on `SchemaManager`. Cleanest path:
inline the notify call from `SchemaManager` rather than threading the
notifier into every `Schema`. The two assertion mutation paths in
`runtime/emit/create-assertion.ts` and any DROP ASSERTION emit site go
through `schemaManager.getMainSchema().addAssertion(...)`; replace those
call sites with a `schemaManager.addAssertion(schemaName, assertion)` /
`schemaManager.removeAssertion(schemaName, name)` wrapper that fires the
event after the mutation. Audit DROP ASSERTION's call site during
implement — confirm there is a single emit location.)

`assertion-hoist-cache.ts` subscribes to the notifier on first use and bumps
a generation counter on any `assertion_*` event. The cache compares the
counter against the cached entry's stamp on lookup and recomputes on mismatch.
(`AssertionEvaluator` in `database-assertions.ts` already does this dance
for its own cache — mirror the pattern.)

### 7. Wiring into TableReferenceNode

`reference.ts:84-137` (`TableReferenceNode.computePhysical`) currently:
- merges declared-key FDs
- merges `getCheckExtraction(this.tableSchema)` contributions
- merges `getPartialUniqueGuardedFds(...)` contributions

Add a fourth contributor immediately after the partial-unique block:

```ts
const hoisted = getAssertionHoistedConstraints(this.scope.schemaManager, this.tableSchema);
for (const fd of hoisted.fds) fds = addFd(fds, fd);
// ... and merge hoisted equivPairs / constantBindings / domainConstraints
```

The `TableReferenceNode` does not currently hold a `SchemaManager` reference.
Options (pick during implement; default to the second):

1. Walk up `this.scope` to find the `SchemaManager`. Inspect `Scope` /
   `GlobalScope` for an existing accessor (`scope.ts`); if the database/schema
   manager is reachable through the scope chain, use that — minimum new API.
2. Pass `SchemaManager` into the `TableReferenceNode` constructor (alongside
   `vtabModule`). Touching every call site is mechanical — `find_references`
   on `new TableReferenceNode(` will enumerate them.

Default: option 1 if a `SchemaManager` accessor already exists on the scope
chain (very likely — DDL paths reach it). Document the actual choice in the
review handoff.

### 8. Interaction with assertion enforcement

This ticket changes nothing about commit-time assertion enforcement. The
hoisted constraints are an additive optimizer signal; `AssertionEvaluator`
in `database-assertions.ts` remains the source of truth and continues to run
the violation query at COMMIT. The optimizer might prove that some queries
derived from the assertion plan to empty too — that's fine and doesn't
short-circuit enforcement.

### 9. Observability

- `query_plan` JSON serialization already passes `physical` through
  `safeJsonStringify` (per ticket #1 review). Adding optional `source`
  fields to FDs/bindings/domains will surface them automatically — verify
  with a snapshot in the test file.
- Add a single debug log line under `quereus:planner:analysis:assertion-hoist`
  per (assertion, table) hoist that succeeds, logging assertion name + table
  qualified name + counts. Cost is once-per-cache-miss.

## Test outline (`test/optimizer/assertion-as-premise.spec.ts`)

Mirror the structure of `check-derived-fds.spec.ts` and
`predicate-contradiction.spec.ts`. Two logical groups:

**Classifier unit tests** (call `classifyAssertionForHoisting` directly):

- `not exists (select 1 from t where qty < 0)` → qualifies, predicate is the
  `qty < 0` AST node, base table resolves to `main.t`.
- `not exists (select 1 from t where qty < 0 and status = 'a')` → qualifies.
- `not exists (select 1 from t join u on t.id = u.id where ...)` → rejects
  (multi-table).
- `not exists (select 1 from v_orders where qty < 0)` where `v_orders` is a
  view → rejects (not a base table).
- `(select count(*) from t where qty < 0) = 0` → rejects (different shape).
- `not exists (select 1 from t where qty < random())` → rejects
  (non-deterministic).
- `not exists (select 1 from t where qty < (select max(x) from u))` → rejects
  (subquery in predicate).

**End-to-end behavior** (use `db.exec`/`db.prepare` + plan-shape inspection):

- Create table `orders(id int primary key, qty int, status text)`, then
  `create assertion no_neg check (not exists (select 1 from orders where qty < 0))`.
  - `select * from orders where qty < 0` → plan-shape contains
    `EmptyRelationNode` (folded by ticket #2's contradiction detector
    consuming the hoisted `domainConstraint(qty >= 0)`).
  - `select distinct status from orders where qty = -1` → plan-shape contains
    `EmptyRelationNode`.
  - `select * from orders where qty >= 0` → no folding (plan unchanged).
- After `drop assertion no_neg`, the same `qty < 0` query no longer folds —
  re-derivation fires via the schema-change notifier.
- Negative: assertion targets `orders`, query targets `customers` → no effect
  on `customers` queries.
- Provenance smoke: `query_plan` JSON for the table reference includes
  `source: { kind: 'assertion', name: 'no_neg' }` on the relevant
  domainConstraint.

**Multi-conjunct hoist**:

- `create assertion check (not exists (select 1 from t where qty < 0 or status = 'bad'))`.
  After `negateAst`: `qty >= 0 and status <> 'bad'`. Both contributions
  should reach the table reference: `domainConstraint(qty min 0 inclusive)`
  AND a residual `<>` (which `extractCheckConstraints` does not currently
  recognize — that's fine, partial extraction is acceptable; assert just
  the qty domain lifts).

**No-op when prereq facts already declared**:

- Table has declared `check (qty >= 0)` AND an assertion with the same shape.
  Plan should not double-emit the same domain (dedup), and the kept
  provenance should be `declared-check` (because tableref merges declared
  first).

## Out of scope (carried from plan, do not start here)

- Existential assertions (`check (exists (...))`).
- Multi-table assertions (`not exists (select 1 from t join u ...)`).
- Aggregate-form assertions (`(select sum(qty) from t) >= 0`,
  `(select count(*) from t where ...) = 0`).
- Cost-based decision to skip hoisting when the derived constraint isn't
  profitable — first cut hoists everything qualifying.
- Round-trip optimization: noticing that a hoisted check makes the
  assertion's commit-time check redundant.
- Rewriting `not in` / `not exists with correlated subquery` shapes that are
  semantically equivalent but syntactically different.

## TODO

- Add `checkExpression?: AST.Expression` to `IntegrityAssertionSchema`;
  populate from `emitCreateAssertion`. Update any seed/replay paths that
  reconstruct assertions to also populate it (audit during implement —
  `database-assertions.ts` reparses `violationSql`, which is fine; but other
  paths that reconstruct `IntegrityAssertionSchema` from persisted state
  must re-parse the assertion text. If no such path exists, document
  that in the handoff and leave the field undefined for replayed assertions
  — they fall through to commit-time enforcement, which is the safe default).
- Implement `negateAst` (and unit-test it directly — every recognized rule
  + a "wrap in NOT" fallback case).
- Implement `classifyAssertionForHoisting` in `planner/analysis/assertion-classifier.ts`.
- Implement `getAssertionHoistedConstraints` in `planner/analysis/assertion-hoist-cache.ts`.
- Add `getAllAssertionsAcrossSchemas()` (or equivalent iterator) to
  `SchemaManager`.
- Extend `change-events.ts` with `assertion_added` / `assertion_removed` /
  `assertion_modified` and wire firing through new `SchemaManager.addAssertion`
  / `removeAssertion` wrappers; update the two existing call sites
  (`runtime/emit/create-assertion.ts` and DROP ASSERTION's emit site).
- Add optional `source?: ConstraintProvenance` to `FunctionalDependency`,
  `ConstantBinding`, `DomainConstraint` in `plan-node.ts`. Document that
  dedup ignores `source`. Audit the dedup helpers in `fd-utils.ts` to
  confirm they compare structural fields only — no changes expected, but
  add a comment.
- Wire `TableReferenceNode.computePhysical` to merge hoisted constraints
  alongside declared-check and partial-unique contributions. Choose the
  scope-walk vs constructor-arg path for `SchemaManager` access; document.
- Tests per outline above.
- `docs/optimizer.md`: add an "Assertion-derived premises" subsection under
  the FD/domain section. Note the canonical-form scope and the
  out-of-scope list.
- `docs/architecture.md` § Constraints: one-paragraph mention of assertion
  hoisting and provenance.
- `yarn lint` clean. `yarn test` clean (full quereus suite passes; do not
  run `yarn test:store` per AGENTS.md unless diagnosing a store issue).

## End
