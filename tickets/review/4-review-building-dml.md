description: Systematic review of planner building for DML (INSERT, UPDATE, DELETE)
dependencies: none
files:
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/delete.ts
  packages/quereus/src/planner/building/constraint-builder.ts
  packages/quereus/src/planner/building/foreign-key-builder.ts
----
Review the DML plan builders: INSERT (including ON CONFLICT, multi-row, INSERT...SELECT), UPDATE, DELETE, constraint validation builder, and foreign key action builder.

Key areas of concern:
- INSERT column mapping (explicit vs implicit, DEFAULT, missing columns)
- INSERT...SELECT type coercion
- ON CONFLICT — target detection, DO UPDATE SET bindings, WHERE clause
- UPDATE — SET target resolution, subquery in SET
- DELETE — WHERE clause binding
- Constraint builder — CHECK evaluation ordering, deferred constraints
- Foreign key builder — CASCADE/SET NULL/SET DEFAULT/RESTRICT action generation
- Foreign key builder — self-referencing FK handling
- RETURNING clause integration with DML

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
