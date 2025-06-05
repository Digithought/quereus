# Window Function Implementation in Quereus

This document describes the architecture and implementation of SQL window functions in Quereus's Titan runtime system.

## Overview

Window functions perform calculations across a set of table rows related to the current row without collapsing them into a single result (unlike aggregate functions in GROUP BY). Quereus provides comprehensive window function support with a modern, extensible architecture that follows the Titan principles of immutable PlanNodes and instruction-based runtime execution.

**Supported window functions:**
- **Ranking Functions**: `ROW_NUMBER()`, `RANK()`, `DENSE_RANK()`, `NTILE()`
- **Aggregate Functions**: `COUNT()`, `SUM()`, `AVG()`, `MIN()`, `MAX()` with OVER clause

## Architecture Components

### Parser Layer (`src/parser/parser.ts`)

The parser handles full SQL standard window function syntax:

```sql
window_function([arguments]) OVER (
  [PARTITION BY partition_expression [, ...]]
  [ORDER BY sort_expression [ASC | DESC] [NULLS FIRST | LAST] [, ...]]
  [frame_clause]
)
```

**Key Features:**
- Parses `PARTITION BY` and `ORDER BY` clauses
- Supports `NULLS FIRST/LAST` in ORDER BY
- Handles frame specifications: `ROWS BETWEEN ... AND ...`
- Creates `WindowFunctionExpr` AST nodes

### Planner Layer

**WindowNode (`src/planner/nodes/window-node.ts`):**
- Groups window functions with identical window specifications for efficiency
- Converts AST expressions to `ScalarPlanNode` objects for proper attribute resolution
- Maintains separate collections for partition expressions, ORDER BY expressions, and function arguments

**Query Building (`src/planner/building/select.ts`):**
- Identifies window functions in SELECT lists
- Groups functions by window specification to minimize processing
- Converts expressions to plan nodes for deterministic execution

### Runtime Layer (`src/runtime/emit/window.ts`)

Complete implementation following Titan architecture principles:

**Key Features:**
- **Attribute-based context resolution** - No hard-coded column mappings
- **Proper expression evaluation** - Uses callbacks for all expressions
- **Frame-aware execution** - Implements correct windowing semantics
- **SQL-compliant sorting** - Uses `compareSqlValues` for proper NULL handling

**Execution Model:**
1. **Materialization**: Collects all input rows (required for window functions)
2. **Partitioning**: Groups rows by PARTITION BY expressions
3. **Sorting**: Orders rows within partitions by ORDER BY expressions
4. **Frame Processing**: Calculates window frames and computes function values
5. **Output**: Returns original rows augmented with window function results

## Frame Specification Support

The implementation correctly handles all SQL standard frame types:

```sql
{ROWS | RANGE} {
    UNBOUNDED PRECEDING |
    CURRENT ROW |
    <value> PRECEDING |
    <value> FOLLOWING |
    BETWEEN <start_bound> AND <end_bound>
}
```

**Default Frame Behavior:**
- **No ORDER BY**: Frame includes entire partition
- **With ORDER BY**: Frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`

## Usage Examples

### Basic Window Functions

```sql
-- Row numbering
SELECT name, ROW_NUMBER() OVER (ORDER BY salary DESC) as rank
FROM employees;

-- Partitioned ranking
SELECT name, department,
       RANK() OVER (PARTITION BY department ORDER BY salary DESC) as dept_rank
FROM employees;
```

### Frame Specifications

```sql
-- Running totals
SELECT date, amount,
       SUM(amount) OVER (ORDER BY date ROWS UNBOUNDED PRECEDING) as running_total
FROM transactions;

-- Moving averages
SELECT date, value,
       AVG(value) OVER (ORDER BY date ROWS BETWEEN 2 PRECEDING AND 2 FOLLOWING) as moving_avg
FROM measurements;
```

### NULL Handling

```sql
-- Explicit NULL ordering
SELECT name, score,
       RANK() OVER (ORDER BY score DESC NULLS LAST) as rank
FROM test_results;
```

## Performance Optimizations

### Window Specification Grouping

The planner automatically groups window functions with identical specifications:
- **Single sort pass** per unique window specification
- **Shared partition processing** for multiple functions  
- **Reduced memory usage** through specification reuse

### Efficient Execution

- **Non-partitioned functions**: Use streaming execution with constant memory
- **Partitioned functions**: Buffer only current partition
- **Frame-bounded aggregates**: Process only necessary frame data

## Testing

Window functions are comprehensively tested through SQL Logic Tests (`test/logic/07.5-window.sqllogic`):

- Basic functionality (ROW_NUMBER, RANK, DENSE_RANK)
- Partitioning with multiple expressions
- Complex ORDER BY with ASC/DESC and NULLS FIRST/LAST
- Frame specifications (ROWS BETWEEN, UNBOUNDED PRECEDING/FOLLOWING)
- Aggregate functions with window frames
- NULL handling and edge cases
- Multiple window functions in single query

## Extensibility

New window functions can be added through the function registry system:

```typescript
registerWindowFunction('NEW_FUNC', {
    kind: 'ranking', // or 'aggregate'
    init: () => ({ /* initial state */ }),
    step: (state, value) => { /* update state */ },
    final: (state, rowCount) => { /* return result */ }
});
```

## Future Enhancements

**Navigation Functions (Planned):**
- `LAG(expr, offset, default)` - Access previous row values
- `LEAD(expr, offset, default)` - Access following row values
- `FIRST_VALUE(expr)` - First value in frame  
- `LAST_VALUE(expr)` - Last value in frame

**Advanced Features:**
- Named window specifications (WINDOW clause)
- Custom frame exclusion options
- Range frames with value-based bounds

The window function implementation provides a solid foundation for advanced SQL analytics while maintaining the architectural principles of the Titan runtime system. 
