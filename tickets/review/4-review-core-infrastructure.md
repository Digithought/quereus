description: Systematic review of core infrastructure (Database, Statement, connections)
dependencies: none
files:
  packages/quereus/src/core/database.ts
  packages/quereus/src/core/database-assertions.ts
  packages/quereus/src/core/database-events.ts
  packages/quereus/src/core/database-internal.ts
  packages/quereus/src/core/database-options.ts
  packages/quereus/src/core/database-transaction.ts
  packages/quereus/src/core/param.ts
  packages/quereus/src/core/statement.ts
  packages/quereus/src/core/utils.ts
  packages/quereus/src/common/constants.ts
  packages/quereus/src/common/datatype.ts
  packages/quereus/src/common/errors.ts
  packages/quereus/src/common/json-types.ts
  packages/quereus/src/common/logger.ts
  packages/quereus/src/common/type-inference.ts
  packages/quereus/src/common/types.ts
  packages/quereus/src/index.ts
----
Review the core database infrastructure and common shared types/utilities.

This is the foundation layer: Database class, Statement lifecycle, parameter handling, error types, logging, constants, and shared type definitions.

Key areas of concern:
- Resource cleanup in Database and Statement (connections, cursors)
- Transaction lifecycle correctness
- Event emission correctness and listener cleanup
- Error type hierarchy and context preservation
- Thread safety of shared state

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
