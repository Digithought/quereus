description: Add tests for under-covered schema catalog, memory vtab transactions, and core API paths
dependencies: none
files:
  packages/quereus/src/schema/catalog.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/schema/window-function.ts
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/schema-hasher.ts
  packages/quereus/src/vtab/memory/layer/connection.ts
  packages/quereus/src/vtab/memory/layer/transaction.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/vtab/best-access-plan.ts
  packages/quereus/src/vtab/events.ts
  packages/quereus/src/core/database-options.ts
  packages/quereus/src/core/database-transaction.ts
  packages/quereus/src/core/statement.ts
  packages/quereus/src/util/mutation-statement.ts
  packages/quereus/src/util/plugin-helper.ts
  packages/quereus/test/logic/
----
The schema, vtab/memory, and core API layers have 325 uncovered branches across schema (89),
vtab/memory (136), and core (102). These are the data integrity layers — bugs here can cause
data corruption, transaction isolation violations, and API-level failures.

**Worst offenders:**

| File | Branch % | Uncov | Risk |
|------|----------|-------|------|
| mutation-statement.ts (util) | N/A | — | 24% stmts, 0 funcs — essentially dead code |
| plugin-helper.ts (util) | N/A | — | 50% stmts, 0 funcs — plugin registration edge cases |
| database-options.ts | 65% | 16 | Option validation, pragma handling |
| catalog.ts | 67% | 11 | DDL generation (quoting, syntax), schema iteration |
| window-function.ts (schema) | N/A | — | 69% stmts — window function schema registration |
| connection.ts (vtab/memory) | 62% | 10 | Savepoint stack, lazy txn creation, MVCC layer transitions |
| transaction.ts (vtab/memory) | 76% | 10 | Nested txn handling, explicit vs implicit txn transitions |
| manager.ts (vtab/memory) | 77% | 49 | Layer lifecycle, merge operations, concurrent access |
| best-access-plan.ts | 69% | 7 | Index selection, constraint matching |
| events.ts (vtab) | 72% | 6 | Event batching, delivery after commit |
| schema-hasher.ts | 83% | 3 | Hash computation for schema change detection |
| table.ts (schema) | 76% | 27 | Table metadata, column resolution, constraint storage |
| manager.ts (schema) | 77% | 41 | Schema search paths, multi-schema resolution |

**Test strategy:** Primarily `.sqllogic` tests for transaction/schema paths, unit tests for catalog
and manager internals.

### Memory vtab transactions (69 uncovered branches — data integrity critical)

- **Savepoint edge cases**: Nested savepoints (3+ levels), release inner savepoint then rollback outer, savepoint with same name at different levels
- **Transaction isolation**: Read committed vs snapshot isolation, dirty reads (should not occur), phantom reads
- **Concurrent mutations**: INSERT in one txn, SELECT in another (isolation check)
- **Empty transactions**: BEGIN + COMMIT with no mutations, BEGIN + ROLLBACK
- **Layer management**: Many small transactions (layer accumulation), large single transaction
- **Commit after failed statement**: Statement fails mid-transaction, subsequent operations should still work

### Schema catalog (79 uncovered branches)

- **DDL round-trip**: Create table → export DDL → drop → re-create from exported DDL → verify identical
- **Multi-schema**: Create tables in different schemas, resolve with search_path, cross-schema references
- **Schema change events**: Verify events fire for CREATE/DROP/ALTER of tables, views, indexes, assertions
- **Window function registration**: Register custom window function, use in query, verify schema
- **Catalog introspection**: `pragma table_info`, `pragma index_list` for edge cases (tables with no indexes, many columns)

### Core API paths (102 uncovered branches)

- **Database options**: All pragma values, invalid pragma names, pragma on closed database
- **Statement lifecycle**: Prepare → finalize without running, prepare same SQL twice, finalize twice (idempotent?)
- **Error propagation**: SQL syntax error in `db.exec()`, runtime error in `db.get()`, constraint violation in `db.run()`
- **Plugin helper**: Register plugin with missing module, register duplicate module name

### Property-based extensions

- Transaction isolation property: concurrent read+write txns never see partial state
- Schema DDL roundtrip: `export_schema() → drop all → exec(exported) → export_schema()` = identical

TODO:
- Create `test/logic/101-transaction-edge-cases.sqllogic` — savepoint nesting, empty txns, commit-after-fail
- Create `test/logic/102-schema-catalog-edge-cases.sqllogic` — multi-schema, DDL roundtrip, events
- Create `test/logic/103-database-options-edge-cases.sqllogic` — pragma edge cases
- Extend `test/vtab/memory-vtable.spec.ts` with layer management and concurrent mutation tests
- Add schema manager unit tests for search path resolution edge cases
- Add transaction isolation property test to `test/property.spec.ts`
- Re-run coverage and verify branch improvements
