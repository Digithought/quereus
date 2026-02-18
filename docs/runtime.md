# Quereus Runtime

The Quereus runtime executes query plans through a three-phase process: **Planning** (AST → Plan Nodes), **Emission** (Plan Nodes → Instructions), and **Execution** (Instructions → Results).

## Value Types

### SqlValue
Core SQL data types that can be stored and manipulated:
```typescript
type SqlValue = string | number | bigint | boolean | Uint8Array | null;
```

### RuntimeValue  
Input types that instructions can receive as arguments:
```typescript
type RuntimeValue = SqlValue | Row | AsyncIterable<Row> | ((ctx: RuntimeContext) => OutputValue);
```

### OutputValue
Output types that instructions can produce:
```typescript
type OutputValue = MaybePromise<RuntimeValue>;
```

### TypeClasses
The runtime uses TypeScript's structural typing for type safety. Key classes and interfaces:
- `PlanNode`: Base class for all plan nodes
- `VoidNode`: Plan nodes that don't produce output (DDL, DML)
- `RelationalNode`: Plan nodes that produce rows (must implement `getAttributes()`)
- `ExpressionNode`: Plan nodes that produce scalar values

## Adding a New Plan Node

### 1. Create the Node Interface (`src/planner/nodes/`)

```typescript
// src/planner/nodes/my-operation-node.ts
import { RelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { Cached } from '../../util/cached.js';

export class MyOperationNode extends PlanNode implements UnaryRelationalNode {
	readonly nodeType = PlanNodeType.MyOperation;
	
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly operationParam: string
	) {
		super(scope, source.getTotalCost() + 10); // Add operation cost
		this.attributesCache = new Cached(() => this.buildAttributes());
	}
	
	private buildAttributes(): Attribute[] {
		// Define how this node creates/transforms attributes
		// Option 1: Preserve source attributes (like FilterNode, SortNode)
		return this.source.getAttributes();
		
		// Option 2: Create new attributes (like ProjectNode)
		// return this.projections.map((proj, index) => ({
		//   id: PlanNode.nextAttrId(),
		//   name: proj.alias ?? `col_${index}`,
		//   type: proj.node.getType(),
		//   sourceRelation: `${this.nodeType}:${this.id}`
		// }));
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}
	
	getType(): RelationType {
		// Define output relation type
		return this.source.getType(); // Or build custom type
	}
	
	// ... other required methods
}
```

### 2. Add to PlanNodeType Enum

```typescript
// src/planner/nodes/plan-node-type.ts
export enum PlanNodeType {
	// ... existing types
	MyOperation = 'MyOperation',
}
```

### 3. Create the Builder (`src/planner/building/`)

```typescript
// src/planner/building/my-operation.ts
import type { PlanningContext } from '../planning-context.js';
import * as AST from '../../parser/ast.js';
import { MyOperationNode } from '../nodes/my-operation-node.js';
import { buildSelectStmt } from './select.js';

export function buildMyOperationStmt(ctx: PlanningContext, stmt: AST.MyOperationStmt): MyOperationNode {
	// Build child nodes
	const sourceNode = buildSelectStmt(ctx, stmt.inputQuery);
	
	// Validate parameters
	if (!stmt.operationParam) {
		throw new QuereusError('Operation parameter required', StatusCode.ERROR);
	}

	return new MyOperationNode(ctx.scope, sourceNode, stmt.operationParam);
}
```

## Plan Node Output Format

All plan nodes follow standardized output conventions for consistent query plan display and debugging.

### Plan Node Data Structure

Each plan node provides three complementary sources of information:

```typescript
{
  id: string,                    // Unique node identifier
  nodeType: PlanNodeType,        // Node type enum (displayed by viewer)
  description: string,           // toString() output
  logical: Record<string, any>,  // getLogicalProperties() output
  physical?: PhysicalProperties  // Physical execution properties (when optimized)
}
```

### toString() Guidelines

**Purpose**: Provide concise, human-readable descriptions for quick plan comprehension.

**Rules**:
- Never include node type, ID, or parentheses
- Keep ≤ 80 characters when practical  
- Start with SQL keyword or principal action
- Show only essential information (predicates, projections, etc.)
- Don't duplicate information from logical/physical properties

**Examples**:
```typescript
// TableReferenceNode
toString(): "main.users"

// FilterNode
toString(): "where age > 40"

// ProjectNode
toString(): "select name, count(*) as total"

// SortNode
toString(): "order by name desc, age asc"

// AggregateNode
toString(): "group by dept_id  agg  count(*) as count, sum(salary) as total"
```

### getLogicalProperties() Guidelines

**Purpose**: Provide comprehensive logical information for detailed plan analysis.

**Rules**:
- Always return an object (never undefined)
- Use camelCased keys with semantic meaning
- Return primitive JSON types when possible (strings, numbers, arrays)
- Include logically important information not in description
- Don't duplicate physical properties (estimatedRows, ordering, etc.)

**Examples**:
```typescript
// FilterNode
getLogicalProperties(): {
  predicate: "age > 40"
}

// AggregateNode  
getLogicalProperties(): {
  groupBy: ["dept_id"],
  aggregates: [
    { expression: "COUNT(*)", alias: "count" },
    { expression: "SUM(salary)", alias: "total" }
  ]
}
```

### Formatting Utilities

Use consistent formatting helpers from `src/util/plan-formatter.ts`:

```typescript
import { 
  formatExpression,      // ScalarPlanNode → string
  formatExpressionList,  // ScalarPlanNode[] → "expr1, expr2, ..."  
  formatProjection,      // Expression + alias → "expr AS alias"
  formatSortKey,         // Expression + direction + nulls → "expr DESC NULLS LAST"
  formatScalarType       // ScalarType → "INTEGER" | "TEXT" | etc.
} from '../../util/plan-formatter.js';
```

