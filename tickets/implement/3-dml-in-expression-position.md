---
description: Lift the planning-time gate from ticket 1; make DML-with-RETURNING actually executable in scalar/EXISTS/IN/compound-leg/CTE-body positions. Adds full-drain emitter semantics, run-once fence, view-body rejection, and conflict-resolution scoping.
prereq: query-expr-side-effect-audit
files:
  - packages/quereus/src/runtime/emit/scalar-subquery.ts
  - packages/quereus/src/runtime/emit/exists.ts
  - packages/quereus/src/runtime/emit/in.ts
  - packages/quereus/src/runtime/emit/sink.ts
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/nodes/
  - packages/quereus/src/schema/
  - docs/sql.md
  - docs/runtime.md
  - docs/view-updateability.md
---

## Background

Ticket 1 made `(insert/update/delete … returning …)` *parse* everywhere a relation is allowed, but installed a planning-time gate that errors when DML appears in expression position (scalar / `EXISTS` / `IN` / compound-leg / view-body / non-FROM CTE-body). Ticket 2 made `hasSideEffects` reliable and audited the optimizer so impure subtrees survive optimization intact. This ticket lifts the gate and makes the runtime do the right thing.

The actual file paths under `runtime/emit/` need confirmation — implementer should `find_references` for the EXISTS, IN, and scalar-subquery emitters to land on the exact files. The names above are illustrative.

## Runtime emitter changes

All three changes are conditional on `hasSideEffects(innerPlan) === true`:

- **Scalar subquery emitter**: today reads at most one row (or N rows for row-subquery context) and stops. When inner is impure, must fully drain the inner iterator before returning the scalar result. Partial drain leaves writes undone — wrong semantics. The scalar value returned remains "first row, first column" (or per spec for row-subqueries); only the drain behavior changes.
- **`EXISTS` emitter**: today short-circuits after row 1. When inner is impure, must fully drain. Loss of the short-circuit is acceptable because (a) it only applies to impure inners — the common case is unaffected — and (b) correctness trumps the optimization for the impure case.
- **`IN` subquery emitter**: today short-circuits on match. When inner is impure, must fully drain even after a match is found.

Implementation pattern: each emitter checks the inner's `hasSideEffects`; if true, append a `for await (const _ of inner) { /* drain */ }` after the result-extraction step. Keep the pure path unchanged.

## Run-once fence

A re-evaluated outer expression (e.g. a scalar subquery in a correlated context, or an expression evaluated for each row of an outer scan) must not re-drive a nested DML. The existing `Sink` semantics should already enforce this — verify by writing a test that wraps a DML subquery inside a correlated outer expression and asserts the DML executes exactly once regardless of outer row count.

If `Sink` does not already enforce run-once, add a memoization layer at the impure-subquery emitter level: first evaluation drives the iterator to completion and memoizes the materialized result and the scalar/EXISTS/IN answer; subsequent evaluations return the memoized answer without re-driving.

## Planning-time gate removal

Remove the gate added in ticket 1. The planner now accepts DML in all five expression positions and lowers them to the same `RelationalPlanNode` shape FROM-position DML already uses. The optimizer (post-ticket-2) leaves the impure subtree intact.

## View-body rejection

`CREATE VIEW v AS (insert/update/delete … returning …)` must be rejected at view-creation time with a clear diagnostic. A view-body DML would re-drive writes on every view reference, which is incoherent with view semantics. The check goes in the view-creation path in `schema/` (find the right file via `find_references` on `CreateViewStmt`).

`CREATE VIEW v AS values …` is **accepted** and bottoms out as unupdateable (no base relation to fan out to). The FD-driven updateability propagation should handle this naturally — pin with a regression test (`insert into v values (3,'c')` errors cleanly).

## Determinism enforcer

`INSERT/UPDATE/DELETE … RETURNING` in `CHECK` / `DEFAULT` / assertion expressions must be rejected by the existing determinism enforcer (see `docs/runtime.md#determinism-validation`). The enforcer rejects non-deterministic expressions; DML is non-deterministic via the side-effect axis. Verify the existing check catches this; add a negative test if it doesn't already.

## Conflict-resolution scoping

