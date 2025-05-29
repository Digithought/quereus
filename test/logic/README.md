# SQL Logic Tests

This directory contains SQL logic tests for the Quereus database engine. Tests are organized by feature area and numbered roughly by complexity/dependencies.

## Test Philosophy

**Tests represent the expected behavior when all features are fully implemented.** Tests that fail indicate features that need to be implemented or bugs that need to be fixed. This approach serves as a roadmap for development - failing tests show exactly what functionality is missing.

## Test Status (Current Titan Implementation)

### ✅ Currently Passing (01-06)
- `01-basic.sqllogic` - Basic table operations
- `02-smoke.sqllogic` - Core CRUD operations 
- `03-expressions.sqllogic` - Expression evaluation and operators
- `03.5-tvf.sqllogic` - Table-valued functions
- `04-transactions.sqllogic` - Transaction and savepoint support
- `05-vtab_memory.sqllogic` - Memory table virtual table functionality
- `06-builtin_functions.sqllogic` - Built-in scalar and aggregate functions

### ⚠️ Partially Working (07)
- `07-aggregates.sqllogic` - GROUP BY works, HAVING and DISTINCT aggregates not yet implemented

### 🚧 Features To Be Implemented (Tests Will Fail Until Implemented)
- `joins.sqllogic` - JOIN operations (INNER, LEFT, CROSS, multiple JOINs)
- `subqueries.sqllogic` - Scalar subqueries, EXISTS, IN, correlated subqueries
- `cte.sqllogic` - Common Table Expressions (WITH clause, recursive CTEs)
- `constraints.sqllogic` - Constraint enforcement (NOT NULL, CHECK, PRIMARY KEY violations)
- `join_padding_order.sqllogic` - LEFT JOIN NULL padding, window functions, index optimization
- `08-views.sqllogic` - VIEW functionality (CREATE VIEW, DROP VIEW, view updates)
- `09-set_operations.sqllogic` - UNION, INTERSECT, EXCEPT operations
- `10-distinct_datatypes.sqllogic` - DISTINCT operations and advanced type behavior
- `error_paths.sqllogic` - Comprehensive error handling for all features

## Test File Conventions

- Tests use `→ [expected_json_results]` for expected results
- Tests use `-- error: expected_error_message` for expected errors  
- All tests show the correct expected behavior when features are fully implemented
- Failing tests indicate missing functionality that needs to be developed

## Running Tests

```bash
yarn test
```

For diagnostics on test failures:
```bash
QUEREUS_TEST_SHOW_PLAN=true yarn test      # Show query plan
QUEREUS_TEST_SHOW_PROGRAM=true yarn test   # Show instruction program  
QUEREUS_TEST_SHOW_TRACE=true yarn test     # Show execution trace
```

## Development Workflow

1. **Run tests** to see current failures
2. **Pick a failing test** that represents a feature you want to implement
3. **Implement the feature** in the Titan architecture
4. **Re-run tests** to verify the feature works correctly
5. **Move to the next failing test**

This approach ensures comprehensive coverage and provides clear implementation goals.

## Feature Implementation Priority

Based on test organization and dependencies:

1. **Aggregation completeness** (HAVING, DISTINCT) - `07-aggregates.sqllogic`
2. **Basic JOINs** - `joins.sqllogic` 
3. **Subqueries** - `subqueries.sqllogic`
4. **DISTINCT operations** - `10-distinct_datatypes.sqllogic`
5. **Set operations** - `09-set_operations.sqllogic`
6. **Views** - `08-views.sqllogic`
7. **CTEs** - `cte.sqllogic`
8. **Constraint enforcement** - `constraints.sqllogic`
9. **Window functions** - `join_padding_order.sqllogic`
