# Project Titan 

Mission: Migrate Quereus' compiler and runtime from fragile messes to a robust, transparent, and extensible system

## Phases

*   **Phase I: Core `PlanNode` to `Instruction` Architecture**
    *   Establish the foundational `PlanNode` hierarchy representing the logical query structure.
    *   Develop the `Instruction`-based runtime, including the `Instruction` interface, `Scheduler`, and `RuntimeContext`.
    *   Implement essential `PlanNode` types (e.g., for table scans, literal values, basic expressions) and their corresponding `Instruction` emitters.
    *   Integrate these components to successfully execute basic SQL queries, thereby validating the core architectural design.
    *   Set up an initial testing framework and a suite of basic tests.
*   **Phase II: SQL Feature Completion & Robustness**
    *   Systematically implement the full range of `PlanNode` types required to cover a comprehensive set of SQL features (e.g., various join types, aggregations, complex subqueries, DML, DDL operations).
    *   Develop and test `Instruction` emitters for all new `PlanNode` types.
    *   Implement robust plan serialization capabilities to aid in debugging, visualization, and potentially caching of query plans.
    *   Achieve comprehensive test coverage for all supported SQL features, including edge cases and error handling.
*   **Phase III: Optimization, Extensibility, and Advanced Features**
    *   Develop a sophisticated query optimization layer that operates on the `PlanNode` tree. This includes transformations like predicate pushdown, join reordering, selection of optimal access paths (e.g., index selection), and cost-based optimization.
    *   Explore and potentially implement alternative execution backends or targets (e.g., re-evaluating VDBE generation from `PlanNode`s if specific use cases demand it, or targeting WebAssembly).
    *   Enhance debugging capabilities within the runtime, possibly including detailed performance profiling and step-through execution of plans.
    *   Introduce support for advanced SQL features, user-defined functions/extensions, or other value-added capabilities.

## Core Architectural Components

The new query processing architecture is built upon two primary pillars, designed for clarity, extensibility, and robust execution:

1.  **Partly Immutable `PlanNode`s**: These objects represent the logical structure of the query. They are constructed from the Abstract Syntax Tree (AST) and contain all necessary information for their part of the query, but do not directly generate executable code or hold mutable emission state. They form a tree that serves as the input for the runtime generation process.  They should be immutable in relation to the logical aspects of the query, but mutable in relation to the physical aspects of the query.  In other words, they should be mutable in the ways needed to optimize the physical execution of the query, but are constrained in terms logical aspects to avoid breaking the logical structure during optimization.
2.  **`Instruction`-based Runtime**: The query execution is driven by a graph of `Instruction` objects, which are generated from the `PlanNode` tree. These instructions are managed and executed by a `Scheduler`.
3.  **Attribute-Based Context System**: A robust column reference resolution system using stable attribute IDs that provides deterministic context lookup without requiring node type checking.

This separation allows for a modular system where the logical representation of a query is distinct from its physical execution details, while maintaining reliable column reference resolution across plan transformations.

#### 1. Instruction-based Runtime (Execution Model)

Instead of directly emitting VDBE instructions, the planner now facilitates the creation of a tree of `Instruction` objects, which are then executed by a `Scheduler`.

*   **`Instruction` Interface**:
    *   Defines a simple structure, typically with:
        *   `params: Instruction[]`: An array of child/input `Instruction`s.
        *   `run(ctx: RuntimeContext, ...args: RuntimeValue[]): OutputValue`: A function that executes the logic of this instruction, taking a `RuntimeContext` and the results of its parameter instructions. It can be synchronous or asynchronous.
*   **Emitters (`emitters.ts`)**:
    *   A system for translating `PlanNode`s into `Instruction`s.
    *   `registerEmitter(planNodeType: PlanNodeType, emit: EmitterFunc)`: Used to map a `PlanNodeType` to a specific function that generates an `Instruction` for that node type.
    *   `emitPlanNode(plan: PlanNode): Instruction`: The core function that takes a `PlanNode` and returns its corresponding `Instruction` by looking up the registered emitter.
*   **`Scheduler` (`scheduler.ts`)**:
    *   Responsible for executing the graph of `Instruction`s.
    *   It takes one or more root `Instruction`s (typically the final output/result of the query).
    *   It builds an execution plan, determining the order of execution and managing dependencies between instructions.
    *   The `run(ctx: RuntimeContext)` method executes the plan, handling the flow of data (including promises for async operations) between instructions.
