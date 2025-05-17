# Project Titan 

Mission: Migrate SQLite's compiler and runtime from fragile messes to a robust, transparent, and extensible system

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

1.  **Immutable `PlanNode`s**: These objects represent the logical structure of the query. They are constructed from the Abstract Syntax Tree (AST) and contain all necessary information for their part of the query, but do not directly generate executable code or hold mutable emission state. They form a tree that serves as the input for the runtime generation process.
2.  **`Instruction`-based Runtime**: The query execution is driven by a graph of `Instruction` objects, which are generated from the `PlanNode` tree. These instructions are managed and executed by a `Scheduler`.

This separation allows for a modular system where the logical representation of a query is distinct from its physical execution details.

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
*   **Resource Management (Implicit)**:
    *   Unlike a VDBE context that explicitly manages memory cells and cursors, resource management in the new runtime is more implicit, handled by JavaScript's garbage collection and the lifecycle of objects within the `Instruction` execution (e.g., virtual table cursors managed within their respective `Instruction`s). If a VDBE-like backend were to be targeted in the future, an `EmissionContext` for that specific backend might be reintroduced.

### 2. Logical Plan Nodes (Immutable Hierarchical Context)

To further separate concerns and pave the way for a more advanced query planner (Phase II), we will introduce a hierarchy of immutable `PlanNode`s. These nodes will represent the *logical* structure of the query, distinct from the *physical* emission details managed by the `EmissionContext`.

**Core Principles:**

*   **Immutability**: Once created from the AST (or other PlanNodes), a PlanNode does not change. This simplifies reasoning and debugging.
*   **Logical Representation**: Each node encapsulates the information necessary for a specific logical operation in the query (e.g., filtering, projection, join). It does *not* directly generate VDBE code or manage emission state.
*   **Hierarchical Structure**: PlanNodes will form a tree that mirrors the query's execution flow. This tree will eventually be the input to the VDBE code generator.
*   **Decoupled Emission**: PlanNodes can have helper methods for code generation, but these methods will *take an `EmissionContext` as an argument* to perform the actual emission. They do not hold or modify the `EmissionContext` internally.

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
        *   `SubqueryNode`: Represents a scalar subquery, IN subquery, or EXISTS subquery. Contains the PlanNode for the subquery itself.
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
    *   Planner (`buildBatch`, `buildSelectStmt`, etc.) constructs `PlanNode` trees.
    *   These `PlanNode` trees are then passed to a system that uses `emitPlanNode` to convert them into a graph of `Instruction`s.
    *   The `Scheduler` executes these `Instruction`s.
5.  **Develop PlanNode Construction Logic**:
    *   Develop planner functions (e.g., in `src/planner/building/`) that take an AST and output `PlanNode`s, using the `Scope` objects for symbol resolution.
6.  **Iteratively Expand PlanNode and Emitter Coverage**:
    *   Incrementally add more `PlanNode` types to support a wider range of SQL features.
    *   For each new `PlanNode`, implement the corresponding emitter function to generate the runtime `Instruction`(s).
    *   If, in the future, a different execution backend (like VDBE) is desired, a separate set of "emitters" could be developed to translate `PlanNode`s into that target format (e.g., VDBE instructions, using a dedicated `EmissionContext` for that backend).
