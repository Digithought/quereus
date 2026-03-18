description: Systematic review of memory table layer (B-tree, transactions, cursors, manager)
dependencies: none
files:
  packages/quereus/src/vtab/memory/layer/base.ts
  packages/quereus/src/vtab/memory/layer/base-cursor.ts
  packages/quereus/src/vtab/memory/layer/connection.ts
  packages/quereus/src/vtab/memory/layer/interface.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/vtab/memory/layer/safe-iterate.ts
  packages/quereus/src/vtab/memory/layer/scan-plan.ts
  packages/quereus/src/vtab/memory/layer/transaction.ts
  packages/quereus/src/vtab/memory/layer/transaction-cursor.ts
----
Review the memory table storage layer: B-tree base layer, cursor implementations, transaction isolation, layer manager, and scan planning.

Key areas of concern:
- Transaction isolation correctness (snapshot reads, write visibility)
- Cursor lifecycle and cleanup (especially on error/break)
- Layer manager — compaction, merging, garbage collection
- Safe iteration under concurrent mutation
- Scan plan efficiency and correctness
- B-tree operations (insert, delete, range scan boundary conditions)

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