*   **`RuntimeContext` (`types.ts`)**:
    *   An object passed to each `Instruction`'s `run` method.
    *   Contains essential information needed during execution, such as:
        *   `db: Database`: Access to the database instance (for schema, virtual tables, etc.).
        *   `stmt: Statement`: The current statement being executed.
        *   `params: SqlParameters`: The bound parameters for the query.
        *   `context: Map<RowDescriptor, RowGetter>`: **New attribute-based context system** for deterministic column reference resolution.
*   **Resource Management (Implicit)**:
    *   Unlike a VDBE context that explicitly manages memory cells and cursors, resource management in the new runtime is more implicit, handled by JavaScript's garbage collection and the lifecycle of objects within the `Instruction` execution (e.g., virtual table cursors managed within their respective `Instruction`s). If a VDBE-like backend were to be targeted in the future, an `EmissionContext` for that specific backend might be reintroduced.

#### 2. Attribute-Based Context System (Column Reference Resolution)

Quereus implements a robust attribute-based context system that eliminates the architectural deficiencies of traditional node-based column reference resolution.

**Core Design Principles:**

*   **Stable Attribute IDs**: Every column is identified by a unique, stable attribute ID that persists across plan transformations and optimizations.
*   **Deterministic Resolution**: Column references use attribute IDs for lookup, eliminating the need for node type checking or fragile node-based resolution.
*   **Context Isolation**: Each row context is isolated using row descriptors that map attribute IDs to column indices.
*   **Transformation Safety**: Plan transformations (logical→physical) preserve attribute IDs, ensuring column references remain valid.

**Key Types:**

```typescript
// Maps attribute IDs to column indices in a row
type RowDescriptor = number[];  // attributeId → columnIndex

// Provides access to the current row
type RowGetter = () => Row;

// Updated RuntimeContext with attribute-based context
interface RuntimeContext {
  db: Database;
  stmt: Statement;
  params: SqlParameters;
  context: Map<RowDescriptor, RowGetter>;  // Attribute-based context mapping
}

// Attribute definition for each column
interface Attribute {
  id: number;           // Stable, unique identifier
  name: string;         // Column name
  type: ScalarType;     // Column type
  sourceRelation: string; // For debugging/tracing
}
```

**Implementation Requirements:**

*   **All relational plan nodes** must implement `getAttributes(): Attribute[]` to define their output schema.
*   **Emitters** must create row descriptors mapping attribute IDs to column indices.
*   **Column references** are resolved using `emitColumnReference` which uses deterministic attribute ID lookup.
*   **Optimizer** preserves attribute IDs when converting logical nodes to physical nodes.

**Column Reference Resolution Process:**

1. **Planning Phase**: Column references are created with specific attribute IDs from their source relation.
2. **Emission Phase**: Emitters create row descriptors mapping attribute IDs to column indices.
3. **Runtime Phase**: `emitColumnReference` iterates through context descriptors to find the correct column index.
4. **Execution**: Returns `row[columnIndex]` for the matching attribute ID.

**Benefits:**

*   **Eliminates node type checking** in column reference resolution
*   **Survives plan transformations** - attribute IDs remain stable across optimizations
*   **Deterministic behavior** - no ambiguity in column resolution
*   **Robust architecture** - works reliably with complex queries and nested contexts

#### 3. Bags vs Sets (Relational Semantics)

Quereus implements a precise distinction between **bags** (multisets) and **sets** following Third Manifesto principles, enabling sophisticated query optimizations and maintaining algebraic correctness.

**Core Design Principles:**

*   **Type-Level Distinction**: Every relational plan node explicitly declares whether it produces unique rows (`isSet: true`) or allows duplicates (`isSet: false`) via the `RelationType.isSet` property.
*   **Algebraic Correctness**: Operations preserve or transform bag/set properties in mathematically sound ways.
*   **Optimization Enablement**: The bag/set distinction guides query optimization decisions and enables more efficient execution strategies.

**Key Concepts:**

*   **Set**: A relation guaranteeing unique rows (all distinct according to primary key constraints)
    *   Examples: Base tables (enforced by PKs), `SELECT DISTINCT`, aggregation results, `SequencingNode` output
*   **Bag**: A relation allowing duplicate rows
    *   Examples: `SELECT * FROM table`, table function outputs, `VALUES` clauses with duplicates

