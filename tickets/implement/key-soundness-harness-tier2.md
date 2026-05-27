description: Add Tier-2 (isolated per-node materialization) to the key-soundness property harness — walk every relational node in the optimized tree, emit + run it in isolation, and assert keysOf()/isSet hold on that node's own rows. Deferred from the unified-key-inference-surface ticket, which shipped Tier-1 (result-node assertion) only.
files: packages/quereus/test/property.spec.ts, packages/quereus/src/func/builtins/explain.ts, packages/quereus/src/runtime/scheduler.ts, packages/quereus/src/runtime/emit/emit-plan-node.ts
----

## Background

The `unified-key-inference-surface` work added a `describe('Key Soundness', …)` block to `packages/quereus/test/property.spec.ts`. It shipped **Tier 1** (required): generate query shapes spanning the node zoo, read `keysOf()` / `isSet` off the **top relational result node**, materialize via `db.eval`, and assert no claimed key (and no `isSet`) is contradicted by a duplicate. Tier 1 already surfaced two real over-claims (`combineJoinKeys` inner/cross union; `set-operation-node` copying `leftType.keys` for UNION), both fixed.

**Tier 2** (best-effort, deferred here) asserts the same invariants per **inner node**, not just the result node — a stronger check that pins the soundness of every operator's `getType()` / `computePhysical`, independent of whether a given shape happens to surface that node at the top.

## What to build

For each relational node in the **optimized** plan tree:
- attempt `emitPlanNode(node, new EmissionContext(db))` + `new Scheduler(rootInstruction).run(ctx)` to materialize that node's rows in isolation (precedent: `scheduler_program` in `func/builtins/explain.ts`; `Scheduler` in `runtime/scheduler.ts`).
- wrap in try/catch: correlated / parameterized inner nodes won't emit standalone — **skip on emission/run failure** (this tier is a bonus, not a gate; a skip must not fail the test).
- for nodes that do materialize, run the same assertions Tier 1 uses (factor out / reuse `checkNoOverClaim` and `tupleSig`, already in `property.spec.ts`):
  - (a) every key `K` in `keysOf(node)` projects to all-distinct tuples on the node's rows; the empty key `[]` ⇒ ≤1 row;
  - (b) if `node.getType().isSet === true`, the full rows are distinct.

Keep `numRuns` modest (~50) to stay within the test idle budget.

## Acceptance

- Tier-2 walk added to the existing `Key Soundness` block, gated so emission/run failures **skip** rather than fail.
- If it proves too flaky to stabilize, document why and keep it disabled-by-default behind an env flag (mirror `PROPERTY_LONG`) rather than deleting it.
- No regression to Tier 1.