`INSERT OR REPLACE INTO outer … SELECT … FROM (insert into inner … returning …)` — the outer `OR REPLACE` must **not** propagate to the inner DML. Each DML carries its own `onConflict`. This is likely already correct because conflict resolution is per-statement on the AST, but pin explicitly with a test and document in `docs/sql.md`.

## Per-row DML in outer DML (deferred)

`update outer set x = (insert into inner … returning y)` — DML inside an expression evaluated *per row* of an outer DML. Ordering semantics are subtle (does inner see outer's mid-flight writes?). Defer to backlog as the plan calls out; document the limitation in `docs/sql.md`.

## Tests

- **EXISTS full-drain**: `select exists (insert into log values (1) returning 1); select count(*) from log` returns 1.
- **IN full-drain**: similar — match-found does not short-circuit when inner writes.
- **Scalar full-drain**: scalar DML subquery returning multiple rows fully drains (writes all rows) and returns the first scalar.
- **Run-once fence**: correlated outer expression containing a DML subquery executes the DML exactly once regardless of outer cardinality.
- **`getChangeScope` propagation** (post-ticket-2 plumbing): a SELECT containing nested DML in expression position reports the nested writes; `Database.watch` fires on the appropriate base table.
- **Compound-leg DML**: `values (1) union all (insert into t values (2) returning v)` writes one row to `t` and emits both legs in textual order.
- **CTE-body DML**: `with x as (insert into t values (1) returning v) select v from x` works; the DML executes once.
- **View-as-VALUES updateability** (negative): `create view v as values (1,'a'),(2,'b'); insert into v values (3,'c')` errors cleanly.
- **View-as-DML rejection** (negative): `create view v as insert into t values (1) returning v` errors at view-creation time.
- **Determinism gate** (negative): DML in CHECK / DEFAULT / assertion errors with the determinism diagnostic.
- **Conflict-resolution scoping**: outer `OR REPLACE` does not propagate to inner DML; each carries its own.
- **Lateral `VALUES`**: a `VALUES` subquery referencing outer columns works (should fall out of the unified parser; pin with a test).

## Documentation

- `docs/sql.md` — document the run-once-per-statement contract for mutating subqueries in expression position; document conflict-resolution scoping; document the deferred per-row-DML-in-outer-DML limitation.
- `docs/runtime.md` — note the EXISTS / IN / scalar emitter full-drain behavior on side-effecting inners; document the run-once fence.
- `docs/view-updateability.md` — explicit note that `VALUES`-bodied views are unupdateable and DML-RETURNING-bodied views are rejected at creation.
- `docs/architecture.md` — the orthogonality bullet graduates fully to literal truth; remove any "VALUES only" caveats added in ticket 1.

## Out of scope

- Parallel-track refusal — `query-expr-parallel-track-refusal`.
- Per-row DML in outer DML — separate backlog ticket.

## TODO

### Phase 1 — Confirm runtime emitter locations

- Use `find_references` to locate the scalar-subquery, EXISTS, and IN emitters and the `Sink` run-once semantics.
- Write the run-once fence test against the current behavior; confirm whether `Sink` already enforces it.

### Phase 2 — Emitter changes

- Scalar subquery: full-drain on impure inner.
- EXISTS: full-drain on impure inner.
- IN: full-drain on impure inner.
- Run-once fence at the impure-subquery-emitter level, if not already enforced by `Sink`.

### Phase 3 — Planner

- Remove the planning-time DML-in-expression-position gate added in ticket 1.
- View-creation-time rejection of DML-RETURNING view bodies.

### Phase 4 — Determinism + conflict + view

- Verify determinism enforcer catches DML in CHECK / DEFAULT / assertion; add the negative test.
- Verify conflict resolution does not propagate outer→inner; add the test.
- Verify view-as-VALUES is unupdateable via the FD-driven path; pin with the regression test.

### Phase 5 — Docs

- Update `docs/sql.md`, `docs/runtime.md`, `docs/view-updateability.md`, `docs/architecture.md` per "Documentation" above.

### Validation

- `yarn workspace @quereus/quereus run lint`
- `yarn test` (root) — full suite. Plan-shape golden tests (`test/plan/golden-plans.spec.ts`) need refreshing wherever DML in expression position is now optimized.