**Set/Bag Classification:**

```typescript
// RelationType includes explicit bag/set information
interface RelationType {
  typeClass: 'relation';
  isSet: boolean;  // true = set (unique), false = bag (duplicates possible)
  // ... other properties
}
```

**Node Classification:**
*   **Always Sets**: `TableScanNode`, `AggregateNode`, `SingleRowNode`, `SequencingNode`
*   **Always Bags**: `TableFunctionCallNode` (can return duplicates)
*   **Preserve Source**: `ProjectNode`, `FilterNode`, `SortNode`, `WindowNode` preserve source bag/set semantics

**SequencingNode - Bag-to-Set Conversion:**

The `SequencingNode` provides explicit bag-to-set conversion by adding a unique row number column:

```typescript
export class SequencingNode extends PlanNode implements UnaryRelationalNode {
  // Adds '__row_seq' column to ensure uniqueness
  // Always produces isSet: true regardless of source
}
```

*   **Use Cases**: Operations requiring set semantics, deterministic ordering, stable row identity
*   **Runtime**: Adds incrementing row numbers to guarantee uniqueness
*   **Optimization**: Can be projected away after serving its purpose

**Benefits:**

*   **Clear Semantics**: Eliminates ambiguity about duplicate handling
*   **Optimization Opportunities**: Set-specific algorithms, duplicate elimination optimizations
*   **Type Safety**: Compile-time knowledge of bag/set properties
*   **Third Manifesto Compliance**: Explicit relational model with proper set/bag distinction

### 4. Logical Plan Nodes (Immutable Hierarchical Context)

To further separate concerns and pave the way for a more advanced query planner (Phase II), we will introduce a hierarchy of immutable `PlanNode`s. These nodes will represent the *logical* structure of the query, distinct from the *physical* emission details managed by the `EmissionContext`.

**Core Principles:**

*   **Immutability**: Once created from the AST (or other PlanNodes), a PlanNode does not change. This simplifies reasoning and debugging.
*   **Logical Representation**: Each node encapsulates the information necessary for a specific logical operation in the query (e.g., filtering, projection, join). It does *not* directly generate VDBE code or manage emission state.
*   **Hierarchical Structure**: PlanNodes will form a tree that mirrors the query's execution flow. This tree will eventually be the input to the VDBE code generator.
*   **Decoupled Emission**: PlanNodes can have helper methods for code generation, but these methods will *take an `EmissionContext` as an argument* to perform the actual emission. They do not hold or modify the `EmissionContext` internally.
*   **Attribute-Based Schema**: Each relational PlanNode implements `getAttributes()` to define its output schema with stable attribute IDs for reliable column reference resolution.

**Information Contained in PlanNodes:**

Thinking ahead to a tree-walk emission model, each PlanNode would need to encapsulate the data relevant to its logical operation. Examples include:

*   **`TableScanNode`**:
    *   Target table schema (name, columns, types, keys).
    *   Alias.
    *   Reference to the virtual table instance or module (handled by its emitter, e.g., `emitTableScan`).
*   **`TableSeekNode`**:
    *   Target table schema (name, columns, types, keys).
    *   Alias.
    *   Index to use (if determined by an early planning stage or based on `xBestIndex` results).
    *   Reference to the virtual table instance or module.
    *   Context/predicates: To support seek and range predicates that are pushed down (e.g., specific key ranges derived from WHERE clauses, or join conditions).  Node that all node predicates may be found to scoped context (parameters, outer cursors, CTEs, etc.)
*   **`FilterNode`**:
    *   Input PlanNode (source of rows).
    *   Filter predicate (an `ExpressionNode` or similar structure representing the condition).
*   **`ProjectNode`**:
    *   Input PlanNode.
    *   List of `ExpressionNode`s defining the output columns and their aliases.
*   **`JoinNode`**:
    *   Left input PlanNode.
    *   Right input PlanNode.
    *   Join type (INNER, LEFT, etc.).
    *   Join condition (an `ExpressionNode`).
*   **`SortNode`**:
    *   Input PlanNode.
    *   A list of sort key definitions, each specifying:
        *   Sort key expression (`ExpressionNode`).
        *   Direction (ASC/DESC).
        *   Collation name.
        *   Nulls ordering (FIRST/LAST).
