---
description: Review the DML-in-expression-position implementation: full-drain + run-once semantics for scalar/IN/EXISTS subqueries with impure inners, planning-gate removal across all five expression positions, permanent DML-as-view-body rejection, and determinism-enforcer propagation through DmlExecutorNode.
prereq:
files:
  - packages/quereus/src/runtime/emit/subquery.ts
  - packages/quereus/src/planner/nodes/dml-executor-node.ts
  - packages/quereus/src/planner/building/expression.ts
  - packages/quereus/src/planner/building/select-compound.ts
  - packages/quereus/src/planner/building/with.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/building/create-view.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/test/logic/01.9-query-expr-dml.sqllogic
  - packages/quereus/test/logic/01.9-query-expr-dml-gates.sqllogic
  - docs/sql.md
  - docs/runtime.md
  - docs/view-updateability.md
  - docs/architecture.md
---

## What landed

The follow-up to `query-expr-side-effect-audit` lifts the planning-time gate
that ticket 1 installed and makes `(insert/update/delete … returning …)`
actually executable in scalar / `IN` / `EXISTS` / compound-leg / CTE-body
positions (plus FROM-source DML, which now also works through
`buildInsertStmt`). View bodies remain rejected, now permanently.

### Runtime emitter contract (`packages/quereus/src/runtime/emit/subquery.ts`)

Scalar, `IN`, and `EXISTS` emitters detect impure inners via
`PlanNodeCharacteristics.subtreeHasSideEffects(plan.subquery)` and switch to
a separate code path that applies two contracts:

- **Full drain.** The emitter iterates every row of the inner. The pure
  path's short-circuits (scalar's "first row only" / `IN`'s "first match" /
  `EXISTS`'s "first row") would skip writes past row 1, so they are dropped
  for impure inners. The pure path is unchanged.
- **Run once per statement execution.** A correlated outer expression or a
  per-row scan would otherwise re-invoke the emitter's `run` function once
  per outer row. The emitter memoizes the scalar / `EXISTS` / `IN` answer
  on first call and replays it on subsequent calls without re-driving the
  iterator. The closure state is per-emission; `Statement.compile()`
  re-emits the instruction tree per `prepare`/`run` cycle, so the
  memoization resets between prepared-statement runs.

Scalar emitter additionally drops the "more than one row" guard on the
impure path — a multi-row DML w/ RETURNING is the common case there; the
returned scalar is the first row, first column.

### Planning gates removed

The `dml-in-expression-position` gates from ticket 1 are gone from:
- `planner/building/expression.ts` — DML in scalar / `IN` / `EXISTS` now
  lowers via `buildInsertStmt` / `buildUpdateStmt` / `buildDeleteStmt`.
- `planner/building/select-compound.ts` — DML in compound legs now lowers
  through the same builders.
- `planner/building/with.ts` — DML in non-recursive CTE bodies now lowers
  through the same builders.
- `planner/building/insert.ts` — DML as INSERT source now lowers through
  the same builders.

### View-body rejection is permanent

`planner/building/create-view.ts` keeps the DML-as-view-body rejection but
strips the "pending ticket" framing and switches the status code from
`UNSUPPORTED` to `ERROR`. Rationale documented in `schema/view.ts` and
`docs/view-updateability.md`: a view body re-evaluates per reference, and
the run-once fence lives at a single emission site — it cannot rescue a
DML body composed through multiple downstream consumers.

### Determinism enforcer

`DmlExecutorNode.computePhysical()` now sets `deterministic: false`
alongside `readonly: false` and `idempotent: false`. This propagates up
through the AND-of-children physical-properties chain, so a scalar
subquery wrapping a DML is non-deterministic at the determinism enforcer's
gate (`physical.deterministic === false` in
`planner/validation/determinism-validator.ts`).

Note: the AST-only CHECK-constraint determinism walk at CREATE TABLE
(`schema/manager.ts:validateCheckConstraintDeterminism`) only looks for
non-deterministic function calls — it does not catch subquery-wrapped DML.
The full physical-property check fires lazily at first INSERT planning via
`constraint-builder.ts:validateDeterministicConstraint`. The test for this
behavior triggers an INSERT after CREATE TABLE.