### Implementation Template

```typescript
export class MyOperationNode extends PlanNode {
  // ... constructor and other methods

  override toString(): string {
    // Concise description focusing on key operation details
    return `MY_OP ${this.operationParam}`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    return {
      operation: this.operationParam,
      targetColumns: this.columns.map(col => col.name),
      // Include other logical details...
    };
  }
}
```

This standardized format ensures plan viewers receive consistent, comprehensive information for both quick scanning (description) and deep analysis (logical + physical properties).

## Creating an Emitter

### 1. Create the Emitter (`src/runtime/emit/`)

```typescript
// src/runtime/emit/my-operation.ts
import type { MyOperationNode } from '../../planner/nodes/my-operation-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { RowDescriptor } from '../../planner/nodes/plan-node.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';
import { withRowContextGenerator, createRowSlot } from '../context-helpers.js';

export function emitMyOperation(plan: MyOperationNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	// Create row descriptor for source attributes
	const sourceRowDescriptor: RowDescriptor = [];
	const sourceAttributes = plan.source.getAttributes();
	sourceAttributes.forEach((attr, index) => {
		sourceRowDescriptor[attr.id] = index;
	});

	// Create output row descriptor (if this node transforms attributes)
	const outputRowDescriptor: RowDescriptor = [];
	const outputAttributes = plan.getAttributes();
	outputAttributes.forEach((attr, index) => {
		outputRowDescriptor[attr.id] = index;
	});

	// Common run function patterns:

	// Pattern 1: Simple streaming with context helper
	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>): AsyncIterable<Row> {
		yield* withRowContextGenerator(rctx, sourceRowDescriptor, inputRows, async function* (row) {
			// Process each row - column references automatically resolve
			const processedRow = processRow(row, plan.operationParam);
			yield processedRow;
		});
	}

	// Pattern 2: High-volume streaming with row slot (for scan-like operations)
	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>): AsyncIterable<Row> {
		const rowSlot = createRowSlot(rctx, sourceRowDescriptor);
		try {
			for await (const row of inputRows) {
				rowSlot.set(row);
				const processedRow = processRow(row, plan.operationParam);
				yield processedRow;
			}
		} finally {
			rowSlot.close();
		}
	}

	// For scalar operations:
	// function run(rctx: RuntimeContext, inputValue: SqlValue): SqlValue {
	//     return processValue(inputValue, plan.operationParam);
	// }

	// For void operations (DDL/DML):
	// async function run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>): Promise<void> {
	//     await processRowsWithContext(rctx, sourceRowDescriptor, inputRows, async (row) => {
	//         await performSideEffect(row);
	//     });
	//     return undefined;
	// }

	// Emit child instructions
	const sourceInstruction = emitPlanNode(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run,
		note: `myOperation(${plan.operationParam})`
	};
}
```

### 2. Register the Emitter

```typescript
// src/runtime/register.ts
import { emitMyOperation } from './emit/my-operation.js';

export function registerEmitters() {
	// ... existing registrations
	registerEmitter(PlanNodeType.MyOperation, emitMyOperation as EmitterFunc);
}
```

## Key Emitter Patterns

### Row Context Management
Use context helpers to manage row contexts safely and efficiently:

**Pattern 1: High-volume streaming (createRowSlot) — preferred for all streaming emitters**
```typescript
import { createRowSlot } from '../context-helpers.js';

// Used by scan, join, filter, project, and distinct emitters.
// Installs the context entry once; updates by cheap field write per row.
const rowSlot = createRowSlot(rctx, rowDescriptor);
try {
	for await (const row of sourceRows) {
		rowSlot.set(row);  // Cheap update - no Map mutation
		yield processRow(row);
	}
} finally {
	rowSlot.close();
}
```

**Pattern 2: One-off / low-frequency context (withRowContext / withAsyncRowContext)**
```typescript
import { withRowContext, withAsyncRowContext } from '../context-helpers.js';

// Best for single-row evaluations such as constraint checks, DML context
// setup, or any place where Map.set+delete once is negligible.

// Synchronous evaluation
const result = withRowContext(rctx, rowDescriptor, () => row, () => {
	return evaluateExpression(rctx);
});

// Async evaluation
const result = await withAsyncRowContext(rctx, rowDescriptor, () => row, async () => {
	return await evaluateAsyncExpression(rctx);
});
```

**Pattern 3: Legacy per-row generator (withRowContextGenerator)**
```typescript
import { withRowContextGenerator } from '../context-helpers.js';

// Calls Map.set + Map.delete on every row.  Prefer createRowSlot for
// high-frequency streaming.  Still used in some lower-frequency emitters
// (CTE reference, recursive CTE, returning, window).
yield* withRowContextGenerator(rctx, rowDescriptor, sourceRows, async function* (row) {
	const result = await processRow(row);
	yield result;
});
```

### Column Reference Resolution
Column references are resolved automatically using attribute IDs.  The runtime now searches the context **from newest → oldest**, so the most recently-pushed scope wins:
```typescript
// In emitColumnReference (built-in):
function run(ctx: RuntimeContext): SqlValue {
	// Deterministic lookup: newest (innermost) scope wins
	return resolveAttribute(ctx, plan.attributeId, plan.expression.name);
}
```

## Scheduler Execution Model

The Scheduler executes instructions in dependency order:

1. **Flattening**: Converts instruction tree to linear array
2. **Dependency Resolution**: Ensures instructions execute after their dependencies
3. **Async Handling**: Uses `Promise.all()` for concurrent dependency resolution
4. **Memory Management**: Clears instruction arguments after execution

### Key Points for Emitter Authors

