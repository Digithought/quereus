---
description: Review the reusable DeltaExecutor kernel, FD-aware BindingExtractor, projection-capture support in ChangeCapture, and the AssertionEvaluator migration that finally drives 'group' classifications through per-group-key residual execution.
prereq:
files:
  - packages/quereus/src/planner/analysis/binding-extractor.ts (new)
  - packages/quereus/src/runtime/delta-executor.ts (new)
  - packages/quereus/src/core/database-transaction.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/planner/optimizer-tuning.ts
  - packages/quereus/test/optimizer/binding-extractor.spec.ts (new)
  - packages/quereus/test/incremental/delta-executor.spec.ts (new)
  - packages/quereus/test/logic/95-assertions.sqllogic
  - docs/optimizer.md
  - docs/architecture.md
  - docs/incremental-maintenance.md (new)
---

## What landed

A reusable change-driven kernel (`DeltaExecutor`) is in place, the assertion
path migrated onto it, and `'group'` classifications now drive per-group-key
residual execution instead of falling back to a full violation query. The
shared surface is shaped so future MV / signal / trigger consumers can plug
in without rewriting change capture or binding-key analysis.

### Surface diagram

```
DML emitter → TransactionManager (CapturedRow per PK, OLD/NEW projections when
  any registered column changes) → DeltaExecutor → DeltaSubscription.apply
  (per-relation tuple batches + globalRelations set)
```

`extractBindings(plan)` packages `analyzeRowSpecific`'s output into per-
TableReference `BindingMode { 'row' | 'group' | 'global' }`. The assertion
evaluator registers one subscription per assertion on first compile, holds
projection-capture dispose handles in its cache, and releases everything on
schema-change invalidation.

### Key code locations

- `binding-extractor.ts` — `extractBindings`, `chooseRowKey` (PK preferred,
  else lex-min covered key).
- `delta-executor.ts` — `DeltaExecutor.runAll`, cost fallback via
  `tuning.deltaPerRowFallbackRatio` (default `0.5`).
- `database-transaction.ts` — `registerCaptureSpec`, `getChangedTuples`,
  `recordInsert/Update/Delete` (now full-row + PK indices), updated savepoint
  merge with last-write-wins per PK + DELETE-after-INSERT collapse.
- `database-assertions.ts` — `injectKeyFilter` (renamed from `injectPkFilter`),
  pre-compiled residuals per `'row'`/`'group'` relation, no-deps assertion
  short-circuit at `runGlobalAssertions`.
- DML emitter — INSERT/UPDATE/DELETE call sites now pass full pre/post rows
  + PK column indices.

## Testing performed

- Added `test/optimizer/binding-extractor.spec.ts` (5 cases): row on PK; row
  on UNIQUE via FD closure; group on PK GROUP BY; global without coverage;
  independent BindingModes per join side.
- Added `test/incremental/delta-executor.spec.ts` (10 cases): row dispatch;
  group dispatch; global flag; multi-relation independence; cost fallback at
  ratio; below-ratio per-tuple dispatch; skip when deps unchanged; exception
  propagation; no-change no-invoke; dispose handle removes subscription.
- Extended `test/logic/95-assertions.sqllogic` with a `'group'` end-to-end
  case (`orders_nonneg`): commit-time violation properly fails the COMMIT,
  rollback leaves state intact.
- `yarn lint` — clean.
- `yarn test` — 2892 passing, 2 pending (no new failures).
- `yarn test:store` — not run by this pass; spot-check before sign-off.

## Things to scrutinize

- **Savepoint layer release.** The merge logic in `releaseSavepointLayer`
  duplicates the PK-level merge state machine from `mergeRecord` (insert-then-
  delete collapses, update-then-delete demotes, etc.). The two paths are
  consistent today; a future refactor could share one merge function. No
  property-style test exercises every layered combination — the existing
  savepoint sqllogic case (`sp_positive`) covers the basic INSERT-inside-
  savepoint flow but not multi-layered transitions.
- **Cost fallback granularity.** The ratio check compares `tuples.length` to
  `estimatedRows`. For `'group'` dispatch on a wide table where one row
  change emits both OLD and NEW group projections, the kernel may demote
  earlier than ideal. Threshold is configurable via `OptimizerTuning`.
- **Per-subscription residual cache.** Each assertion owns its compiled
  residuals; a second consumer adding identical residual shape will not share
  them. Acceptable today since MV/signal residuals diverge structurally;
  revisit when a duplication pattern emerges.
- **No-deps assertion handling.** Assertions whose plan references no tables
  (e.g. `CHECK (1 = 0)`) are dispatched directly from `runGlobalAssertions`
  outside the kernel. Edge cases:
    - The direct dispatch runs *before* `executor.runAll()`. If both a
      no-deps assertion and a table-dep assertion fire on the same commit,
      the no-deps one throws first. That preserves the existing test
      expectations but may differ from any ordering an MV path would assume.
- **`getChangedTuples` projection contract.** The function throws if a
  requested column is not in the captured projection. `DeltaExecutor` catches
  the throw and demotes the relation to global, but the runtime log noise is
  the only signal a consumer registered the wrong spec. A stronger contract
  (e.g. enforce capture-spec registration at subscription register-time)
  could fail fast — left for follow-up.
- **`runAll` ordering.** Subscriptions are iterated in registration order
  with no parallelism. For many assertions, this is fine; for MVs that may
  benefit from inter-dependency ordering, a topological-sort pass is a
  natural next addition.
- **Cleanup on `dispose`.** Each cached assertion entry holds a subscription
  dispose handle and a set of capture dispose handles. `releaseCached` calls
  both; the test surface doesn't currently assert that capture demand is
  fully released after `DROP ASSERTION`. Worth a focused inspection.
- **Test gaps the implementer is aware of:**
    - No test asserts the OLD/NEW group-projection behaviour for an UPDATE
      that shifts group-key value. The DeltaExecutor mock test takes tuples
      as given; the integration story relies on the TransactionManager being
      correct (per the merge state machine).
    - No test exercises the cost-fallback path end-to-end through a real
      assertion (the kernel test uses a mock context). Adding one would
      involve seeding a large table and a small `deltaPerRowFallbackRatio`.
    - The sqllogic `orders_nonneg` case asserts only the failure path; no
      check that the per-group dispatch actually runs N=1 times for a
      one-row change (probe assertion suggested in the implement ticket was
      not added).

## Out-of-scope confirmations

- Materialized-view DDL/storage is **not** in this pass — see
  `tickets/backlog/4-materialized-views.md`. The kernel surface is shaped so
  the MV ticket can plug in by defining `MaterializedViewSchema` and
  registering a `DeltaSubscription`.
- `tickets/backlog/3-incremental-delta-runtime.md` was removed during this
  pass — superseded by the work in this ticket.
