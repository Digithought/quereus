description: Systematic review of runtime emitters for DML and DDL operations
dependencies: none
files:
  packages/quereus/src/runtime/emit/insert.ts
  packages/quereus/src/runtime/emit/update.ts
  packages/quereus/src/runtime/emit/delete.ts
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/runtime/emit/returning.ts
  packages/quereus/src/runtime/emit/constraint-check.ts
  packages/quereus/src/runtime/emit/add-constraint.ts
  packages/quereus/src/runtime/emit/create-table.ts
  packages/quereus/src/runtime/emit/create-view.ts
  packages/quereus/src/runtime/emit/create-index.ts
  packages/quereus/src/runtime/emit/create-assertion.ts
  packages/quereus/src/runtime/emit/drop-table.ts
  packages/quereus/src/runtime/emit/drop-view.ts
  packages/quereus/src/runtime/emit/drop-assertion.ts
  packages/quereus/src/runtime/emit/alter-table.ts
  packages/quereus/src/runtime/emit/schema-declarative.ts
  packages/quereus/src/runtime/emit/analyze.ts
  packages/quereus/src/runtime/emit/transaction.ts
  packages/quereus/src/runtime/emit/block.ts
  packages/quereus/src/runtime/emit/pragma.ts
----
Review runtime emitters for DML and DDL: INSERT/UPDATE/DELETE execution, DML executor (batching, conflict handling), RETURNING, constraint checking, all CREATE/DROP/ALTER emitters, declarative schema migration, ANALYZE, transactions, blocks, and PRAGMAs.

Key areas of concern:
- DML executor — mutation batching, conflict resolution (ON CONFLICT), change counting
- Constraint check — ordering (CHECK before FK? NOT NULL first?), deferred constraints
- RETURNING — correct post-mutation row content
- Transaction emitter — savepoint nesting, error rollback
- DDL emitters — schema mutation atomicity, catalog update ordering
- ALTER TABLE — data migration for type changes, constraint preservation
- Declarative schema — diff application order (drops before creates? renames?)
- ANALYZE — statistics collection accuracy
- Resource cleanup on DML failure (partial inserts rolled back)

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