- **Row Descriptors**: Always create row descriptors mapping attribute IDs to column indices
- **Context Cleanup**: Use try/finally blocks to ensure context cleanup
- **Return Types**: Match your function signature to expected output type
- **Async Iterables**: Use `async function*` for row-producing operations
- **Error Handling**: Throw `QuereusError` with appropriate `StatusCode`
- **Attribute Preservation**: Understand whether your node preserves or creates new attributes

## Schema Resolution (Build-Time)

Quereus resolves all schema dependencies during the planning phase and tracks them for automatic plan invalidation:

### Early Resolution at Build Time

All schema objects are resolved during planning and stored directly in plan nodes:

```typescript
// TableReferenceNode stores pre-resolved objects
class TableReferenceNode {
  constructor(
    scope: Scope,
    public readonly tableSchema: TableSchema,
    public readonly vtabModule: VirtualTableModule,
    public readonly vtabAuxData?: unknown
  ) { ... }
}

// ScalarFunctionCallNode stores pre-resolved function
class ScalarFunctionCallNode {
  constructor(
    scope: Scope,
    public readonly expression: AST.FunctionExpr,
    public readonly functionSchema: FunctionSchema,
    public readonly operands: ScalarPlanNode[]
  ) { ... }
}
```

### Dependency Tracking and Auto-Invalidation

The planning context tracks all schema dependencies:

```typescript
// During planning
const functionSchema = resolveFunctionSchema(ctx, 'sum', 1);
const tableSchema = resolveTableSchema(ctx, 'users');
const vtabModule = resolveVtabModule(ctx, 'memory');

// Dependencies tracked automatically
ctx.schemaDependencies.recordDependency({
  type: 'function',
  objectName: 'sum/1'
}, functionSchema);
```

Prepared statements automatically invalidate when dependencies change:

```typescript
// Schema change triggers automatic plan invalidation
schemaManager.createTable(...); // Emits 'table_added' event
// → Statements using affected schema objects recompile automatically
```

## Attribute-Based Context System

Quereus implements a robust attribute-based context system that eliminates the architectural deficiencies of traditional node-based column reference resolution.

**Core Design Principles:**

- **Stable Attribute IDs**: Every column is identified by a unique, stable attribute ID that persists across plan transformations and optimizations.
- **Deterministic Resolution**: Column references use attribute IDs for lookup, eliminating the need for node type checking or fragile node-based resolution.
- **Context Isolation**: Each row context is isolated using row descriptors that map attribute IDs to column indices.
- **Transformation Safety**: Plan transformations (logical→physical) preserve attribute IDs, ensuring column references remain valid.

### Core Types

**RowDescriptor**: Maps attribute IDs to column indices in a row
```typescript
type RowDescriptor = number[];  // attributeId → columnIndex mapping
```

**RowGetter**: Function that provides access to the current row
```typescript
type RowGetter = () => Row;
```

**RuntimeContext**: Uses attribute-based context mapping
```typescript
interface RuntimeContext {
  db: Database;
  stmt: Statement;
  params: SqlParameters;
  context: Map<RowDescriptor, RowGetter>;  // Maps row descriptors to row getters
}
```

### Attribute System

Every relational plan node must implement `getAttributes(): Attribute[]` to define its output schema:

```typescript
interface Attribute {
  id: number;           // Stable, unique identifier
  name: string;         // Column name
  type: ScalarType;     // Column type
  sourceRelation: string; // For debugging/tracing
}
```

**Key principles:**
- Attribute IDs are **stable** across plan transformations
- Column references use attribute IDs for resolution, not node references
- Optimizer preserves attribute IDs when converting logical to physical nodes
- No node type checking required in `emitColumnReference`

## Context Debugging and Tracing

Quereus provides comprehensive debugging infrastructure for diagnosing context-related issues, which are common when developing new emitters or troubleshooting column reference resolution problems.

**`quereus:runtime:context`**: General context lifecycle operations
**`quereus:runtime:context:lookup`**: Column reference resolution attempts

```bash
# Enable all context tracing
set DEBUG=quereus:runtime:context* && yarn test
```

### Debugging Common Issues

**"No row context found" Errors:**
1. Enable `DEBUG=quereus:runtime:context:lookup` to see what contexts are available
2. Check if the expected attribute ID is present in any context
3. Verify context push/pop timing with `DEBUG=quereus:runtime:context`

**Context Lifecycle Issues:**
1. Enable `DEBUG=quereus:runtime:context` to trace context management
2. Look for mismatched PUSH/POP operations
3. Verify contexts are available when column references are evaluated

**Best Practices for Emitter Authors:**
- Always use the logging helpers: `logContextPush()` and `logContextPop()`
- Include meaningful notes that identify the operation context
- Log attribute information when setting up row descriptors
- Always use context helpers (`withRowContext`, `withAsyncRowContext`, `withRowContextGenerator`, `createRowSlot`)
- Never call `rctx.context.set/delete` directly
- Choose the appropriate helper based on your use case
- Include meaningful notes in your instruction's `note` field

## Bags vs Sets (Relational Semantics)

Quereus implements a precise distinction between **bags** (multisets) and **sets** in its relational model, aligning with Third Manifesto principles and enabling sophisticated query optimizations.

### Core Concepts

**Set**: A relation that guarantees unique rows (no duplicates)
- All rows are distinct according to the relation's primary key(s)
- Example: Result of `SELECT DISTINCT`, aggregation results, base tables

**Bag**: A relation that can contain duplicate rows
- Multiple identical rows are possible
- Example: Result of `SELECT * FROM table`, table function outputs

### RelationType.isSet Property

Every relational plan node specifies whether it produces a set or bag via the `isSet` property:

```typescript
interface RelationType {
  ...
  isSet: boolean;  // true = set (unique rows), false = bag (duplicates possible)
  ...
}
```