*   **`AggregateNode`**:
    *   Input PlanNode.
    *   List of grouping expressions (`ExpressionNode`s).
    *   List of aggregate function calls, each specifying:
        *   Function name.
        *   Input `ExpressionNode`(s) for the aggregate.
        *   Distinct qualifier.
        *   Filter clause (`ExpressionNode`), if any (e.g., `COUNT(*) FILTER (WHERE ...)`).
    *   Note: Post-aggregation (HAVING) will be represented as a `FilterNode` containing the `AggregateNode`.
*   **`LimitOffsetNode`**:
    *   Input PlanNode.
    *   Limit count (`ExpressionNode` resolving to an integer or expression).
    *   Offset count (`ExpressionNode` resolving to an integer or expression).
*   **`ValuesNode`**:
    *   A list of rows, where each row is a list of `ExpressionNode`s.
    *   Column aliases for the resulting relation.
*   **`ExpressionNode` (Scalar Operations)**:
    *   This would be a base type for a hierarchy of expression nodes:
        *   `LiteralNode`: Represents a constant value (number, string, boolean, null, blob).
        *   `xxxReferenceNode`: Refers to a parameter, column, or other scope-bound symbol (e.g. outer cursor, CTE, etc.).
        *   `UnaryOpNode`: Operator (e.g., NOT, -, +), operand (`ExpressionNode`).
        *   `BinaryOpNode`: Operator (e.g., +, -, *, /, =, <, AND, OR), left operand (`ExpressionNode`), right operand (`ExpressionNode`).
        *   `FunctionCallNode`: Function name, list of argument `ExpressionNode`s, distinct qualifier.
        *   `CastNode`: Expression to cast (`ExpressionNode`), target type.
        *   `CollateNode`: Expression (`ExpressionNode`), collation name.
        *   `SubqueryNode`: Specific InNode, etc. represents a scalar subquery, IN subquery, or EXISTS subquery. Contains the PlanNode for the subquery itself.
        *   `CaseExprNode`: List of WHEN/THEN pairs (`ExpressionNode`s), optional ELSE `ExpressionNode`.

**Relational Algebra Influence:**

The design of these nodes will be heavily influenced by relational algebra concepts, providing a formal basis for query representation and transformation:

*   **Table-Oriented**: Most high-level PlanNodes (Scan, Filter, Project, Join, Aggregate, Sort, Limit, Set Operations) consume and produce relations (sets of tuples/rows). Note: A SQL `HAVING` clause can be represented as a `FilterNode` applied to the output of an `AggregateNode`.
*   **Attributes**: Each relation produced by a PlanNode has a well-defined schema (a list of attributes/columns with names, types, affinity, collation). This schema is derived from its input(s) and the operation performed.
*   **Node Arity**:
    *   **Zero-ary (Leaf) Table Nodes**: `TableScanNode` (for base tables), `ValuesNode`.
    *   **Unary Table Nodes**: `FilterNode`, `ProjectNode`, `SortNode`, `LimitOffsetNode`, `AggregateNode` (conceptually, operates on a single input relation).
    *   **Binary Table Nodes**: `JoinNode` (various types), `SetOperationNode` (UNION, INTERSECT, EXCEPT).
    *   **Scalar Nodes**: These represent expressions within the query and also follow arity:
        *   `Zero-aryScalarNode` (Leaf): `LiteralNode`, `ColumnReferenceNode`, `ParameterNode`.
        *   `UnaryScalarNode`: e.g., `NOT x`, `-y`, `CAST(z AS type)`.
        *   `BinaryScalarNode`: e.g., `a + b`, `c = d`.
        *   `NaryScalarNode`: e.g., `my_function(p1, p2, p3)`, `CASE WHEN c1 THEN r1 ... END`.
    *   **Table-Valued Functions (TVFs)**: Can be represented as a special type of n-ary PlanNode that consumes scalar expressions (arguments) and produces a relation.

**Unified Context and Scope (Symbol Resolution):**

Each PlanNode operates within a specific scope, defining what data (columns) and parameters are visible to it. The PlanNode hierarchy itself helps define this scope:

