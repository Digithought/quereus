---
description: Audit every optimizer rule against the existing hasSideEffects signal; harden propagation; land lint-style guardrail so future rules must declare side-effect awareness. No user-visible feature yet — sets the safety net that dml-in-expression-position lands on.
prereq: query-expr-ast-parser-unification
files:
  - packages/quereus/src/planner/framework/characteristics.ts
  - packages/quereus/src/planner/framework/registry.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/rules/subquery/
  - packages/quereus/src/planner/rules/predicate/
  - packages/quereus/src/planner/rules/cache/
  - packages/quereus/src/planner/rules/join/
  - packages/quereus/src/planner/rules/access/
  - packages/quereus/src/planner/rules/distinct/
  - packages/quereus/src/planner/rules/retrieve/
  - packages/quereus/src/planner/rules/aggregate/
  - packages/quereus/src/planner/validation/plan-validator.ts
  - docs/optimizer.md
  - docs/architecture.md
---

## Background

`PlanNodeCharacteristics.hasSideEffects(node)` already exists in `planner/framework/characteristics.ts:24` — it reads `node.physical.readonly === false`. The signal is **available**; this ticket makes sure every rule that re-shapes plans actually **consults** it, and pins that discipline with a registry-level declaration so future rules cannot silently drop the check.

This ticket lands no new user-visible behavior. It is the safety net that `dml-in-expression-position` and `query-expr-parallel-track-refusal` stand on. Without it, widening DML into expression position is a correctness landmine: any rule that moves/duplicates/drops/merges a subtree without checking `hasSideEffects` will quietly change which rows get written, double-execute writes, or drop them.

## Scope of audit

For each rule, the question is: "Does this rewrite move, duplicate, drop, or merge a subtree?" If yes, it must either:

- **Refuse** the rewrite when any participating subtree has `hasSideEffects = true`, or
- **Weaken** to a side-effect-preserving variant (e.g. cache materialization with run-once memoization is preserving; CSE/dedup of two textually-identical impure subtrees is not).

Rule categories to audit (paths under `packages/quereus/src/planner/rules/`):

- **`subquery/`** — EXISTS/IN → semi/anti-join decorrelation rewrites change cardinality of side-effect execution. Refuse on impure inner.
- **`predicate/`** — pushdown past a mutating node changes which rows trigger writes. Refuse when filter pushes past an impure subtree.
- **`cache/`** — `rule-mutating-subquery-cache.ts` already exists; verify its semantics are "materialize once, fan out reads" (correct). CSE / dedup across two impure subtrees must be forbidden.
- **`join/`** — FK→PK join elimination (architecture.md:135) drops a relation; assumes purity. Refuse on impure drop-target.
- **`access/`**, **`distinct/`**, **`retrieve/`**, **`aggregate/`** — dead-column / unused-projection / unused-aggregate elimination cannot drop a subtree whose child writes. Constant-folding / `EmptyRelation` collapse cannot fold an impure subtree to a constant. Compound-leg reordering must preserve textual order across impure legs.
- **Assertion-as-premise hoisting** (architecture.md:135) — assumes hoisted relation is observable but pure. Refuse on impure.

## Propagation

`physical.readonly` is set on individual nodes; `hasSideEffects` reads it for the local node. Audit whether parent-node `physical.readonly` correctly inherits from children. In practice the existing physical-property propagation should already cover this, but pin with tests: a `Project(Filter(Sink(…)))` must report `hasSideEffects = true` at the `Project` root.

If propagation is leaky, fix at the `PlanNode` base (or its `computePhysical`-equivalent) rather than per node type.

## Registry-level guardrail

`planner/framework/registry.ts` lists rules. Add a required field on the rule registration shape — one of:

- `'side-effect-safe'` — rule never moves/duplicates/drops/merges, or only does so on subtrees it has separately verified pure.
- `'side-effect-aware'` — rule consults `hasSideEffects` and refuses or weakens accordingly.

Reject registration if the declaration is missing. This is the lint-style audit the plan calls for: it forces every future rule author to make an active choice. Existing rules each get a one-line declaration as part of this ticket.

A second, optional approach: leave the field optional but add a startup-time validator that warns when an unannotated rule is registered. Implementer's call — the stronger version (required field) is preferred because it can't be ignored.

## `getChangeScope` propagation

`Statement.getChangeScope()` currently reports SELECT-as-reads. A SELECT *containing* nested DML writes too; `getChangeScope` must walk the plan tree and union the write scopes of any impure descendants into the outer statement's scope. This is mechanical once `hasSideEffects` is reliable.

Same propagation applies to `Database.watch(scope, …)` — once the scope is right, watch fires correctly with no further work.

This ticket can land the propagation logic with a single test case that doesn't yet need DML-in-expression-position to be runnable (use FROM-position DML, which already works post-ticket-1, to exercise the path).

## Tests

- **Audit fixtures** in `test/optimizer/` — for each rule category, pin one positive case (rule fires on pure subtree) and one negative case (rule refuses on impure subtree). The negative cases all use FROM-position DML (already runnable post-ticket-1).
- **Propagation test**: synthesize a plan with a `Sink` under a `Project` under a `Filter`; assert `hasSideEffects` at the root.
- **Registry guardrail**: a unit test that registers a deliberately-unannotated rule and asserts the registry rejects it.
- **`getChangeScope` test**: a statement of the form `select * from (insert into t … returning *) as x` (FROM-position) reports writes to `t` in its change scope; `Database.watch('t', …)` fires.

## Documentation

- `docs/optimizer.md` — describe the `hasSideEffects` signal, the rule categories that consult it, and the registry-level declaration requirement.
- `docs/architecture.md` — add a bullet under the optimizer recent-refinements list about the audit discipline.
- `docs/change-scope.md` — document propagation of writes from nested DML into the enclosing statement's `ChangeScope`.

## Out of scope

- Runtime emitter changes (full-drain, run-once fence) — `dml-in-expression-position`.
- Lifting the planning-time DML-in-expression-position gate — `dml-in-expression-position`.
- Parallel-track refusal — `query-expr-parallel-track-refusal`.

## TODO

### Phase 1 — Inventory

- Enumerate every rule under `planner/rules/*` and categorize: side-effect-safe vs. side-effect-aware vs. needs-fix.
- Verify `hasSideEffects` propagation through parent nodes (write the propagation test before the fixes).

### Phase 2 — Per-rule fixes

- For each rule classified "needs-fix", add the `hasSideEffects` consultation and the audit fixture (positive + negative).
- Special-case `rule-mutating-subquery-cache.ts`: verify run-once-memoize semantics, write the CSE-forbidden-on-impure-subtrees test.

### Phase 3 — Registry guardrail

- Add the required `sideEffectMode: 'safe' | 'aware'` field to the rule registration shape.
- Annotate every existing rule.
- Add the rejection-of-unannotated-rule test.

### Phase 4 — getChangeScope + watch

- Walk the plan tree to union write scopes into the outer statement's `ChangeScope`.
- Test: FROM-position DML in a SELECT propagates writes; `watch` fires.

### Phase 5 — Docs

- `docs/optimizer.md`, `docs/architecture.md`, `docs/change-scope.md` per above.

### Validation

- `yarn workspace @quereus/quereus run lint`
- `yarn test` (root) — full suite, with attention to `test/optimizer/` and `test/plan/golden-plans.spec.ts` for plan-shape changes.
