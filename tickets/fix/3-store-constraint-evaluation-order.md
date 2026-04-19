description: Store and memory surface different constraint-violation errors when a row violates multiple assertions simultaneously
dependencies: none
files:
  packages/quereus/src/runtime/deferred-constraint-queue.ts
  packages/quereus-store/src/common/store-module.ts
  packages/quereus/test/logic/29-constraint-edge-cases.sqllogic
----

Reproduced by `29-constraint-edge-cases.sqllogic:156` under `QUEREUS_TEST_STORE=true`:

```sql
-- Two assertions: ma_a_positive (a > 0) and ma_b_small (b < 100)
BEGIN;
INSERT INTO ma_data VALUES (4, -5, 10);
COMMIT;
-- expected error: "Integrity assertion failed: ma_a_positive"
-- store error:    "Integrity assertion failed: ma_b_small [(1)]"
```

Both assertions are violated by the insert (`a = -5` violates positivity, and another row evidently trips `ma_b_small`). Memory reports `ma_a_positive` first; store reports `ma_b_small`. The test asserts on a specific message — so either the test is over-specifying evaluation order or there's a meaningful ordering difference.

### Decision required

Is evaluation order a contract, or test over-specification?

- If contract: pin the order (likely schema-declaration order) in `DeferredConstraintQueue` so memory and store agree
- If not contract: loosen the test to accept either message, and document that order is unspecified when multiple assertions fail in one commit

Before fixing, decide the semantics. This ticket captures the question; the implementor should resolve it or route back via `blocked/` with the tradeoff.

### TODO

- Inspect `DeferredConstraintQueue.evaluateEntry` ordering
- Confirm whether store registers assertions in a different order than memory (e.g. stable vs. insertion-order iteration of a Map keyed differently)
- Pick a resolution; update code or test accordingly
- Re-run `29-constraint-edge-cases.sqllogic` in store mode
