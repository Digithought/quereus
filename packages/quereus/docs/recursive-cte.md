## Recursive CTE Execution Pattern

Quereus implements a sophisticated streaming execution model for recursive Common Table Expressions (CTEs) that provides both efficiency and SQL correctness.

### Key Design Principles

**Streaming Execution**: Results are yielded immediately rather than fully materialized before output, enabling processing of large recursive datasets without excessive memory usage.

**SQL-Correct Deduplication**: For `UNION` (distinct) recursive CTEs, duplicate detection uses `BTree` with `compareSqlValues` rather than `JSON.stringify`, ensuring proper SQL semantics including type coercion and collation rules.

**Configurable Iteration Limits**: Maximum iteration count is configurable through optimizer tuning, with support for unlimited recursion (setting `maxIterations = 0`).

**Working Table Management**: Each iteration uses a separate working table that feeds into the next iteration, with proper context setup for column reference resolution.

### Execution Flow

1. **Base Case Execution**: Execute the non-recursive part of the CTE, streaming results immediately while building the initial working table.

2. **Iterative Processing**: For each iteration:
   - Create a `WorkingTableIterable` from the current working table
   - Execute the recursive query with CTE self-references substituted by the working table
   - Stream new results immediately, checking for duplicates if using `UNION DISTINCT`
   - Build the next iteration's working table from new results

3. **Termination**: Continue until no new rows are produced or the iteration limit is reached.

### Implementation Pattern

```typescript
// SQL-correct deduplication using BTree
const seenRowsTree = plan.isUnionAll ? null : new BTree<Row, Row>(
  (row: Row) => row,
  compareRows // Uses compareSqlValues for proper SQL semantics
);

// Streaming with immediate yielding
for await (const row of baseCaseResult) {
  if (!plan.isUnionAll && seenRowsTree) {
    const insertPath = seenRowsTree.insert(row);
    if (!insertPath.on) continue; // Skip duplicate
  }
  
  // Yield immediately (streaming)
  rctx.context.set(rowDescriptor, () => row);
  try {
    yield row;
  } finally {
    rctx.context.delete(rowDescriptor);
  }
  
  // Add to working table for next iteration
  workingTable.push([...row] as Row);
}
```

### Configuration

Recursive CTE behavior is controlled through optimizer tuning:

```typescript
interface OptimizerTuning {
  recursiveCte: {
    maxIterations: number;     // 0 = unlimited
    defaultCacheThreshold: number;
  };
}
```

### CTE Self-Reference Substitution

During recursive execution, the emitter performs working table substitution by:

1. **Detecting CTE References**: Instructions with notes matching `cte_ref(cteName)` patterns
2. **Substitution**: Replacing CTE references with the current `WorkingTableIterable`
3. **Parameter Propagation**: Recursively processing instruction parameters to handle nested substitutions

This ensures that the recursive query sees the current working table when it references the CTE name, enabling proper recursive computation.
