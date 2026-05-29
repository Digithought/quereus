description: Route row-time UNIQUE enforcement through an explicit covering materialized view's backing table — the deferred second half of `covering-structure-unique-enforcement`. That ticket shipped the recognition + linkage (the coverage prover, the `CoveringStructure` surface with its reserved `materialized-view` variant, and the eager constraint↔structure link), but deliberately did NOT enforce through an explicit MV: an MV backing table is only consistent at create/refresh (or, with the incremental sibling, at COMMIT), so it cannot answer mid-statement conflict resolution. Once row-time write-through MV maintenance exists, an explicit covering MV can become a real row-time enforcement structure: `findIndexForConstraint` returns `{ kind: 'materialized-view', view }` and the conflict check point-looks-up the MV's backing table.
prereq: materialized-view-rowtime-write-through
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/schema/view.ts, packages/quereus-store/src/common/store-table.ts, docs/materialized-views.md, docs/lens.md
----

## What this is

The covering-structure arc split into a sound, shippable half (recognition +
linkage, landed by `covering-structure-unique-enforcement`) and this unsound-
until-prerequisite half (enforcement through the recognized structure). This
ticket lands the second half once its prerequisite
(`materialized-view-rowtime-write-through`) exists.

## Soundness gate (why this was deferred)

Row-time conflict resolution requires the covering structure to be consistent
*at the moment of the write*, before the statement observes its own effects:

- `insert or replace` substitutes the conflicting row in place, mid-statement;
- `insert or ignore` skips the duplicate at write time;
- the default `abort` (and `fail` / `rollback`) raises with the existing row.

An explicit MV's backing table is materialized at create/refresh (manual) or, at
best, maintained at COMMIT (`materialized-view-incremental-refresh`) — neither is
row-time. So enforcing through it would silently miss or mis-resolve conflicts.
`materialized-view-rowtime-write-through` is exactly the capability that closes
this gate; this ticket consumes it.

## Expected behavior once landed

- `MemoryTableManager.findIndexForConstraint` may return the
  `{ kind: 'materialized-view', view }` variant of `CoveringStructure` when a
  linked, row-time-maintained covering MV exists for the constraint (the variant
  and the link already exist; today the manager throws `StatusCode.UNSUPPORTED`
  on that arm — see `checkSingleUniqueConstraint`).
- The UNIQUE conflict check performs a key existence lookup against the covering
  MV's backing table, recovering the source row's primary key from the MV's
  projection (the coverage prover already requires the PK to be projected, for
  exactly this reason) so REPLACE can evict/substitute the correct source row.
- Store-path parity (`quereus-store/src/common/store-table.ts`): the MV-backed
  lookup is a backing-table query through the db and is module-agnostic (MV
  backing tables are always the `memory` module in v1), so the store path gains
  the same capability without a separate enforcement implementation.

## Where it becomes load-bearing

For **physical** schemas this is an optimization only — the synchronously-
maintained auto-index already enforces, so an explicit covering MV merely adds a
read-answering copy. The explicit MV becomes the *sole* enforcement structure in
the **logical-schema** world (`lens-prover-and-constraint-attachment`, seq 3),
where the auto-index is retired. That ticket's "covering MV → row-time,
conflict-resolution-capable" obligation (per `docs/lens.md` § Constraint
Attachment) cannot be met soundly without this enforcement path plus its
write-through prerequisite.

## Out of scope

- Building the row-time write-through maintenance itself
  (`materialized-view-rowtime-write-through` — the prereq).
- FD-driven and multi-source coverage recognition
  (`coverage-prover-fd-driven-coverage`, `coverage-prover-multi-source-bodies`).
