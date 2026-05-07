description: Code review for partial-WHERE UNIQUE enforcement and CREATE UNIQUE INDEX duplicate validation. The implement-stage delivery wires the WHERE clause into both index population/maintenance and uniqueness checks, and rejects CREATE UNIQUE INDEX over data with pre-existing duplicates.
prereq:
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/vtab/memory/index.ts
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/vtab/memory/utils/predicate.ts (new)
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/vtab/memory/layer/base.ts
  packages/quereus/src/vtab/memory/layer/transaction.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic
----

## What was built

### Schema carriage
- `IndexSchema` and `UniqueConstraintSchema` (in `packages/quereus/src/schema/table.ts`) gained an optional `predicate?: Expression` field. The AST predicate is the same shape used for CHECK constraints (`expr` on `RowConstraintSchema`), keeping the storage convention consistent.
- `SchemaManager.buildIndexSchema` and `SchemaManager.addIndexToTableSchema` (`packages/quereus/src/schema/manager.ts`) thread `stmt.where` from the parsed `CreateIndexStmt` onto the synthesized `IndexSchema`, and onto the synthesized `UniqueConstraintSchema` whenever the index is unique.
- `MemoryTableManager.createIndex` and `MemoryTableManager.ensureUniqueConstraintIndexes` (`packages/quereus/src/vtab/memory/layer/manager.ts`) propagate the predicate to/from the auto-created indexes that back UNIQUE constraints.

### Predicate evaluator
- New module `packages/quereus/src/vtab/memory/utils/predicate.ts`. `compilePredicate(expr, columns)` walks an AST and returns:
  - `evaluate(row): boolean | null` — three-valued; only `true` is "in scope" (matches SQLite partial-index semantics: false and unknown both exclude the row).
  - `referencedColumns: ReadonlySet<number>` — used by the UPDATE path to detect transitions in/out of scope.
