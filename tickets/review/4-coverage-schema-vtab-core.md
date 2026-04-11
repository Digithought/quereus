description: Tests for under-covered schema catalog, memory vtab transactions, and core API paths
files:
  packages/quereus/test/logic/101-transaction-edge-cases.sqllogic
  packages/quereus/test/logic/102-schema-catalog-edge-cases.sqllogic
  packages/quereus/test/logic/103-database-options-edge-cases.sqllogic
  packages/quereus/test/vtab/events.spec.ts
  packages/quereus/test/vtab/best-access-plan.spec.ts
  packages/quereus/test/util/plugin-helper.spec.ts
  packages/quereus/test/util/mutation-statement.spec.ts
  packages/quereus/test/core/database-options.spec.ts
  packages/quereus/test/schema/catalog.spec.ts
  packages/quereus/test/property.spec.ts
----

## What was built

Added comprehensive tests covering 325+ uncovered branches across schema, vtab/memory, core API, and utility layers.

### SQLLogic tests (transaction, schema, options edge cases)

**101-transaction-edge-cases.sqllogic** — exercises:
- Empty transactions (BEGIN+COMMIT, BEGIN+ROLLBACK with no mutations)
- Double BEGIN error handling
- Double COMMIT/ROLLBACK (no-op behavior)
- Commit after failed statement (txn still usable)
- Deeply nested savepoints (3+ levels) with mixed rollback/release
- Release inner savepoint then rollback outer (merged data correctly reverted)
- Same-name savepoints at different nesting levels (innermost wins)
- Mixed mutation types (INSERT/UPDATE/DELETE) across savepoint boundaries
- Large transactions (many inserts + rollback)
- Implicit transaction with savepoint

**102-schema-catalog-edge-cases.sqllogic** — exercises:
- DDL round-trip: create → verify table_info → drop → recreate → verify identical
- Composite primary key DDL
- Tables with indexes (create, query through index, drop)
- CHECK constraint enforcement
- Multi-schema with `declare schema` + `apply schema`
- Cross-schema JOIN queries
- Schema search path (`PRAGMA schema_path`) resolution
- table_info edge cases (many columns, single-column PK-only table)
- View create/drop/recreate lifecycle
- DROP TABLE IF EXISTS on non-existent and existing tables
- Schema assertions (integrity constraints preventing invalid data)
- Window functions (row_number, rank, dense_rank, running sum)

**103-database-options-edge-cases.sqllogic** — exercises:
- PRAGMA default_vtab_module read/set
- PRAGMA schema_path read/set/reset
- Invalid pragma names (error handling)
- Multiple pragmas in sequence
- table_info on various table shapes (simple, multi-type, non-existent)

### Unit tests

**events.spec.ts** — DefaultVTableEventEmitter:
- Data listener registration, invocation, unsubscription
- Multiple listeners, error resilience (listener throws → others still called)
- Event batching lifecycle (startBatch → emitDataChange → flushBatch)
- Batch discard, empty batch flush, flush without startBatch
- Schema change listeners (register, invoke, unsubscribe, error handling)
- removeAllListeners (clears both data/schema, resets batching state)

**best-access-plan.spec.ts** — AccessPlanBuilder + validateAccessPlan:
- Static factories (fullScan, eqMatch, rangeScan) with various parameters
- Builder fluent API chaining all setters
- Cost not set → throws; handledFilters defaults to empty
- Validation: handledFilters length mismatch, negative cost, negative rows
- Ordering/seek column index bounds validation (out-of-range, negative)

**plugin-helper.spec.ts** — registerPlugin:
- Sync and async plugin registration
- Config passing and default empty config
- vtable module registration (with proper destroy method)
- Undefined and empty registration arrays
- Error wrapping with context (bad module → error includes module name)
- Async rejection and sync throw propagation

**mutation-statement.spec.ts** — buildInsertStatement, buildUpdateStatement, buildDeleteStatement:
- INSERT with various value types (including null, boolean-like)
- INSERT with and without context rows
- UPDATE with single and composite primary keys
- DELETE with single and composite primary keys
- DELETE on table with no primary key (WHERE 1 tautology)
- Context value inclusion

**database-options.spec.ts** — DatabaseOptionsManager:
- Register boolean/string/number/object options with defaults
- Duplicate registration error
- Alias registration and resolution (including case-insensitivity)
- Duplicate alias error
- Set/get via canonical key and alias
- Unknown option error
- Same-value short-circuit (no onChange callback)
- Listener rollback on onChange error
- Boolean conversion: true/false, 'true'/'false', '1'/'0', 'on'/'off', 'yes'/'no', numbers
- Number conversion from string, invalid string
- Object conversion: direct, JSON string parse, array/null/invalid rejection
- Type safety: getBooleanOption/getStringOption/getObjectOption on wrong types
- getAllOptions, getOptionDefinitions
- onChange event correctness
- Object value equality via JSON.stringify

**catalog.spec.ts** — collectSchemaCatalog + generateDeclaredDDL + schema-hasher:
- Empty catalog for missing schema
- Table, index, view collection from live database
- Composite primary key DDL
- Table with no indexes
- Default schema parameter
- generateDeclaredDDL for tables, indexes, views with schema qualification
- Empty and mixed schema items
- Schema hash stability (identical schemas → identical hash)
- Hash differs for different schemas
- Tag stripping (table/index/view tags don't affect hash)
- Short hash (8 characters, prefix of full hash)
- Empty schema hashing

### Property-based tests (property.spec.ts)

- **Transaction isolation**: Random INSERT/UPDATE/DELETE mutations within BEGIN/ROLLBACK → verify all original data survives
- **Schema DDL through rollback**: Create table, INSERT in transaction, ROLLBACK → table exists but is empty

## Testing notes

- All 1692 quereus tests pass (including ~200 new tests)
- Build passes with no type errors
- Property tests use fast-check with 20-50 runs for reasonable CI speed
- SQLLogic tests are self-cleaning (DROP TABLE at end of each section)

## Key use cases for review validation

1. **Transaction savepoint edge cases**: Test deeply nested savepoints, rollback to inner then outer, same-name savepoints
2. **Event batching correctness**: Verify startBatch/flushBatch/discardBatch lifecycle
3. **Database options type conversion**: All boolean string forms, JSON object parsing
4. **Mutation statement generation**: Verify SQL output correctness for INSERT/UPDATE/DELETE with various PK configurations
5. **Schema hash stability**: Tags must not affect hash; identical schemas must produce identical hashes
