# Virtual Table Module Authoring Guide

This guide provides documentation for implementing virtual table modules in Quereus. It covers the architecture, optimization integration, and best practices for module authors.

## Overview

Virtual table modules are the primary extension point for custom data sources in Quereus. A module implements the `VirtualTableModule` interface and provides instances of `VirtualTable` that handle data access, updates, and query optimization.

### Key Concepts

- **Module**: Factory that creates table instances; implements `xCreate()`, `xConnect()`, and optimization methods
- **Table Instance**: Represents a specific table; implements `xQuery()`, `xUpdate()`, and transaction support
- **Optimization Integration**: Modules communicate capabilities to the optimizer via `BestAccessPlan` API or `supports()` method
- **Retrieve Boundary**: The optimizer wraps all table references in `RetrieveNode`, marking where data transitions from module execution to Quereus execution

## Architecture: Retrieve-Based Push-down

### The Retrieve Node Boundary

Every table reference is automatically wrapped in a `RetrieveNode` at build time:

```
RetrieveNode (optimizer boundary)
  └─ pipeline: RelationalPlanNode (module-supported operations)
      └─ TableReferenceNode (leaf table reference)
```

**Key principle**: Operations inside the `RetrieveNode` pipeline are executed by the module; operations above are executed by Quereus.

### How Push-down Works

1. **Predicate Normalization**: The optimizer normalizes filter predicates and extracts constraints
2. **Supported-only Placement**: Only predicates the module can handle are pushed into the `Retrieve` pipeline
3. **Residual Predicates**: Unsupported predicates remain above the `Retrieve` boundary
4. **Binding Capture**: Parameters and correlated column references are captured in `Retrieve.bindings`

Example:
```sql
SELECT * FROM users WHERE id = 1 AND name LIKE 'A%' AND age > 30;
```

If the module supports equality on `id` but not LIKE or range comparisons:
```
Filter (name LIKE 'A%' AND age > 30)  ← Quereus executes
  └─ Retrieve
      └─ Filter (id = 1)              ← Module executes
          └─ TableReference
```

### Retrieve Node Structure

The `RetrieveNode` contains:
- **pipeline**: The operations the module will execute (initially just `TableReferenceNode`, but grows as predicates are pushed down)
- **bindings**: Parameters and correlated column references captured from pushed-down operations

At runtime:
1. Bindings are evaluated to produce concrete values
2. The module receives these values via `FilterInfo.args` (for index-based) or as part of the plan (for query-based)
3. The module executes the pipeline and returns rows
4. Quereus applies any residual operations above the `Retrieve` boundary

### Supported-only Placement Policy

The optimizer enforces a strict policy: **only operations the module can handle are placed inside the Retrieve boundary**. This is determined by:

1. **For query-based modules**: The `supports()` method returns a result
2. **For index-based modules**: The `getBestAccessPlan()` method marks filters as handled via `handledFilters` array

If a module claims to handle an operation but fails at runtime, data corruption can result. Always be conservative in capability reporting.

## Module Capability APIs

Modules communicate their capabilities through two complementary interfaces:

### 1. Query-Based Push-down (Advanced)

Implement `supports()` to analyze entire query pipelines:

```typescript
interface VirtualTableModule {
  supports?(node: PlanNode): SupportAssessment | undefined;
}

interface SupportAssessment {
  cost: number;           // Module's cost estimate
  ctx?: unknown;          // Opaque context for runtime
}
```

**When to use**: SQL federation, document databases, remote APIs that can execute complex queries.

**Important**: If `supports()` returns a result, the module **must** implement `xExecutePlan()` to execute the pipeline. The optimizer will call `xExecutePlan()` at runtime with the same plan node and context.