### Set/Bag Classification by Node Type

**Nodes that produce Sets (`isSet: true`):** - `TableScanNode`, `AggregateNode`/`StreamAggregateNode`, `SingleRowNode`, `SequencingNode`

**Nodes that may produce Bags (`isSet: false`):** - `TableFunctionCallNode` (depends on function declaration), `ProjectNode` (depending on whether key columns are preserved, and whether distinct), `FilterNode` (reflects input), `SortNode` (reflects input), `WindowNode`, `ValuesNode` (assumed to be bag, but we could check statically)

### SequencingNode: Bag-to-Set Conversion

`SequencingNode` is a special operation that converts any bag into a set by adding a unique row number column (`sequenceColumnName`)

**Runtime Behavior:**
```typescript
// Emitter adds row numbers to each row
async function* run(ctx: RuntimeContext, source: AsyncIterable<Row>): AsyncIterable<Row> {
  let rowNumber = 1;
  for await (const sourceRow of source) {
    yield [...sourceRow, rowNumber++] as Row;
  }
}
```

### Optimization Implications

The bag/set distinction enables important optimizations:

**Set-Specific Optimizations:**
- Duplicate elimination can be skipped for sets
- Certain join algorithms are more efficient with sets
- Set operations (UNION, INTERSECT) have different complexity

**Bag-Aware Planning:**
- Streaming operations can be more efficient on bags
- Memory usage optimizations for bag operations
- Different sorting strategies for bags vs sets

### Third Manifesto Alignment

This design aligns with Third Manifesto principles:
- **Clear Semantics**: Explicit distinction between sets and bags
- **Type Safety**: RelationType captures bag/set information at compile time
- **Algebraic Foundation**: Operations preserve or transform bag/set properties predictably
- **Optimization Enabling**: Type information guides query optimization decisions

## Mutation Operations: Always-Present OLD/NEW Model

Quereus implements a uniform OLD/NEW attribute model for all mutation operations (INSERT, UPDATE, DELETE) that eliminates conditional context management and provides consistent symbol resolution.

### Core Design

**Always-Present Attributes**: Every mutation operation has both OLD and NEW attributes for every table column, regardless of operation type:
- **INSERT**: OLD attributes are constant NULL, NEW attributes contain inserted values
- **UPDATE**: OLD attributes contain pre-update values, NEW attributes contain post-update values  
- **DELETE**: OLD attributes contain deleted values, NEW attributes are constant NULL

**Flat Row Composition**: At runtime, mutation contexts use a flat row format:
```
[oldCol0, oldCol1, ..., oldColN, newCol0, newCol1, ..., newColN]
```

### Planning Phase

During statement building, mutation operations generate:
- `oldRowDescriptor`: Maps OLD attribute IDs to indices 0..n-1 in flat row
- `newRowDescriptor`: Maps NEW attribute IDs to indices n..2n-1 in flat row
- Layered scope registration where unqualified column references default to the meaningful values:
  - INSERT/UPDATE: NEW attributes (since OLD may be NULL/irrelevant)
  - DELETE: OLD attributes (since NEW is always NULL)

### Runtime Execution

**Context Setup**: Single flat context eliminates attribute ID collisions:
```typescript
// Use withRowContext for constraint evaluation
const flatRow = composeOldNewRow(oldRow, newRow, columnCount);
await withAsyncRowContext(rctx, flatRowDescriptor, () => flatRow, async () => {
	await evaluateConstraints(rctx);
});
```

**Symbol Resolution**: Column references resolve deterministically:
- Unqualified `column` → NEW.column (INSERT/UPDATE) or OLD.column (DELETE)
- Qualified `OLD.column` → OLD section of flat row
- Qualified `NEW.column` → NEW section of flat row

**Constraint Evaluation**: All constraints (CHECK, NOT NULL) evaluate against the flat row context without conditional logic. CHECK constraints that reference other relations automatically defer to transaction boundaries via the `DeferredConstraintQueue`, so emitters simply enqueue the evaluator and continue streaming. Deferred rows reuse a single runtime context and row slot for efficiency while preserving scope isolation.

### Benefits

- **Eliminates Context Conflicts**: Single flat descriptor prevents attribute ID collisions
- **Simplifies Emitters**: No conditional OLD/NEW context setup across mutation types
- **Consistent Symbol Space**: OLD/NEW always available, always defined for all operations
- **Easier Reasoning**: Users can reliably reference OLD/NEW in any mutation context
- **Future-Proof**: Supports triggers, defaults, and other features that need OLD/NEW access

### Don't use Conditional Model

The previous model used conditional OLD/NEW descriptors with metadata properties:
```typescript
// OLD MODEL - conditional contexts
if (plan.oldRowDescriptor) {
  rctx.context.set(plan.oldRowDescriptor, () => updateData.oldRow);
}
// Plus hidden __updateRowData properties

// CURRENT MODEL - always-present flat context with helpers
const flatRow = composeOldNewRow(oldRow, newRow, columnCount);
yield* withRowContextGenerator(rctx, flatRowDescriptor, flatRows, async function* (flatRow) {
	// Process mutations with proper context
	yield flatRow;
});
```

This eliminates the break-fix cycle where attribute ID conflicts caused unpredictable column resolution behavior.

## Mutation Context

Quereus supports table-level mutation context variables that provide per-operation parameters for default values and constraints. This feature integrates seamlessly with the existing attribute-based context system.

### Overview

Mutation context allows you to:
- Define reusable parameters in table definitions
- Pass different values for each DML operation
- Use context in default value expressions
- Reference context in CHECK constraints (both immediate and deferred)
- Provide runtime-specific validation rules

### Architecture

