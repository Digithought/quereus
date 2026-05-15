---
description: Review the optimizer-side hoist of canonical `not exists (select 1 from T [where P])` assertions into per-row CHECK-style FD / EC / constant-binding / domain contributions on `T`.
prereq:
files:
  - packages/quereus/src/schema/assertion.ts
  - packages/quereus/src/schema/manager.ts
  - packages/quereus/src/schema/schema.ts
  - packages/quereus/src/schema/change-events.ts
  - packages/quereus/src/runtime/emit/create-assertion.ts
  - packages/quereus/src/runtime/emit/drop-assertion.ts
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/planner/analysis/assertion-classifier.ts
  - packages/quereus/src/planner/analysis/assertion-hoist-cache.ts
  - packages/quereus/src/planner/analysis/check-extraction.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/src/planner/scopes/global.ts
  - packages/quereus/src/planner/building/table.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/test/optimizer/assertion-as-premise.spec.ts
  - docs/optimizer.md
  - docs/architecture.md
---

## What landed

Canonical `not exists (select 1 from T [where P])` assertions are now hoisted
through `extractCheckConstraints` at the target table reference. `negateAst`
pushes `NOT` to the leaves (De Morgan, comparison flip, IS NULL flip,
BETWEEN-not flip; everything else falls back to a wrap-in-NOT that the
extractor silently ignores). The classifier rejects any out-of-shape input —
existential, aggregate, multi-table joins, non-deterministic / subquery /
aggregate predicates, view targets, foreign-column refs, schema-qualified
column refs, and the unconditional-empty case.

### Provenance