**Example**: A PostgreSQL federation module analyzing a Filter+Project+Sort pipeline:
```typescript
supports(node: PlanNode): SupportAssessment | undefined {
  if (node instanceof FilterNode) {
    // Check if predicate is SQL-compatible
    if (this.canTranslatePredicate(node.predicate)) {
      return { cost: 10, ctx: { sql: this.generateSQL(node) } };
    }
  }
  return undefined; // Can't handle this pipeline
}

// At runtime, xExecutePlan() receives the same node and ctx
async* xExecutePlan(db: Database, node: PlanNode, ctx?: unknown): AsyncIterable<Row> {
  const sql = (ctx as any)?.sql;
  // Execute the SQL against the remote database
  const results = await this.executeRemoteSQL(sql);
  for (const row of results) {
    yield row;
  }
}
```

### 2. Index-Based Access (Standard)

Implement `getBestAccessPlan()` to expose index capabilities:

```typescript
interface VirtualTableModule {
  getBestAccessPlan?(
    db: Database,
    tableInfo: TableSchema,
    request: BestAccessPlanRequest
  ): BestAccessPlanResult;
}

interface BestAccessPlanRequest {
  columns: readonly ColumnMeta[];
  filters: readonly PredicateConstraint[];
  requiredOrdering?: OrderingSpec;
  limit?: number | null;
  estimatedRows?: number;
}

interface BestAccessPlanResult {
  handledFilters: readonly boolean[];  // Which filters the module handles
  cost: number;                        // Cost estimate
  rows: number | undefined;            // Cardinality estimate
  providesOrdering?: readonly OrderingSpec[]; // If module provides ordering
  isSet?: boolean;                     // If result is guaranteed unique
  explains?: string;                   // Free-text explanation for debugging
  residualFilter?: (row: any) => boolean; // Optional JS filter for residual predicates
}
```

**When to use**: Most modules (in-memory tables, file-based storage, traditional indexes).

**Example**: Memory table with primary key index:
```typescript
getBestAccessPlan(
  db: Database,
  tableInfo: TableSchema,
  request: BestAccessPlanRequest
): BestAccessPlanResult {
  // Check for equality on primary key
  const pkConstraints = request.filters.filter(f =>
    f.op === '=' && f.columnIndex === 0 // PK is column 0
  );

  if (pkConstraints.length > 0) {
    return {
      handledFilters: request.filters.map(f => pkConstraints.includes(f)),
      cost: 1,                    // Very cheap
      rows: 1,                    // Unique lookup
      isSet: true,                // Guarantees unique rows
      explains: 'Primary key index seek'
    };
  }

  // Fall back to full scan
  return {
    handledFilters: request.filters.map(() => false),
    cost: this.data.length,
    rows: this.data.length,
    explains: 'Full table scan'
  };
}
```

## Runtime Execution Modes

### Query-Based Execution

If module implements `supports()`, implement `xExecutePlan()`:

```typescript
interface VirtualTable {
  xExecutePlan?(
    db: Database,
    plan: PlanNode,
    ctx?: unknown
  ): AsyncIterable<Row>;
}
```

The module receives the entire pipeline and executes it within its own context.

### Index-Based Execution

If module implements `getBestAccessPlan()`, implement `xQuery()`:

```typescript
interface VirtualTable {
  xQuery?(filterInfo: FilterInfo): AsyncIterable<Row>;
}

interface FilterInfo {
  args: SqlValue[];           // Constraint values
  argIndices: number[];       // Which constraints are provided
}
```

The module receives individual constraints and returns matching rows.

## Optimization Integration Points

### Physical Property Computation

Modules should communicate:
- **Cardinality**: Estimated row count
- **Ordering**: If module provides sorted output
- **Uniqueness**: If result is guaranteed unique

These properties enable the optimizer to make better decisions about join order, aggregation strategy, and materialization.

### Binding Capture

When predicates are pushed into the `Retrieve` pipeline, parameters and correlated column references are captured:

```typescript
// Query with parameter
SELECT * FROM users WHERE id = ?;

// Retrieve.bindings contains: [ParameterReference(1)]
// At runtime, the module receives the parameter value via FilterInfo.args
```

This enables efficient parameterized queries and correlated subqueries.

## Transaction Support

