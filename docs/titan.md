# Project Titan 

Mission: Migrate SQLite's compiler and runtime from fragile messes to a robust, transparent, and extensible system

## Phases

* Phase I: Robustify existing architecture
  * Compartmentalize and encapsulate compiler state
  * Add debug log-points to runtime
  * Introduce planner - reasons in logical planning nodes - IR between AST and runtime
  * Initial logical nodes built from AST - optimizer can move them around later
  * Allow reasoning in Relational Algebra; e.g HAVING becomes mere restriction
* Phase II: Optimization and serialization
  * Serialization of plans allows for visualization and debugging
  * Compiler generates runtime code from logical plan
  * Query planner adopts current planner to push down predicates, join order, etc.
* Phase III: Node-based runtime
  * Runtime is composed of execution nodes, rather than instructions
  * Composes more like a functional program
  * In debugging mode, intermediate nodes are placed between runtime nodes to capture state and/or log
  * Cursor and scalar, async and sync nodes; compiler will transition between them

## Phase I: Robustify Compiler Architecture

### Compartmentalize and Encapsulate Compiler State

The current `Compiler` class mixes logical query representation, planning information, and VDBE emission state. This makes it difficult to manage, debug, and extend. We will introduce a clear separation between these concerns by:

1.  **Defining an `EmissionContext`**: This class/object will be responsible for managing the mutable state related to VDBE code generation.
2.  **Introducing a Hierarchy of Immutable `PlanNode`s**: These objects will represent the logical structure of the query and its components. They are constructed from the AST and contain all necessary information for their part of the query, but do not directly generate code or hold mutable emission state.

This approach allows for incremental refactoring. Existing compiler functions will first be responsible for building the relevant `PlanNode` and then invoking a method on that node (or a dedicated compiler function) that takes the `EmissionContext` to generate VDBE instructions.

#### 1. EmissionContext (Physical Context)

This mutable object will be passed to emission functions and will be responsible for:

*   **VDBE Instructions**: Managing the list of `VdbeInstruction`s.
    *   `instructions: VdbeInstruction[]`
    *   `emit(opcode: Opcode, ...)`: Method to add an instruction.
*   **Constants Pool**:
    *   `constants: SqlValue[]`
    *   `addConstant(value: SqlValue): number`: Method to add a constant and get its index.
*   **Resource Allocation**: Tracking VDBE resources.
    *   `numMemCells: number`, `numCursors: number`
    *   `allocateMemoryCells(count: number): number`: Allocates stack slots.
    *   `allocateCursor(): number`: Allocates a new cursor.
*   **Jump/Address Management**: Handling placeholders and resolving jump targets.
    *   `pendingPlaceholders`, `nextPlaceholderId`, `resolvedAddresses`
    *   `allocateAddress(purpose: string): number`: Gets a placeholder for a future address.
    *   `resolveAddress(placeholder: number, targetAddress?: number): void`: Sets the target for a placeholder (current address if targetAddress is omitted).
    *   `getCurrentAddress(): number`
*   **Subroutine Management**:
    *   `subroutineCode: VdbeInstruction[]`
    *   `beginSubroutine(...)`, `endSubroutine()`
*   **VDBE Stack Frame Management**:
    *   `stackPointer: number`, `framePointer: number`
    *   `currentFrameEnterInsn`, `maxLocalOffsetInCurrentFrame`, `subroutineFrameStack`

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
    *   Index to use (if determined by an early planning stage or based on `xBestIndex` results).
    *   Reference to the virtual table instance or module.
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

The introduction of PlanNodes and the refinement of the `EmissionContext` will be an incremental process:

1.  **Define Core PlanNode Interfaces/Classes**: Start with a few fundamental PlanNode types (e.g., `TableScanNode`, `FilterNode`, `ProjectNode`, `ExpressionNode` and its basic subtypes).
2.  **Scope Object**: Define the `Scope` object and its methods for abstracting symbol resolution.
3.  **Develop Emission Logic & `EmissionContext` Refinement**:
    *   Solidify the `EmissionContext` interface and implementation as described earlier.
4.  **Integrate the new emission context**:
    *   Retrofit existing compiler functions to use the new `EmissionContext` for VDBE code generation.  This way, the old code will continue to work, but actually uses the new emmision logic underneath.  New code will use the new `EmissionContext` directly.
5.  **Develop PlanNode Emission Functions**:
    *   Develop planner functions or methods. These will take an AST and output `PlanNode`s.
6.  **Develop VDBE Emission Module**:
    *   This system registers a set of emitters that, given a `PlanNode` and an `EmissionContext` will generate the appropriate VDBE instructions.
    *   the PlanNode tree is then *visited*, applying the appropriate emitter to each node.
