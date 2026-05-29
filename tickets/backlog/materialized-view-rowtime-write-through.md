description: Row-time (write-through) materialized-view maintenance — keep an MV's backing table consistent with its source at the moment of each source row-write, not just at COMMIT. This is strictly stronger than `materialized-view-incremental-refresh` (which maintains at COMMIT) and is the prerequisite for using an explicit covering MV's backing table as a row-time UNIQUE-enforcement structure (mid-statement `insert or ignore` / `insert or replace` conflict resolution). Until this exists, explicit covering MVs are recognized + linked (by `covering-structure-unique-enforcement`) but do not drive enforcement; physical-schema UNIQUE enforcement continues to use the synchronously-maintained auto-index, and logical-schema UNIQUE (lens layer) without a maintained structure falls back to commit-time `DeltaExecutor` scans.
files: packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/vtab/memory/layer/manager.ts, docs/materialized-views.md, docs/incremental-maintenance.md
----

## Problem

`materialized-view-core` materializes a backing table at `create` / `refresh` only. `materialized-view-incremental-refresh` adds maintenance, but **at COMMIT** (a post-commit `DeltaSubscription` consumer). Neither keeps the backing table consistent during a statement.

Row-time UNIQUE conflict resolution requires the covering structure to be current *before the conflicting write completes*:

- `insert or replace` must find the existing conflicting row and substitute it **in place, mid-statement**.
- `insert or ignore` must skip the duplicate at write time.
- `abort`/`fail`/`rollback` must raise with the existing conflicting row.

A backing table that is only correct at COMMIT cannot answer these. This is why `covering-structure-unique-enforcement` ships the *recognition + linkage* of explicit covering MVs but **not** enforcement through their backing tables, and why the synchronously-maintained auto-index (today's `ensureUniqueConstraintIndexes` BTree) remains the only sound row-time UNIQUE structure.

## Why it matters

Two downstream consumers need this:

1. **Explicit covering-structure enforcement** (the deferred second half of `covering-structure-unique-enforcement`): once an explicit MV's backing table is row-time-consistent, `findIndexForConstraint` can return `{ kind: 'materialized-view', view }` and `checkUniqueVia*` can point-lookup against it (recovering the source PK from the MV's projection for REPLACE). The `CoveringStructure` surface and the `materialized-view` variant already exist for this.
2. **Lens-layer constraint attachment** (`lens-prover-and-constraint-attachment`, seq 3): retires the auto-index *for logical schemas*. A logical `unique` then has **no** synchronously-maintained structure unless the developer declares an explicit basis covering MV. For that MV to deliver the promised "O(log n), row-time, conflict-resolution-capable" enforcement (per `docs/lens.md` § Constraint Attachment), it must be row-time write-through. Without this capability, logical-schema UNIQUE can only fall back to the commit-time `DeltaExecutor` scan (detection-only; IGNORE/REPLACE unavailable) — which the lens ticket already documents as the `lens.no-backing-index` advisory path, but the "with covering MV → row-time" test requires this capability to pass soundly.

## Requirements / expectations

- A `refresh policy` (or equivalent) that maintains an MV backing table **synchronously with source writes**, within the same transaction, before the writing statement observes its own effects — not deferred to commit.
- Eligibility is at least as strict as `on-commit-incremental` (keyed/grouped bindings; no `'global'` source). The covering-index shape (single-source, linear `Filter → Project → Sort` over the constraint columns) is the easy, first case.
- Interaction with the layered transaction model in `vtab/memory/layer/manager.ts`: the backing table's per-statement layer must reflect the source's pending (uncommitted) writes so a duplicate inserted earlier in the same statement/transaction is visible to the conflict check.
- Cost: write-through is O(1)–O(log n) per source row for the covering-index shape; reject or fall back for shapes where per-row maintenance is not bounded.
- Open question for the planning pass: whether row-time write-through is a distinct policy, or whether the covering-index shape is special-cased (maintained like a secondary index rather than as a general MV) while general MVs stay commit-time. The latter may be the pragmatic first delivery — it is effectively "a user-declared synchronously-maintained materialized index," which is what UNIQUE enforcement actually needs.

## Relationship to other tickets

- **Stronger than** `materialized-view-incremental-refresh` (commit-time). They can coexist as two points on a `refresh policy` spectrum (manual → on-commit-incremental → row-time-write-through).
- **Unblocks** the deferred explicit-MV enforcement half of `covering-structure-unique-enforcement`, and the "covering MV → row-time" obligations of `lens-prover-and-constraint-attachment`.