`FunctionalDependency`, `ConstantBinding`, and `DomainConstraint` now carry
an optional `source: ConstraintProvenance = { kind: 'declared-check' | 'assertion', name? }`.
The dedup helpers in `fd-utils.ts` (`addFd`, `mergeConstantBindings`,
`mergeDomainConstraints`) compare structural fields only and ignore `source`,
so when a declared CHECK and an assertion produce identical contributions
the declared-check wins (it's merged first at the table reference).

### Cache invalidation

`assertion-hoist-cache.ts` keys results by `(SchemaManager, TableSchema)`
via a `WeakMap`-backed registry. A generation counter bumps on
`assertion_added` / `assertion_removed` / `assertion_modified` events. New
events were added to `schema/change-events.ts`; both `CREATE ASSERTION` and
`DROP ASSERTION` now go through new `SchemaManager.addAssertion` /
`removeAssertion` wrappers that fire those events.

### Soundness fix — re-entrancy guard

**This was not in the original ticket and deserves review attention.** The
original ticket said "the optimizer might prove that some queries derived
from the assertion plan to empty too — that's fine and doesn't short-circuit
enforcement". In practice it *does* short-circuit enforcement: if the
optimizer hoists `qty >= 0` from `not exists (select 1 from t where qty < 0)`,
then the violation query `select 1 where exists (select 1 from t where qty < 0)`
folds to empty too, so the COMMIT check always reports "no violation".
sqllogic test `102-schema-catalog-edge-cases.sqllogic` caught this.

Fix: a re-entrancy guard on `SchemaManager` —
`withSuppressedAssertionHoist(fn)` increments a counter for the duration of
`fn`; `getAssertionHoistedConstraints` returns `EMPTY` (bypassing the cache)
while the counter is > 0. `AssertionEvaluator` wraps both its
plan-compilation path (`getOrCompilePlan` →
`compileUnderSuppression`) and its global-violation execution path
(`executeViolationOnce`, which now force-compiles the statement under
suppression before iteration).

### Scope-walk vs constructor-arg

Per the ticket's note: I went with **option 2** (constructor arg). The
ticket suggested option 1 if a `SchemaManager` accessor already existed on
the scope chain; it doesn't (no `parent` field on `Scope`). Added optional
`schemaManager?: SchemaManager` to `TableReferenceNode` and threaded
through the two construction sites (`building/table.ts`,
`scopes/global.ts`). When omitted (e.g. third-party callers / unit tests
that construct in isolation), assertion-hoisting is skipped; declared CHECK
/ partial-unique contributions are unaffected.

### Case sensitivity caveat

The parser preserves lexeme case verbatim for prefix unary operators
(`NOT`, `IS NULL`, `IS NOT NULL` — line `parser.ts:1465-1469`,
`UnaryExpr.operator` is `operatorToken.lexeme`). My classifier and
`negateAst` were initially case-sensitive (`=== 'NOT'`), which made all
unit tests pass (they construct ASTs with uppercase string literals) but
broke the end-to-end SQL tests where the user typed `not exists`. Fixed
with `.toUpperCase()` comparisons.

Side note: existing code in `predicate-normalizer.ts` and `scalar.ts` also
checks `operator === 'NOT'`. Those work today because:
- Binary `AND`/`OR` / IS NULL / IS NOT NULL paths in the parser hardcode
  uppercase strings.
- Prefix unary `NOT` is only hit via predicate-normalizer when normalizing
  a plan node, and plan nodes built from parser output likely don't trigger
  the `===` path in cases that matter. I didn't dig into whether
  `predicate-normalizer.ts`'s `operator === 'NOT'` is itself a latent bug —
  out of scope here, but worth a separate review.

## Test plan & known gaps

**`test/optimizer/assertion-as-premise.spec.ts`** — 24 tests covering:

- Classifier: 9 unit tests (canonical shape; multi-table join reject;
  unknown table reject; exists-shape reject; aggregate-shape reject;
  non-deterministic via inner subquery reject; foreign-column reject;
  unconditional-empty reject).
- `negateAst`: 8 unit tests covering each push-NOT rule and the fallback.
- End-to-end folding (real DB, real SQL): 7 tests:
  - Single-conjunct hoist (`qty < 0`) folds `where qty < 0` to
    `EmptyRelationNode`.
  - Derived contradiction (`qty = -1`) folds too.
  - Non-contradicting `qty >= 0` is left intact.
  - DROP ASSERTION invalidates the hoist cache (schema-change notifier path).
  - Cross-table isolation (assertion on `orders` doesn't affect `customers`).
  - Provenance: hoisted domain carries `source: { kind: 'assertion', name }`.
  - Dedup with declared CHECK: identical contributions keep the
    declared-check (no `source`) entry.

**Pre-existing failure not caused by this branch**: `packages/quereus-store`
test `Isolated Store Module > failed-commit rollback > discards staged
writes when a deferred assertion rejects the commit` was failing on the
pre-change baseline too (verified by git-stash test). Out of scope here.
Likely a separate issue with the `store`-isolation/assertion interaction.

**Known gaps the reviewer should treat as starting points:**

- The multi-conjunct test described in the ticket ("`qty < 0 or status =
  'bad'`" hoist) isn't included. The negation is `qty >= 0 AND status <> 'bad'`;
  `extractCheckConstraints` would lift the qty domain but reject `<>` — the
  partial extraction is acceptable per the ticket. Worth adding a test for it.
- `containsAggregateCall` uses a hard-coded set of aggregate names
  (`count, sum, avg, min, max, total, group_concat, json_group_array,
  json_group_object`). If the engine grows other aggregates (`stddev`,
  `corr`, etc.) they'd slip through. Cleanest fix: query the schema's
  function registry for `isAggregate`. I didn't wire that up — out of scope
  for the pilot but worth tracking.
- `predicateReferencesForeignColumns` rejects any `IdentifierExpr` whose
  name doesn't resolve as a column. That's conservative — a parameter
  reference is its own AST type (`ParameterExpr`), but an inlined string
  literal might masquerade as something else. The classifier rejects on
  any doubt, which is the safe direction; verify the walker doesn't reject
  legitimate parameter references in parameterized assertions.
- The hoist runs on EVERY `getAllAssertions()` for EVERY table lookup that
  hits the cache miss path. Generation invalidation is coarse-grained: any
  assertion change re-runs the full hoist for any table. For databases with
  many assertions this is O(assertions × tables) on assertion-change. Fine
  for the pilot; document the cost if it becomes hot.

## Validation commands

- `yarn build` (in `packages/quereus`) — passes
- `yarn lint` (in `packages/quereus`) — passes
- `yarn workspace @quereus/quereus run test` — all 3151 tests pass
- `yarn test` (root workspace) — fails on the pre-existing store-isolation
  assertion test described above; not caused by this branch.

## Out of scope (carried forward from plan)

- Existential assertions (`check (exists (...))`).
- Multi-table assertions.
- Aggregate-form assertions.
- Unconditional-empty assertions (`not exists (select 1 from t)`).
- Cost-based decision to skip unprofitable hoists.
- Round-trip: notice that hoisted facts make the assertion's COMMIT-time
  check redundant (and skip enforcement). With the re-entrancy guard above,
  this is moot for now.
- Rewriting `not in` / correlated-subquery shapes that are semantically
  equivalent.