*   **Parent/Child Relationship**: PlanNodes form a tree. A node has primary inputs (the left and right arguments for binary nodes for instance) and scope context given by parent nodes, to which the node may bind through `xxxReferenceNode`s in its expression(s).
*   **Schema Propagation**: Each relational PlanNode will expose the output type of the relation it produces, including inferred columns, keys, and other metadata. Subsequent nodes consuming this output will use this for determining their types in turn.
*   **Symbol Resolution via Scope Object**: When an expression (e.g., in a filter predicate or projection list) refers to a symbol (column name, parameter, function), it will be resolved against an abstract "Scope" object. The Scope object encapsulates the logic for looking up symbols from their various origins (input relations from child PlanNodes, statement-level bound parameters, CTE definitions, outer query contexts for correlated subqueries), making the appropriate type of reference `xxxReferenceNode` for the specific origin of the symbol.
*   **Parameters**: For e.g., bound parameters from the SQL query are made available via the Scope object. An `ExpressionNode` subclass like `ParamExpressionNode` would reference them.
*   **Outer Cursors (Correlated Subqueries)**: For correlated subqueries, the subquery is just a PlanNode constructed with a Scope object that includes symbols from its outer query's context. The planner is responsible for identifying these correlations and ensuring the Scope object provides access to the necessary outer columns.
*   **Common Table Expressions (CTEs)**:
    *   A CTE definition would be compiled into its own PlanNode tree.  If it's materialized, it will be stored as an ephemeral table.  If it's view-like, it will be kept as-is.
    *   When a CTE is referenced, it is treated like any other view or table reference (inlined, scanned, seeked) depending on the context.

**Transition Strategy:**

The introduction of PlanNodes and the new `Instruction`-based runtime is an incremental process:

1.  **Define Core PlanNode Interfaces/Classes**: Start with a few fundamental PlanNode types (e.g., `TableScanNode`, `FilterNode`, `ProjectNode`, `ExpressionNode` and its basic subtypes).
2.  **Scope Object**: Define the `Scope` object and its methods for abstracting symbol resolution.
3.  **Develop `Instruction`-based Runtime & Emitters**:
    *   Solidify the `Instruction` interface, `Scheduler`, and `RuntimeContext`.
    *   Develop emitter functions (`emitters.ts`) that translate `PlanNode`s into `Instruction` objects.
4.  **Integrate the new runtime**:
    *   Planner (`buildBlock`, `buildSelectStmt`, etc.) constructs `PlanNode` trees.
    *   These `PlanNode` trees are then passed to a system that uses `emitPlanNode` to convert them into a graph of `Instruction`s.
    *   The `Scheduler` executes these `Instruction`s.
5.  **Develop PlanNode Construction Logic**:
    *   Develop planner functions (e.g., in `src/planner/building/`) that take an AST and output `PlanNode`s, using the `Scope` objects for symbol resolution.
6.  **Iteratively Expand PlanNode and Emitter Coverage**:
    *   Incrementally add more `PlanNode` types to support a wider range of SQL features.
    *   For each new `PlanNode`, implement the corresponding emitter function to generate the runtime `Instruction`(s).
    *   If, in the future, a different execution backend (like VDBE) is desired, a separate set of "emitters" could be developed to translate `PlanNode`s into that target format (e.g., VDBE instructions, using a dedicated `EmissionContext` for that backend).

## Current Implementation Status (as of analysis of `src/planner` and `src/runtime`)

Project Titan is actively under development, with significant portions of Phase I completed and Phase II initiated.

**Phase I: Core `PlanNode` to `Instruction` Architecture - Current Status: Largely Complete**

*   **`PlanNode` Hierarchy (`src/planner/nodes`):**
    *   **Foundation:** The base `PlanNode` class, `RelationalPlanNode`, `ScalarPlanNode`, and arity-based interfaces (e.g., `UnaryRelationalNode`, `BinaryScalarNode`) are established. `PlanNodeType` enum defines a wide range of planned operations.
    *   **Attribute-Based Schema:** - All relational nodes implement `getAttributes()` with stable attribute IDs for robust column reference resolution.
    *   **Implemented Core Nodes:**
        *   `BlockNode`: Represents a batch of statements.
        *   `TableReferenceNode`, `ColumnReferenceNode`, `ParameterReferenceNode`, `FunctionReferenceNode`: For resolving schema objects and parameters.
        *   `ScalarFunctionCallNode`: For user-defined scalar functions.
        *   `LiteralNode`: For constant values.
        *   `BinaryOpNode`: For binary expressions (currently, emitter supports basic numeric operations).
        *   `TableScanNode`: For full table scans.
        *   `SingleRowNode`: For `SELECT` statements without a `FROM` clause.
        *   `InNode`: For `IN` subquery conditions.
        *   `ProjectNode`: - Full implementation with attribute management and projection output scope handling.
        *   `FilterNode`, `SortNode`, `LimitOffsetNode`: - Properly preserve source attributes.
        *   `AggregateNode`, `StreamAggregateNode`: - Robust GROUP BY and aggregate function support with proper attribute handling.
        *   `WindowNode`: - Window function support with attribute management.
        *   `ValuesNode`, `TableFunctionCallNode`: - VALUES clauses and table-valued functions.
        *   `InsertNode`, `UpdateNode`, `DeleteNode`: - DML operations with proper attribute handling.
        *   `SequencingNode`: - Bag-to-set conversion by adding unique row numbers, enabling set semantics when required.
