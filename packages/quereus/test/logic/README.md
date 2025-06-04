# SQL Logic Tests

This directory contains SQL logic tests for the Quereus database engine. Tests are organized by feature area and numbered roughly by complexity/dependencies.

## Test Philosophy

**Tests represent the expected behavior when all features are fully implemented.** Tests that fail indicate features that need to be implemented or bugs that need to be fixed. This approach serves as a roadmap for development - failing tests show exactly what functionality is missing.

## Test Status (Current Titan Implementation)

### ✅ Currently Passing
- `01-basic.sqllogic` - Basic table operations
- `02-smoke.sqllogic` - Core CRUD operations 
- `03-expressions.sqllogic` - Expression evaluation and operators
- `03.5-tvf.sqllogic` - Table-valued functions
- `04-transactions.sqllogic` - Transaction and savepoint support
- `05-vtab_memory.sqllogic` - Memory table virtual table functionality
- `06-builtin_functions.sqllogic` - Built-in scalar and aggregate functions
- `07-aggregates.sqllogic` - Aggregate functions, group by, having

### ⚠️ In progress
- `08-views.sqllogic` - VIEW functionality (CREATE VIEW, DROP VIEW, view updates)

### 🚧 Features To Be Implemented (Tests Will Fail Until Implemented)
- `09-set_operations.sqllogic` - UNION, INTERSECT, EXCEPT operations
- `10-distinct_datatypes.sqllogic` - DISTINCT operations and advanced type behavior
- `constraints.sqllogic` - Constraint enforcement (NOT NULL, CHECK, PRIMARY KEY violations)
- `cte.sqllogic` - Common Table Expressions (WITH clause, recursive CTEs)
- `error_paths.sqllogic` - Comprehensive error handling for all features
- `join_padding_order.sqllogic` - LEFT JOIN NULL padding, window functions, index optimization
- `joins.sqllogic` - JOIN operations (INNER, LEFT, CROSS, multiple JOINs)
- `subqueries.sqllogic` - Scalar subqueries, EXISTS, IN, correlated subqueries

## Test File Conventions

- Tests use `→ [expected_json_results]` for expected results
- Tests use `-- error: expected_error_message` for expected errors  
- All tests show the correct expected behavior when features are fully implemented
- Failing tests indicate missing functionality that needs to be developed

## Running Tests

```bash
yarn test
```

For diagnostics on test failures run the SET env commands separately - for some reason, they won't be recognized when run together with &&:
```bash
set QUEREUS_TEST_SHOW_PLAN=true # First, set the env variable
yarn test      # Show query plan

set QUEREUS_TEST_SHOW_PROGRAM=true
yarn test   # Show instruction program  

set QUEREUS_TEST_SHOW_TRACE=true
yarn test     # Show execution trace
```

You can also turn on log viewing by setting `DEBUG=quereus:...`

If you need to create and run test scripts, note that this is how tests are run:

```bash
cd ../.. && node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js 'packages/quereus/test/**/*.spec.ts' --colors --bail
```

## Development Workflow

1. **Run tests** to see current failures
3. **Implement or fix the feature** in the Titan architecture
4. **Re-run tests** to verify the feature works correctly
5. **Move to the next failing test** - update this readme at milestones
