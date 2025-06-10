# Golden Plan Tests

This directory contains golden plan tests that capture expected query plan structures for regression testing.

## File Structure

Each test consists of three files:
- `{test-name}.sql` - The SQL query to test
- `{test-name}.logical.json` - Expected logical plan structure
- `{test-name}.physical.json` - Expected physical plan structure after optimization

## Test Runner

Run all golden plan tests:
```bash
yarn test:plans
```

Update golden files when plans change:
```bash
UPDATE_PLANS=true yarn test:plans
```

## Adding New Tests

1. Create a `.sql` file with your test query
2. Run with `UPDATE_PLANS=true` to generate initial golden files
3. Review the generated plans to ensure they're correct
4. Commit all three files

## Test Categories

Tests are organized by query pattern:
- `basic/` - Simple SELECT queries
- `joins/` - Various join types and patterns
- `aggregates/` - GROUP BY and aggregate functions
- `subqueries/` - Correlated and uncorrelated subqueries
- `window/` - Window function queries
- `cte/` - Common Table Expressions
- `complex/` - Multi-table, complex queries 