**Planning Phase:**
- Context variables are parsed from `WITH CONTEXT (...)` clauses
- Variables converted to attributes with unique attribute IDs
- Context scope created using `RegisteredScope`
- Both unqualified (`varName`) and qualified (`context.varName`) symbols registered
- Context variables registered BEFORE OLD/NEW columns (giving them shadowing precedence)

**Runtime Phase:**
- Context values evaluated once per statement (not per row)
- Context stored in row descriptor using attribute ID mapping
- Context made available via `createRowSlot()` for the statement lifetime
- Context composed with OLD/NEW rows for constraint evaluation: `[context..., old..., new...]`

### Scope Resolution

Mutation context variables are registered in scopes using the same mechanism as table columns:

```typescript
// In constraint-builder.ts
contextAttributes.forEach((attr, contextVarIndex) => {
  const contextVar = tableSchema.mutationContext![contextVarIndex];
  const varNameLower = contextVar.name.toLowerCase();

  // Register both unqualified and qualified names
  constraintScope.subscribeFactory(varNameLower, (exp, s) =>
    new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
  );
  constraintScope.subscribeFactory(`context.${varNameLower}`, (exp, s) =>
    new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
  );
});
```

**Resolution Order:**
1. Context variables registered first (in constraint scopes)
2. OLD/NEW columns registered after
3. Unqualified references resolve to context if name matches
4. Qualified `context.varName` always resolves to context

### Runtime Integration

**Context Evaluation:**
```typescript
// In constraint-check emitter
// Evaluate context once per statement
const contextRow: Row = [];
for (const contextEvaluator of contextEvalFunctions) {
  const value = await contextEvaluator(rctx) as SqlValue;
  contextRow.push(value);
}

// Install context for statement duration
const contextSlot = createRowSlot(rctx, contextDescriptor);
contextSlot.set(contextRow);

try {
  // Process rows - context available to all child operations
  for await (const row of inputRows) {
    // Defaults and constraints can reference context variables
  }
} finally {
  contextSlot.close();
}
```

**Combined Row Composition:**
For constraint evaluation, context is composed with OLD/NEW rows:
```typescript
const combinedRow = [...contextRow, ...oldRow, ...newRow];
const combinedDescriptor = composeCombinedDescriptor(contextDescriptor, flatRowDescriptor);
```

**Descriptor Composition:**
```typescript
function composeCombinedDescriptor(
  contextDescriptor: RowDescriptor, 
  flatRowDescriptor: RowDescriptor
): RowDescriptor {
  const combined: RowDescriptor = [];
  const contextLength = Object.keys(contextDescriptor).length;

  // Context attributes: indices 0..contextLength-1
  for (const attrIdStr in contextDescriptor) {
    const attrId = parseInt(attrIdStr);
    combined[attrId] = contextDescriptor[attrId];
  }

  // OLD/NEW attributes: offset by contextLength
  for (const attrIdStr in flatRowDescriptor) {
    const attrId = parseInt(attrIdStr);
    combined[attrId] = flatRowDescriptor[attrId] + contextLength;
  }

  return combined;
}
```

### Deferred Constraints

Mutation context is captured and preserved for deferred constraints:

**Queueing:**
```typescript
rctx.db._queueDeferredConstraintRow(
  baseTable,
  constraintName,
  row.slice() as Row,
  flatRowDescriptor,
  evaluator,
  connectionId,
  contextRow,        // Captured context values
  contextDescriptor  // Context row descriptor
);
```

**Evaluation at COMMIT:**
```typescript
// Compose context with flat row for deferred evaluation
const evaluationRow = entry.contextRow 
  ? [...entry.contextRow, ...entry.row] 
  : entry.row;
const evaluationDescriptor = entry.contextRow && entry.contextDescriptor
  ? composeCombinedDescriptor(entry.contextDescriptor, entry.descriptor)
  : entry.descriptor;

// Evaluate with context available
const slot = createRowSlot(runtimeCtx, evaluationDescriptor);
slot.set(evaluationRow);
const value = await entry.evaluator(runtimeCtx);
```

### Plan Node Structure

**DML Nodes (InsertNode, UpdateNode, DeleteNode):**
- `mutationContextValues?: Map<string, ScalarPlanNode>` - Value expressions for each variable
- `contextAttributes?: Attribute[]` - Attribute metadata for context variables
- `contextDescriptor?: RowDescriptor` - Maps attribute IDs to row indices

**ConstraintCheckNode:**
- Receives mutation context from parent DML node
- Stores context for use during emission
- Passes context through optimizer transformations

### Integration with Existing Systems

**Attribute-Based Context:**
- Mutation context uses the same attribute ID system as OLD/NEW rows
- Context attributes have unique, stable IDs
- No special handling needed - integrates with existing `resolveAttribute()`

**Row Descriptors:**
- Context uses standard row descriptors
- Context row composed with OLD/NEW rows for constraint evaluation
- Single combined descriptor provides unified attribute lookup

**Transaction Support:**
- Context evaluated per statement
- Captured for deferred constraints
- Preserved across savepoints (part of queued row data)

### Implementation Guidelines for Emitter Authors

**When adding new mutation operations:**
1. Process `stmt.contextValues` in the builder
2. Create context attributes with unique IDs
3. Build context expression plan nodes
4. Create context scope and register variables (both forms)
5. Pass context scope when evaluating defaults
6. Pass context attributes to `buildConstraintChecks()`
7. Create context descriptor from attributes
8. Pass mutation context to plan node constructors
9. Pass mutation context to ConstraintCheckNode

**Key Points:**
- Context is evaluated once per statement (performance)
- Context persists for entire statement via row slot
- Context composed with OLD/NEW for constraints
- Deferred constraints capture and preserve context
- Use existing context helpers - no special APIs needed

## Determinism Validation