*   **`Instruction`-based Runtime (`src/runtime`):**
    *   **Core Components:** `Instruction` interface, `Scheduler` (for managing execution flow and promises), and `RuntimeContext` (providing DB access, parameters) are implemented.
    *   **Attribute-Based Context System:** - Robust column reference resolution using `Map<RowDescriptor, RowGetter>` eliminates node type checking and provides deterministic context lookup.
    *   **Emitters (`src/runtime/emitters.ts`, `src/runtime/emit/`):** The system for registering and dispatching emitters based on `PlanNode` type is in place.
    *   **Implemented Emitters:**
        *   `emitBlock` for `BlockNode`.
        *   `emitTableScan` for `TableScanNode` (interacts with VTab `xConnect` and `xQuery`).
        *   `emitLiteral` for `LiteralNode`.
        *   `emitBinaryOp` for `BinaryOpNode` (supports arithmetic, logical, comparison operations).
        *   `emitParameterReference` for `ParameterReferenceNode`.
        *   `emitColumnReference` for `ColumnReferenceNode` - - Uses deterministic attribute ID lookup.
        *   `emitProject` for `ProjectNode` - - Handles projections with proper context management.
        *   `emitFilter` for `FilterNode` - - WHERE clause support.
        *   `emitSort` for `SortNode` - - ORDER BY support with row descriptors.
        *   `emitStreamAggregate` for `StreamAggregateNode` - - GROUP BY and aggregates with output context.
        *   `emitLimitOffset` for `LimitOffsetNode` - - LIMIT/OFFSET support.
        *   `emitWindow` for `WindowNode` - - Window functions.
        *   `emitTableValuedFunctionCall` for `TableFunctionCallNode` - - Table-valued functions.
        *   `emitValues` for `ValuesNode` - - VALUES clauses.
        *   `emitSequencing` for `SequencingNode` - - Bag-to-set conversion with row numbering.
        *   `emitInsert`, `emitUpdate`, `emitDelete` for DML operations - **✅ COMPLETE**.
*   **Comprehensive SQL Query Execution:** - The current infrastructure can plan and execute complex SQL queries including:
    *   Complex projections with expressions
    *   WHERE clauses with complex predicates
    *   ORDER BY with pre-projection and post-projection sorting
    *   GROUP BY with aggregate functions and HAVING clauses
    *   Window functions
    *   Table-valued functions
    *   VALUES clauses
    *   DML operations (INSERT, UPDATE, DELETE)
    *   Explicit bags vs sets distinction with SequencingNode for set conversion
    *   All with robust column reference resolution
*   **Planning Logic (`src/planner/building`):**
    *   `buildBlock`: Can process a sequence of statements.
    *   `buildSelectStmt`: - Comprehensive SELECT support including:
        *   Single and multi-table FROM clauses
        *   Complex WHERE clauses (`FilterNode`)
        *   Full projection lists (`ProjectNode` with expressions)
        *   GROUP BY/HAVING (`AggregateNode` with proper scope management)
        *   ORDER BY (`SortNode` with pre/post-projection logic)
        *   LIMIT/OFFSET (`LimitOffsetNode`)
        *   Proper attribute ID handling and scope management
    *   `buildFrom`: - Handles tables, functions, and subqueries with consistent attribute ID usage.
*   **Scope and Symbol Resolution (`src/planner/scopes`, `src/planner/resolve.ts`):**
    *   - Comprehensive implementation with all scope types and proper column reference creation using source relation attributes.
*   **Optimizer (`src/planner/optimizer.ts`):**
    *   - Logical to physical transformation with **attribute ID preservation** ensuring column references remain valid across optimizations.

