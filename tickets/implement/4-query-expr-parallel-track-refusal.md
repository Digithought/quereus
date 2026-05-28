---
description: Parallel-execution rules (EagerPrefetchNode / AsyncGatherNode / FanOutLookupJoinNode) must refuse to gather/fork when any sibling subtree has hasSideEffects=true. Connection-lock correctness gate that pairs with dml-in-expression-position.
prereq: query-expr-side-effect-audit
files:
  - packages/quereus/src/planner/rules/cache/rule-async-gather-zip-by-key.ts
  - packages/quereus/src/planner/nodes/eager-prefetch-node.ts
  - packages/quereus/src/planner/nodes/async-gather-node.ts
  - packages/quereus/src/planner/nodes/fan-out-lookup-join-node.ts
  - packages/quereus/src/planner/framework/characteristics.ts
  - docs/optimizer.md
  - docs/runtime.md
---

## Background

`EagerPrefetchNode`, `AsyncGatherNode`, and `FanOutLookupJoinNode` fork the `RuntimeContext` and drive children concurrently. The module concurrency contract (`'serial'` / `'reentrant-reads'` / `'fully-reentrant'`) governs *reads*. A DML subtree inside a parallel-driven sibling violates the connection lock under everything except `'fully-reentrant'` — no module currently advertises that level. The parallel-recognition rules must therefore refuse to fold a tree when any participating branch has `hasSideEffects = true`.

Ticket 2 made `hasSideEffects` reliable. This ticket is the parallel-track consumer of that signal. Can land alongside ticket 3 or after — they don't depend on each other, only both on ticket 2.

## Implementation

`FanOutLookupJoinNode` already carries a `concurrencySafe` per-branch flag (per the plan). Lift that into a shared predicate on `PlanNodeCharacteristics` (or extend the existing `hasSideEffects` consumers):

```ts
static isConcurrencySafe(node: PlanNode): boolean {
  // Branch is safe to drive concurrently iff it has no side effects
  // AND its module-concurrency-contract is satisfied. For now, side-effect
  // freedom is the sole gate; module-level checks are existing behavior.
  return !PlanNodeCharacteristics.hasSideEffects(node);
}
```

Then:

- `rule-async-gather-zip-by-key.ts` (and any other rules that introduce `AsyncGatherNode` / `EagerPrefetchNode`): consult `isConcurrencySafe` on every branch under consideration. Refuse the rewrite if any branch is impure.
- `FanOutLookupJoinNode` recognition rule: same — refuse if the per-branch flag (now derived from `isConcurrencySafe`) reports unsafe.

This is a **refusal**, not a fallback to a serial variant. The parallel rules are optimizations; refusing leaves the serial plan in place, which is correct.

## Registry declaration

Per ticket 2's discipline, each parallel-recognition rule registers as `side-effect-aware`. This ticket adds the actual consultation behind that declaration.

## Tests

- **Parallel-track refusal positive**: a pure plan with multiple branches gets the parallel-recognition rewrite (regression test for the optimization still firing on the common case).
- **Parallel-track refusal negative**: hand-construct or build-via-SQL a plan with `hasSideEffects = true` inside one branch of a candidate `AsyncGatherNode` / `FanOutLookupJoinNode` site. Assert the rule does **not** fold. Use `select * from (insert into t … returning *) join u on …` or similar shape that today (without this guard) would fan-out-lookup.
- **End-to-end correctness**: SQL that mixes DML in expression position with sibling reads (post-ticket-3 runnable) produces correct results — writes happen exactly once, in textual order, never concurrently with sibling reads on the same connection.

## Documentation

- `docs/optimizer.md` — add a section on parallel-track recognition and the side-effect refusal rule.
- `docs/runtime.md` — note the connection-lock contract and how impure subtrees interact with it.

## Out of scope

- Lifting the connection-lock contract to allow truly-reentrant modules. Modules can opt into `'fully-reentrant'` independently; if and when one does, the predicate above can be refined to allow concurrent impure execution on that module. Not part of this ticket.

## TODO

- Add `isConcurrencySafe` to `PlanNodeCharacteristics` (or equivalent shared predicate).
- `rule-async-gather-zip-by-key.ts`: consult on every branch; refuse on impure.
- `FanOutLookupJoinNode` recognition rule: consult on every branch; refuse on impure.
- `EagerPrefetchNode` introduction rule(s): same.
- Audit fixtures: positive (pure plan still gets the rewrite) + negative (impure plan does not).
- End-to-end correctness test (requires ticket 3 to be runnable end-to-end).
- Docs: `docs/optimizer.md`, `docs/runtime.md`.

### Validation

- `yarn workspace @quereus/quereus run lint`
- `yarn test` (root)