Quereus enforces that all expressions in CHECK constraints and DEFAULT values must be deterministic. This ensures that captured statements at the VTable update boundary are fully deterministic and replayable.

### Why Determinism Matters

Non-deterministic expressions (like `random()`, `datetime('now')`) produce different values on each execution. If these were allowed in constraints or defaults:
- Replaying captured statements would produce different results
- Constraint validation could be inconsistent
- Audit logs would not be reproducible

### Validation Rules

**Rejected in Constraints and Defaults:**
- `random()`, `randomblob()` - Random value generation
- `date('now')`, `time('now')`, `datetime('now')`, `julianday('now')` - Current time functions
- User-defined functions marked as non-deterministic
- Any expression containing non-deterministic sub-expressions

**Allowed in Constraints and Defaults:**
- Constant literals: `42`, `'hello'`, `true`
- Deterministic built-in functions: `upper()`, `lower()`, `abs()`, `round()`
- Column references: `NEW.price`, `OLD.quantity`
- Mutation context variables: `context.timestamp`, `context.user_id`
- User-defined functions marked as deterministic (default)

### Using Mutation Context for Non-Deterministic Values

Instead of using non-deterministic functions directly, pass values via mutation context:

```sql
-- ❌ REJECTED: Non-deterministic default
create table orders (
    id integer primary key,
    created_at text default datetime('now')  -- ERROR
);

-- ✅ ACCEPTED: Use mutation context
create table orders (
    id integer primary key,
    created_at text default timestamp
) with context (
    timestamp text
);

-- Pass the timestamp when inserting
insert into orders (id)
with context timestamp = datetime('now')
values (1);
```

### Physical Properties System

Determinism is tracked through the `PhysicalProperties` system:

```typescript
interface PhysicalProperties {
    deterministic: boolean;  // Same inputs → same outputs
    readonly: boolean;       // No side effects
    idempotent: boolean;     // Safe to call multiple times
    constant: boolean;       // Directly produces constant result
}
```

**Propagation Rules:**
- Function nodes check the `FunctionFlags.DETERMINISTIC` flag
- Non-deterministic functions mark `deterministic: false`
- Properties propagate bottom-up through the expression tree
- Parent nodes inherit the most restrictive properties from children

**User-Defined Functions:**
```typescript
// Non-deterministic UDF
db.createScalarFunction("my_random",
    { numArgs: 0, deterministic: false },
    () => Math.random()
);

// Deterministic UDF (default)
db.createScalarFunction("my_upper",
    { numArgs: 1, deterministic: true },  // or omit (defaults to true)
    (text) => String(text).toUpperCase()
);
```

### Validation Timing

