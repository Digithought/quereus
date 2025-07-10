# SQL Logic Tests

This directory contains SQL logic tests for the Quereus database engine. Tests are organized by feature area and numbered roughly by complexity/dependencies.

## Test Philosophy

**Tests represent the expected behavior when all features are fully implemented.** Tests that fail indicate features that need to be implemented or bugs that need to be fixed. This approach serves as a roadmap for development - failing tests show exactly what functionality is missing.

## Test Status (Current Implementation)

### ✅ Currently Passing
- `01-basic.sqllogic` - Basic table operations
- `02-smoke.sqllogic` - Core CRUD operations 
- `03-expressions.sqllogic` - Expression evaluation and operators
- `03.5-tvf.sqllogic` - Table-valued functions
- `04-transactions.sqllogic` - Transaction and savepoint support
- `05-vtab_memory.sqllogic` - Memory table virtual table functionality
- `06-builtin_functions.sqllogic` - Built-in scalar and aggregate functions
- `07-aggregates.sqllogic` - Aggregate functions, group by, having
- `08-views.sqllogic` - VIEW functionality (CREATE VIEW, DROP VIEW, view updates)
- `10.5-indexes.sqllogic` - INDEX functionality (CREATE INDEX, UNIQUE indexes, IF NOT EXISTS)
- `11-joins.sqllogic` - JOIN operations (INNER, LEFT, CROSS, multiple JOINs)
- `12-empty-primary-key.sqllogic` - Empty PRIMARY KEY () support (Third Manifesto singleton tables)
- `44-orthogonality-minimal.sqllogic` - Relational orthogonality with mutating subqueries (INSERT/UPDATE/DELETE ... RETURNING as table sources)

### ⚠️ In progress
- (No tests currently in progress)

### 🚧 Features To Be Implemented (Tests Will Fail Until Implemented)
- `09-set_operations.sqllogic` - UNION, INTERSECT, EXCEPT operations
- `10-distinct_datatypes.sqllogic` - DISTINCT operations and advanced type behavior
- `40-constraints.sqllogic` - Constraint enforcement (NOT NULL, CHECK, PRIMARY KEY violations)
- `13-cte.sqllogic` - Common Table Expressions (WITH clause, recursive CTEs)
- `90-error_paths.sqllogic` - Comprehensive error handling for all features
- `12-join_padding_order.sqllogic` - LEFT JOIN NULL padding, window functions, index optimization
- `07.6-subqueries.sqllogic` - Scalar subqueries, EXISTS, IN, correlated subqueries

## Test File Conventions

- Tests use `→ [expected_json_results]` for expected results
- Tests use `-- error: expected_error_message` for expected errors  
- All tests show the correct expected behavior when features are fully implemented
- Failing tests indicate missing functionality that needs to be developed

## Running Tests

```bash
yarn test
```

For diagnostics on test failures, use command line arguments:
```bash
# Show concise query plan
yarn test --show-plan

# Show one-line execution path summary 
yarn test --plan-summary

# Show full detailed plan (JSON format)
yarn test --plan-full-detail

# Expand specific nodes in concise plan (get node IDs from initial plan output)
yarn test --show-plan --expand-nodes "node1,node2,node3"

# Limit plan depth
yarn test --show-plan --max-plan-depth 3

# Show instruction program
yarn test --show-program

# Show execution trace
yarn test --show-trace

# Enable plan stack tracing in runtime
yarn test --trace-plan-stack

# Show full stack traces
yarn test --show-stack

# Verbose execution progress
yarn test --verbose

# Combine multiple options
yarn test --show-plan --plan-summary --verbose --trace-plan-stack
```

**Environment Variables (Deprecated but still supported):**
```bash
set QUEREUS_TEST_SHOW_PLAN=true
yarn test      # Show query plan

set QUEREUS_TEST_SHOW_PROGRAM=true
yarn test   # Show instruction program  

set QUEREUS_TEST_SHOW_TRACE=true
yarn test     # Show execution trace

set QUEREUS_TEST_TRACE_PLAN_STACK=true
yarn test   # Enable plan stack tracing
```

You can also turn on log viewing by setting `DEBUG=quereus:...`

If you need to create and run test scripts, note that this is how tests are run:

```bash
cd ../.. && node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js 'packages/quereus/test/**/*.spec.ts' --colors --bail
```

## Development Workflow

1. **Run tests** to see current failures
2. **Implement or fix the feature** in the codebase
3. **Re-run tests** to verify the feature works correctly
4. **Move to the next failing test** - update this readme at milestones