TODO:
- Introduce emission context, so that emitters can lookup schema at compile time rather than runtime.  Maybe we can version the schema catalog as well to invalidate plans.

**Phase II: SQL Feature Completion & Robustness - Current Status: Significantly Advanced**

*   **Core SQL Features:** - Most essential SQL features are now implemented with proper planning logic and runtime emitters.
*   **Attribute-Based Context System:** - Robust column reference resolution eliminates architectural deficiencies and provides reliable operation across complex queries.
*   **Query Planning:** - Comprehensive SELECT statement planning including projections, filtering, aggregation, sorting, and DML operations.
*   **Runtime Execution:** - Full instruction-based runtime with proper context management and deterministic column resolution.
*   **Plan Optimization:** **✅ CORE COMPLETE** - Logical to physical transformation with attribute ID preservation.
*   **Outstanding:** Join operations, some advanced subquery patterns, comprehensive error handling, and extensive testing coverage.

**Phase III: Optimization, Extensibility, and Advanced Features - Current Status: Foundation Ready**

*   The robust attribute-based architecture and comprehensive planning/runtime system provides a solid foundation for advanced optimizations.
*   Basic cost model and optimization framework are in place.
*   Advanced features like alternative execution backends, sophisticated optimizations, and extensibility enhancements are ready to be built upon the completed foundation.

## Outstanding Work / Next Steps

With the core attribute-based architecture complete, the following areas represent the remaining work:

**1. Join Operations (Primary remaining gap):**
*   **JOIN Planning:** Implement planning for various `JOIN` types (`INNER`, `LEFT`, etc.), creating `JoinNode`s.
*   **JOIN Emitters:** Create `emitJoin` for `JoinNode` with proper attribute handling for both sides of the join.
*   **Join Condition Planning:** Handle join conditions and updating scopes correctly across join boundaries.

**2. Advanced Subquery Support:**
*   **Correlated Subqueries:** Enhanced support for complex correlated subquery patterns.
*   **EXISTS/NOT EXISTS:** Full implementation of EXISTS subquery conditions.
*   **Scalar Subqueries:** Complete scalar subquery support in expressions.

**3. Missing Scalar Operations:**
*   Complete implementation for `ScalarPlanNode` subtypes: `UnaryOpNode`, `CastNode`, `CollateNode`, `CaseExprNode`.
*   Enhanced `emitBinaryOp` for any remaining edge case operations.

**4. Advanced SQL Features:**
*   **DISTINCT:** Implement support for `SELECT DISTINCT`.
*   **Set Operations:** UNION, INTERSECT, EXCEPT with proper attribute handling.
*   **Common Table Expressions (CTEs):** Recursive and non-recursive CTE support.

**5. Query Optimization Enhancements:**
*   **Index Selection:** Implement `TableSeekNode` for indexed access and enhance cost-based optimization.
*   **Join Optimization:** Join reordering and optimal join algorithm selection.
*   **Predicate Pushdown:** Advanced predicate pushdown optimizations.

**6. Schema and Constraint Enhancements:**
*   **DDL Operations:** Enhanced `CREATE TABLE`/`DROP TABLE`/`CREATE INDEX`/`DROP INDEX` within the Titan framework.
*   **Constraint Enforcement:** Integration of CHECK constraints and foreign key validation into the new runtime.

**7. Testing and Robustness:**
*   **Comprehensive Test Coverage:** Expand test coverage for the Titan architecture across all SQL features and edge cases.
*   **Error Handling:** Improve error reporting and handling throughout the query processing pipeline.
*   **Performance Testing:** Benchmark and optimize the attribute-based context system and instruction runtime.

**8. Advanced Features (Phase III):**
*   **Plan Serialization:** Implement mechanisms to serialize `PlanNode` trees for debugging and analysis.
*   **Query Visualization:** Develop tools to visualize query plans and execution flow.
*   **Alternative Backends:** Explore targeting different execution backends while maintaining the attribute-based architecture.

**9. Emission Context (Architectural Enhancement):**
*   Introduce emission context for compile-time schema lookups rather than runtime lookups.
*   Implement schema versioning to invalidate plans when schema changes.

The completion of the attribute-based context system represents a major architectural milestone, providing a robust foundation that eliminates previous fragilities and enables confident development of the remaining SQL features.