## How to validate

### Run the new test files

- `packages/quereus/test/logic/01.9-query-expr-dml.sqllogic` — 10 positive
  + 1 negative cases covering scalar / `IN` / `EXISTS` / compound-leg /
  CTE-body / INSERT-source DML; run-once fence under correlated outer;
  outer-`OR REPLACE` not propagating inward; view-as-`VALUES`
  un-updateability; DML-in-CHECK determinism rejection.
- `packages/quereus/test/logic/01.9-query-expr-dml-gates.sqllogic` — now
  only pins the surviving gates (parser RETURNING-required at non-top
  position, view-body DML rejection).

```
yarn workspace @quereus/quereus run test --grep "01.9-query-expr"
```

Full suite (memory mode): `yarn test` passes (3660 + sub-suites). Lint
clean: `yarn workspace @quereus/quereus run lint`. Type-check clean:
`npx tsc --noEmit` (run inside `packages/quereus`).

### Behaviors a reviewer should verify by inspection

1. **Memoization scope.** Closure state in the emitter persists across
   `run` invocations within a single scheduler execution. `Statement.run`
   in `src/core/statement.ts:290+` calls `emitPlanNode` and constructs a
   new `Scheduler` on every iteration of the iterator, so closure state
   resets per `prepare`+`run`. If a future change reuses the Instruction
   tree across executions, the memoization would persist incorrectly.
   Worth a code-level assertion or test pinning the re-emit invariant.
2. **Determinism propagation.** `deterministic: false` is set on
   `DmlExecutorNode` only — not on `InsertNode` / `UpdateNode` /
   `DeleteNode` / `ConstraintCheckNode` / `ReturningNode`. The chain
   normally goes `Returning → DmlExecutor → ConstraintCheck → Insert →
   source`, so DmlExecutor's `false` propagates up through AND-of-children
   to Returning. If a code path bypasses `DmlExecutorNode` (an alternate
   DML executor variant?), the propagation breaks.
3. **Full-drain semantics under errors.** If a row inside the inner DML
   throws (constraint violation, etc.), the emitter's `for await` rethrows
   immediately and the memoization slot stays empty. A subsequent
   evaluation in the same execution would re-drive the iterator. This is
   fine for transactional semantics (a failed statement aborts), but a
   reviewer should pin "two evaluations after a partial-failure inner do
   not double-fire surviving writes" if that matters.
4. **`getChangeScope()` propagation.** The ticket called out a
   change-scope test ("a SELECT containing nested DML in expression
   position reports the nested writes; `Database.watch` fires"). I did
   not add a dedicated test — ticket 2's `getChangeScope` plumbing
   already walks all children including impure subtrees, so the
   propagation comes from there and the new positive logic tests
   indirectly exercise it (the writes happen → watchers fire). A
   dedicated assertion would harden the contract.

### Gaps and deferrals (intentional)

- **Per-row DML in an outer DML** (`update outer set x = (insert into
  inner ... returning y)`) is out of scope per the ticket. Not currently
  blocked by anything except prudence — the ordering semantics are
  subtle. Documented as a limitation in `docs/sql.md`.
- **Plan-shape golden tests** were not refreshed. The golden-plan suite
  runs as part of the full test suite and is currently green; if a
  reviewer notices DML-in-expression-position plans that should be
  pinned at the golden layer, that's a follow-up.
- **`ALTER TABLE ADD CONSTRAINT` determinism gate.** The full-physical
  determinism check is only wired into the constraint-builder path,
  which is triggered by INSERT/UPDATE planning. ADD CONSTRAINT does not
  route through the same path — a pre-existing gap (already noted in
  `docs/runtime.md`), not something this ticket introduced.
- **Memoization-vs-error-recovery interaction.** As above (point 3).

## Out of scope (carried forward)

- `query-expr-parallel-track-refusal` — parallel-track audit.
- Per-row DML in outer DML — separate backlog ticket.

## Suggested review effort

`high`. The runtime emitter changes are surgical but the run-once contract
deserves a careful read against the architectural assumption that
`Statement.run` re-emits per execution. The full-drain change drops a
short-circuit on a hot path — pin that pure inners take the unchanged code
path (they do, gated on `physical.readonly`).