**CREATE TABLE:**
- DEFAULT expressions validated if they don't reference table columns
- CHECK constraints NOT validated (columns don't exist yet in scope)

**INSERT/UPDATE:**
- DEFAULT expressions validated when building row expansion
- CHECK constraints validated when building constraint checks

**ALTER TABLE ADD CONSTRAINT:**
- Validation deferred to first INSERT/UPDATE (constraints may reference NEW/OLD)

## Common Patterns

### Row Processing with Context
```typescript
// Simple streaming pattern
async function* run(rctx: RuntimeContext, input: AsyncIterable<Row>): AsyncIterable<Row> {
	yield* withRowContextGenerator(rctx, rowDescriptor, input, async function* (row) {
		// Process row - column references resolve automatically
		const result = await processRow(row, rctx);
		yield result;
	});
}

// High-volume streaming pattern (scan, join)
async function* run(rctx: RuntimeContext, input: AsyncIterable<Row>): AsyncIterable<Row> {
	const rowSlot = createRowSlot(rctx, rowDescriptor);
	try {
		for await (const row of input) {
			rowSlot.set(row);
			yield processRow(row, rctx);
		}
	} finally {
		rowSlot.close();
	}
}
```

### Scalar Functions
```typescript
function run(rctx: RuntimeContext, ...args: SqlValue[]): SqlValue {
	// Compute result
	return result;
}
```

### Side Effects (DDL/DML)
```typescript
async function run(rctx: RuntimeContext, input: AsyncIterable<Row>): Promise<undefined> {
	// Process each row with proper context
	for await (const row of input) {
		await withAsyncRowContext(rctx, rowDescriptor, () => row, async () => {
			await performMutation(row, rctx);
		});
	}
	return undefined;
}
```

## Query Optimizer Integration

The Quereus optimizer transforms logical plan nodes into physical execution plans between the builder and runtime phases. This section covers the key aspects relevant to runtime emitter development.

### Optimizer Overview

The optimizer uses a single plan node hierarchy with logical-to-physical transformation:
- **Logical nodes**: Created by the builder - may or may not have physical emitters
- **Physical nodes**: Transformed by the optimizer with execution properties
- **Attribute preservation**: Column references use stable attribute IDs that survive optimization

Key optimizer guarantees for emitter authors:
- Every node reaching the emitter phase has `physical` properties set
- Attribute IDs remain stable across all transformations
- Column references can rely on deterministic attribute ID lookup
- The optimizer respects virtual table capabilities via `BestAccessPlan`

### Physical Properties

Physical properties capture execution characteristics used by both optimizer and runtime:
```typescript
interface PhysicalProperties {
  ordering?: Ordering[];        // Output row ordering
  estimatedRows?: number;       // Cardinality estimate
  uniqueKeys?: number[][];      // Attribute IDs forming unique keys
  deterministic: boolean;       // Pure and repeatable
  readonly: boolean;            // No side effects
}
```

These can be overridden through overriding the computePhysical() plan node method, otherwise these are inherited from child nodes or are defaults.
```typescript
computePhysical(): Partial<PhysicalProperties> {
  return {
    readonly: false,  // Side-effecting (should only be set if the node directly mutates)
    estimatedRows: this.source.estimatedRows,
    uniqueKeys: this.source.getType().keys.map(key => key.map(colRef => colRef.index)),
  };
}
```

### Attribute ID System

The runtime's column reference resolution relies on the optimizer's attribute ID preservation:
- Each column has a unique, stable attribute ID assigned during planning
- The optimizer's `withChildren()` infrastructure preserves these IDs
- Runtime column lookup uses attribute IDs, not names or positions
- This enables robust resolution across arbitrary plan transformations

For comprehensive optimizer details, see the [Optimizer Documentation](../optimizer.md).

## Incremental Delta Runtime (Design)

Quereus can reuse a single incremental runtime to power multiple features that react to base-table changes: transaction-deferred assertions, materialized views, and future trigger-like facilities. The core idea is to execute only the affected slice of a registered query at transaction boundaries using binding-aware residual plans.

### Goals
- Reuse the same delta infrastructure across assertions and views
- Execute parameterized residuals per affected key/group; fall back to global when required
- Respect savepoints; changes rolled back via SAVEPOINT should not be visible to COMMIT-time checks

### Building Blocks
- ChangeCapture (existing): per-transaction change log tracking primary-key tuples per base table; savepoint aware
- BindingInference: classifies a plan’s table references as row-specific, group-specific, or global (see optimizer doc) and identifies binding keys (PK/unique or group-by/partition keys)
- ParameterizedPlanCache: per-registrant (assertion/view) and per relationKey, store prepared residual plans with parameter slots aligned to key order
- DeltaExecutor: at COMMIT, select impacted registrants, decide global vs per-binding execution, early-exit on first violation (assertions) or produce delta rows (views)

### Execution Modes
- Assertions: run residuals and fail on first non-empty result (error → rollback)
- Materialized Views (future): compute ΔView and merge into cached table (insert/update/delete)

### Savepoints
- On SAVEPOINT: push a new change layer
- On ROLLBACK TO: discard the top layer
- On RELEASE: merge the top layer into the previous one

### Diagnostics
- `explain_assertion(name)` exposes classification and prepared parameter layout for assertions
- Future: `explain_view_delta(name)` for materialized views

This design keeps runtime responsibilities focused on execution and caching, while the optimizer provides binding inference and plan shaping. See the optimizer document for analysis details.

## Type Coercion Best Practices

SQL requires different coercion strategies for different contexts. Quereus provides centralized type coercion utilities in `src/util/coercion.ts` that should be used consistently across all emitters.

### Coercion Contexts

**Comparison Context** (`coerceForComparison`):
- Converts numeric strings to numbers when comparing with numeric values
- Example: `42 = '42'` → true
- Used in: binary comparison operators, JOIN conditions, WHERE clauses

**Arithmetic Context** (`coerceToNumberForArithmetic`): 
- Converts all values to numbers for arithmetic operations
- Non-numeric strings become 0 (SQL standard behavior)
- Example: `'abc' + 0` → 0, `'123' + 0` → 123
- Used in: +, -, *, /, % operators

**Aggregate Context** (`coerceForAggregate`):
- Function-specific coercion for aggregate arguments
- COUNT functions skip coercion, numeric aggregates (SUM/AVG) coerce strings
- Used in: aggregate function argument processing

### Implementation Guidelines

```typescript
import { coerceForComparison, coerceToNumberForArithmetic, coerceForAggregate } from '../../util/coercion.js';

// In comparison operations:
const [coercedV1, coercedV2] = coerceForComparison(v1, v2);
const result = compareSqlValues(coercedV1, coercedV2);

// In arithmetic operations:
const n1 = coerceToNumberForArithmetic(v1);
const n2 = coerceToNumberForArithmetic(v2);
const result = n1 + n2;

// In aggregate functions:
const coercedArg = coerceForAggregate(rawValue, functionName);
accumulator = schema.stepFunction(accumulator, coercedArg);
```

**Critical Rule**: Never implement custom coercion logic in individual emitters. Always use the centralized utilities to ensure consistent behavior across the system.

## Uniqueness and sorting guidelines

### Never Use JSON.stringify for DISTINCT

**Wrong**:
```typescript
const seen = new Set<string>();
const key = JSON.stringify(value);
if (seen.has(key)) continue; // Skip duplicate
seen.add(key);
```

**Problems**: 
- Doesn't follow SQL comparison rules
- `1` and `"1"` have different JSON representations but may be equal in SQL
- Doesn't respect collation rules

**Correct**:
```typescript
import { BTree } from 'inheritree';

const distinctTree = new BTree<SqlValue, SqlValue>(
  (val: SqlValue) => val,
  (a: SqlValue, b: SqlValue) => compareSqlValues(a, b)
);

// Check for duplicates:
const existingPath = distinctTree.insert(value);
if (!existingPath.on) {
  continue; // Skip duplicate
}
```

### Multi-Value 

For aggregates with multiple arguments:
```typescript
function compareDistinctValues(a: SqlValue | SqlValue[], b: SqlValue | SqlValue[]): number {
  if (Array.isArray(a) && Array.isArray(b)) {
    return compareGroupKeys(a, b); // Element-wise comparison
  }
  if (!Array.isArray(a) && !Array.isArray(b)) {
    return compareSqlValues(a, b);
  }
  return Array.isArray(a) ? 1 : -1; // Mixed types
}
```

## Debugging and Common Pitfalls

Based on real implementation experiences, here are key concepts and common mistakes to avoid when developing runtime emitters.

### Scheduler-Centric Execution Model

**❌ NEVER call instructions directly:**
```typescript
// WRONG - bypasses scheduler
const result = await conditionInstruction.run(rctx, ...args);
if (result) {
    // This breaks the execution model
}
```

**✅ ALWAYS use scheduler callbacks:**
```typescript
// CORRECT - scheduler handles execution and dependency resolution
if (conditionCallback) {
    const conditionResult = await conditionCallback(rctx);
    conditionMet = !!conditionResult;
}
```

**Why this matters:**
- The scheduler manages instruction dependencies and execution order
- Direct calls bypass dependency resolution and can cause race conditions
- Callbacks ensure proper context setup and error handling

### Scope Resolution Debugging

When debugging column resolution issues, understand the scope hierarchy:

**Scope Resolution Order:**
1. `MultiScope` checks child scopes in order (first match wins)
2. `AliasedScope` handles qualified references (`table.column`)
3. `RegisteredScope` contains actual column-to-attribute mappings

**Common scope resolution bugs:**
- **Missing scope in MultiScope**: Check that all relevant scopes are included
- **Wrong scope order**: Earlier scopes shadow later ones - order matters
- **Projection scope issues**: After `ProjectNode`, ensure both projection outputs AND original qualified columns are accessible

**Debugging pattern:**
```typescript
// Add targeted debugging for specific symbols
if (symbolKey === 'problematic.column') {
    console.log('Scope resolution for', symbolKey, 'in', this.scopes.length, 'scopes');
}
```

### Context Lifecycle Management

**Context Setup Pattern:**
```typescript
// Always use context helpers for row context
// Pattern 1: Streaming with generator helper
yield* withRowContextGenerator(rctx, rowDescriptor, rows, async function* (row) {
    // Process row - column references resolve automatically
    const result = await processRow(row, rctx);
    yield result;
});

// Pattern 2: One-off async evaluation
const result = await withAsyncRowContext(rctx, rowDescriptor, () => row, async () => {
    // Async processing with automatic cleanup
    return await processRow(row, rctx);
});

// Pattern 3: High-volume streaming with row slot
const slot = createRowSlot(rctx, rowDescriptor);
try {
    for await (const row of rows) {
        slot.set(row);
        yield processRow(row, rctx);
    }
} finally {
    slot.close();  // CRITICAL: Always clean up
}
```

**Common context bugs:**
- **Forgetting cleanup**: Memory leaks and stale context references
- **Wrong row descriptor**: Attribute IDs don't match actual row structure  
- **Context timing**: Setting up context too late or cleaning up too early

### Debugging Techniques

**Effective debugging approaches:**

1. **Start with scope resolution:** Most column reference errors are scope issues
2. **Check context timing:** Verify context is available when column references execute  
3. **Use targeted logging:** Debug specific symbols rather than everything
4. **Verify row descriptors:** Ensure attribute IDs match actual row structure
5. **Test instruction isolation:** Verify emitters work independently before integration

**Debugging environment variables:**
```bash
# Context lifecycle and column resolution
DEBUG=quereus:runtime:context* yarn test

# Specific operation tracing
DEBUG=quereus:runtime:emit:join yarn test

# Full runtime tracing (verbose)
DEBUG=quereus:runtime* yarn test
```

[Recursive CTE Execution Pattern](./recursive-cte.md)

### Context Helper Functions

Quereus provides helper functions in `src/runtime/context-helpers.ts` to simplify context operations and ensure consistent behavior:

**`createRowSlot(rctx, descriptor)`**
- Creates a mutable slot for efficient streaming operations
- Installs context once, updates by reference (no Map mutations per row)
- Used by all high-frequency streaming emitters: scan, join, filter, project, distinct
- Must call `close()` to clean up

**`resolveAttribute(rctx, attributeId, columnName?)`**
- Looks up an attribute ID in the current context
- Searches newest → oldest (innermost scope wins)  
- Throws descriptive error if not found

**`withRowContext(rctx, descriptor, rowGetter, fn)`**
- Executes a function with a row context
- Executes a **synchronous** function with a row context
- Ensures proper cleanup in finally block
- Use for synchronous expression evaluation

**`withAsyncRowContext(rctx, descriptor, rowGetter, fn)`**
- Executes an **async** function with a row context  
- Ensures proper cleanup in finally block
- Use for async operations (e.g., constraint checks)

**`withRowContextGenerator(rctx, descriptor, rows, fn)`**
- Processes multiple rows with automatic context management
- Ideal for simple streaming operations
- Handles context setup/teardown for each row

**Example usage:**
```typescript
import { createRowSlot, withRowContext, withAsyncRowContext, withRowContextGenerator, resolveAttribute } from '../context-helpers.js';

// Pattern 1: Simple streaming with generator helper
async function* run(rctx: RuntimeContext, rows: AsyncIterable<Row>): AsyncIterable<Row> {
	yield* withRowContextGenerator(rctx, rowDescriptor, rows, async function* (row) {
		const value = someExpression(rctx); // Column refs auto-resolve
		yield processRow(row, value);
	});
}

// Pattern 2: High-volume streaming with row slot
async function* run(rctx: RuntimeContext, rows: AsyncIterable<Row>): AsyncIterable<Row> {
	const slot = createRowSlot(rctx, rowDescriptor);
	try {
		for await (const row of rows) {
			slot.set(row);
			yield row; // Process millions of rows efficiently
		}
	} finally {
		slot.close();
	}
}

// Pattern 3: Synchronous expression evaluation
function evaluateSync(rctx: RuntimeContext, row: Row): SqlValue {
	return withRowContext(rctx, rowDescriptor, () => row, () => {
		// Synchronous expression evaluation
		return someExpression(rctx);
	});
}

// Pattern 4: Async operation with context
async function evaluateAsync(rctx: RuntimeContext, row: Row): Promise<SqlValue> {
	return await withAsyncRowContext(rctx, rowDescriptor, () => row, async () => {
		// Async operation (e.g., constraint check)
		return await someAsyncOperation(rctx);
	});
}
```

