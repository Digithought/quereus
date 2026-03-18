description: Systematic review of memory table module (table, module, connection, PK utils)
dependencies: none
files:
  packages/quereus/src/vtab/memory/connection.ts
  packages/quereus/src/vtab/memory/index.ts
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/vtab/memory/table.ts
  packages/quereus/src/vtab/memory/types.ts
  packages/quereus/src/vtab/memory/utils/logging.ts
  packages/quereus/src/vtab/memory/utils/primary-key.ts
----
Review the memory table module: VTab module implementation, table instance management, connection handling, primary key utilities, and type definitions.

Key areas of concern:
- Module create/connect/disconnect lifecycle
- Table DDL operations (column add/drop, schema changes)
- Primary key encoding/decoding correctness
- Connection state management
- Index info generation accuracy

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