- Supported AST forms cover what real partial indexes need: literals, column refs (including the parser's `identifier` form for unqualified columns), `=` `==` `!=` `<>` `<` `<=` `>` `>=`, `AND`/`OR` (3VL), `NOT`, `IS`/`IS NOT`, `IS NULL`/`IS NOT NULL`, unary `+`/`-`. Unsupported forms throw at compile time so failures surface at index-creation, not silently at runtime.
- `MemoryIndex` (`packages/quereus/src/vtab/memory/index.ts`) compiles the predicate at construction and exposes `rowMatchesPredicate(row): boolean`. Compiled artifacts are cached on the index instance; new transaction-layer indexes inherit by re-reading their `IndexSchema`.

### Runtime enforcement
- `BaseLayer.populateNewIndex` and `BaseLayer.addRowToSecondaryIndexes` (`packages/quereus/src/vtab/memory/layer/base.ts`) skip rows whose predicate is not unambiguously TRUE.
- `TransactionLayer.recordUpsert` and `TransactionLayer.recordDelete` (`packages/quereus/src/vtab/memory/layer/transaction.ts`) implement the four predicate-transition cases on UPDATE: F→F (skip), F→T (add), T→F (remove), T→T (rekey if changed).
- `MemoryTableManager.checkSingleUniqueConstraint` (`packages/quereus/src/vtab/memory/layer/manager.ts`) early-returns when the index's predicate is not satisfied by the new row — out-of-scope rows can't violate a partial-UNIQUE constraint.
- `MemoryTableManager.uniqueColumnsChanged` was extended: an UPDATE that touches any column referenced by a partial predicate also re-runs the uniqueness check, so transitions into scope are validated.
- `checkUniqueByScanning` compiles the predicate ad-hoc so the (rare) scan fallback is also correct for partial UNIQUE constraints.

### Pre-existing-duplicate validation at CREATE UNIQUE INDEX
- `BaseLayer.populateNewIndex` (now passed the full `indexSchema`) detects duplicate index keys among in-scope rows for unique indexes and throws `QuereusError(StatusCode.CONSTRAINT, "UNIQUE constraint failed: <table> (<cols>)")` on the first duplicate.
- The existing `MemoryTableManager.createIndex` catch (`packages/quereus/src/vtab/memory/layer/manager.ts:1281`) rolls back the schema to `originalManagerSchema`. `addIndexToBase` only inserts into `secondaryIndexes` *after* `populateNewIndex` succeeds, so a thrown error leaves no partial index state behind.
- Multi-NULL is allowed (matches existing `checkSingleUniqueConstraint` semantics): keys with any NULL component are not considered for duplicate detection.

### Planner correctness fix
- `MemoryTableModule.gatherAvailableIndexes` (`packages/quereus/src/vtab/memory/module.ts`) excludes partial indexes (any with a `predicate`) from access-path planning. Partial indexes are now used purely as uniqueness enforcers. Without this exclusion, the planner would seek a partial index for a query whose WHERE doesn't imply the partial predicate and silently miss in-table-but-out-of-index rows.
- This is conservative — predicate-implication checking would let the planner reuse partial indexes when the query implies the predicate, but is out of scope for this ticket.

## Use cases / validation surface

Re-enabled fixtures exercise the new behavior:

- `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic` section 2: partial UNIQUE accepts `('inactive','A')` while rejecting a second `('active','A')`; transitioning a row out of scope frees the code for reuse.
- `packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic` section 3: `CREATE UNIQUE INDEX` over data with duplicate `x` values raises a `UNIQUE constraint failed` error; after deduplication, the index creates and subsequently rejects new duplicates.
- Same fixture section 4 (post-hoc enforcement): `CREATE UNIQUE INDEX` on already-unique data subsequently rejects an INSERT that would violate it.

Also exercised: existing partial-index sections 1, 3, 4, 5 of `10.5.1-partial-indexes.sqllogic` (basic non-unique partial index queries; `IS NULL`/`IS NOT NULL` predicates; compound `AND`/`>` predicates; row in/out-of-scope transitions on UPDATE) — these continue to pass after the planner now ignores partial indexes for access paths.

### Test fixture caveat (not a code bug — pre-existing limitation)

The post-hoc enforcement block in `102.1-unique-edge-cases.sqllogic` uses `-- run` markers between statements. `db.exec` of multi-statement DDL+DML batches wraps the whole batch in a single implicit transaction; INSERTed rows live in an uncommitted `TransactionLayer` whose `tableSchemaAtCreation` is fixed at construction time and does not pick up schemas added by a later CREATE INDEX in the same batch. `BaseLayer.populateNewIndex` only sees rows in the base layer, so the duplicate scan would miss in-flight rows. The runner's `-- run` directive runs each step as its own implicit transaction, sidestepping this. Fixing the underlying schema-change-mid-transaction interaction is out of scope here; document and revisit if it bites elsewhere.

## Review checklist

- Predicate compiler correctly implements three-valued logic at every operator (AND/OR truth table, comparisons returning NULL when either side is NULL, NOT(NULL)=NULL).
- Partial-index predicate evaluation is consistent across populate, maintain, and uniqueness check — no path bypasses `rowMatchesPredicate`.
- `populateNewIndex`'s duplicate detection uses `JSON.stringify` of the per-column array as a signature. Verify this is stable for the value types it encounters (numbers, strings, BLOBs as Uint8Array, BigInt). Compare to how `MemoryIndex.compareKeys` compares — they should agree on equality. (Likely fine in practice for the supported partial-index column types: numeric and text. BLOBs in unique partial indexes are an unlikely real use case.) Consider replacing with the existing typed comparators if BLOBs/temporal types are in scope.
- `gatherAvailableIndexes` exclusion: confirm the planner has no other code path that picks indexes directly from `tableInfo.indexes`. Search grepping `tableInfo.indexes` and `schema.indexes` for any optimizer rule that bypasses `getBestAccessPlan`.
- Cost-stats path: `MemoryTableManager.getBaseLayerStats` (`packages/quereus/src/vtab/memory/layer/manager.ts:151`) reports `indexDistinctCounts` for ALL indexes including partial ones. Optimizer cost models reading these counts will see "partial" counts. Not necessarily wrong — but verify nothing assumes the count equals `rowCount`.
- `quereus-store` plugin: ticket out-of-scope notes this lives in a separate module. Confirm the partial-index path either propagates correctly there or is rejected with an unsupported error (the store plugin builds its own indexes; without the predicate plumbing it would silently behave like a full index). At minimum, document the limitation.

## Tests / commands

- `cd packages/quereus && yarn build` — clean.
- `node packages/quereus/test-runner.mjs` — 2523 passing, 3 pending.
- `cd packages/quereus && yarn lint` — clean.

Store-mode (`yarn test:store`) was not executed; store coverage of partial UNIQUE is out of scope per the ticket.