Modules can implement transaction methods for ACID compliance:

```typescript
interface VirtualTable {
  xBegin?(): Promise<void>;
  xCommit?(): Promise<void>;
  xRollback?(): Promise<void>;
  createSavepoint?(index: number): Promise<void>;
  rollbackToSavepoint?(index: number): Promise<void>;
  releaseSavepoint?(index: number): Promise<void>;
}
```

See [runtime.md](runtime.md) for transaction semantics.

## Best Practices

### 1. Accurate Cost Estimation

Provide realistic cost estimates in `BestAccessPlan`:
- **Sequential scan**: `O(n)` where n is row count
- **Index seek**: `O(log n)` for balanced indexes
- **Index scan**: `O(k + log n)` where k is result size

Inaccurate costs lead to suboptimal query plans.

### 2. Conservative Capability Reporting

Only report capabilities you can reliably implement:
- If `supports()` returns a result, the module must execute that pipeline correctly
- If `getBestAccessPlan()` marks a filter as handled, the module must apply it
- Incorrect reporting causes silent data corruption

### 3. Efficient Filtering

Push as much filtering as possible into the module:
- Reduces data transferred to Quereus
- Enables module-specific optimizations (indexes, partitioning)
- Improves overall query performance

### 4. Proper Cardinality Estimation

Accurate row count estimates enable:
- Better join order selection
- Appropriate aggregation strategy
- Correct materialization decisions

### 5. Preserve Attribute IDs

When implementing `xExecutePlan()`, preserve the attribute IDs from the input plan:
- Column references use stable attribute IDs
- Transformations must maintain these IDs
- See [runtime.md](runtime.md) for attribute system details

## Common Patterns

### Simple In-Memory Table

```typescript
class SimpleTable extends VirtualTable {
  constructor(private data: Row[]) { super(...); }

  getBestAccessPlan(req: BestAccessPlanRequest): BestAccessPlanResult {
    return {
      handledFilters: req.filters.map(() => false),
      cost: this.data.length,
      rows: this.data.length
    };
  }

  async* xQuery(): AsyncIterable<Row> {
    for (const row of this.data) yield row;
  }

  async xUpdate(op: string, values?: Row, oldKeys?: Row): Promise<Row | undefined> {
    if (op === 'insert' && values) this.data.push(values);
    return undefined;
  }

  async xDisconnect(): Promise<void> {}
}
```

### Indexed Table

```typescript
class IndexedTable extends VirtualTable {
  private index = new Map<SqlValue, Row[]>();

  getBestAccessPlan(req: BestAccessPlanRequest): BestAccessPlanResult {
    const eqFilters = req.filters.filter(f => f.op === '=' && f.columnIndex === 0);
    if (eqFilters.length > 0) {
      return {
        handledFilters: req.filters.map(f => eqFilters.includes(f)),
        cost: 1,
        rows: 1,
        isSet: true,
        explains: 'Index equality seek'
      };
    }
    return {
      handledFilters: req.filters.map(() => false),
      cost: 100,
      rows: 100,
      explains: 'Full table scan'
    };
  }

  async* xQuery(filterInfo: FilterInfo): AsyncIterable<Row> {
    if (filterInfo.argIndices.length > 0) {
      const key = filterInfo.args[0];
      yield* this.index.get(key) || [];
    } else {
      for (const rows of this.index.values()) {
        yield* rows;
      }
    }
  }

  async xUpdate(op: string, values?: Row, oldKeys?: Row): Promise<Row | undefined> {
    if (op === 'insert' && values) {
      const key = values[0];
      if (!this.index.has(key)) this.index.set(key, []);
      this.index.get(key)!.push(values);
    }
    return undefined;
  }

  async xDisconnect(): Promise<void> {}
}
```

## See Also

- [Optimizer Documentation](optimizer.md) - Detailed optimization architecture
- [Runtime Documentation](runtime.md) - Execution model and context system
- [Plugins Documentation](plugins.md) - Plugin packaging and discovery

