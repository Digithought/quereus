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
type OutputValue = RuntimeValue | Promise<RuntimeValue>;
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
toString(): "WHERE age > 40"

// ProjectNode
toString(): "SELECT name, COUNT(*) AS total"

// SortNode
toString(): "ORDER BY name DESC, age ASC"

// AggregateNode
toString(): "GROUP BY dept_id  AGG  COUNT(*) AS count, SUM(salary) AS total"
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

export function emitMyOperation(plan: MyOperationNode, ctx: EmissionContext): Instruction {
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

	// Optimal run function patterns:
	
	// For async generators (row-producing operations):
	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>): AsyncIterable<Row> {
		for await (const row of inputRows) {
			// Set up context for input row using row descriptor
			rctx.context.set(sourceRowDescriptor, () => row);
			
			try {
				// Process each row
				const processedRow = processRow(row, plan.operationParam);
				
				// Set up context for output row (if different from input)
				rctx.context.set(outputRowDescriptor, () => processedRow);
				try {
					yield processedRow;
				} finally {
					rctx.context.delete(outputRowDescriptor);
				}
			} finally {
				// Clean up input context
				rctx.context.delete(sourceRowDescriptor);
			}
		}
	}

	// For scalar operations:
	// function run(rctx: RuntimeContext, inputValue: SqlValue): SqlValue {
	//     return processValue(inputValue, plan.operationParam);
	// }

	// For void operations (DDL/DML) - async example:
	// async function run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>): Promise<void> {
	//     for await (const row of inputRows) {
	//         // Set up context for this row
	//         rctx.context.set(sourceRowDescriptor, () => row);
	//         try {
	//             await performSideEffect(row);
	//         } finally {
	//             rctx.context.delete(sourceRowDescriptor);
	//         }
	//     }
	//     return void;
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
**Always** set up row context using row descriptors:
```typescript
// Create row descriptor
const rowDescriptor: RowDescriptor = [];
const attributes = plan.getAttributes();
attributes.forEach((attr, index) => {
	rowDescriptor[attr.id] = index;
});

// Set context for each row
rctx.context.set(rowDescriptor, () => row);
try {
	// Process row...
	yield result;
} finally {
	rctx.context.delete(rowDescriptor);
}
```

### Column Reference Resolution
Column references are resolved automatically using attribute IDs:
```typescript
// In emitColumnReference (built-in):
function run(ctx: RuntimeContext): SqlValue {
	// Use deterministic lookup based on attribute ID
	for (const [descriptor, rowGetter] of ctx.context.entries()) {
		const columnIndex = descriptor[plan.attributeId];
		if (columnIndex !== undefined) {
			const row = rowGetter();
			if (Array.isArray(row) && columnIndex < row.length) {
				return row[columnIndex];
			}
		}
	}
	throw new QuereusError(`No row context found for column`, StatusCode.INTERNAL);
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

## Emission Context

Provides schema lookups and dependency tracking during emission:

```typescript
// During emission
const tableSchema = ctx.findTable('users');
const moduleInfo = ctx.getVtabModule('memory');

// Capture dependencies for runtime
const moduleKey = `vtab_module:${tableSchema.vtabModuleName}`;
// Runtime retrieval
const capturedModule = ctx.getCapturedSchemaObject(moduleKey);
```

## Attribute-Based Context System

Quereus uses a robust attribute-based context system for column reference resolution. This system provides deterministic, stable column references that work reliably across plan transformations and optimizations.

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

### Implementation for New Emitters

```typescript
import { createLogger } from '../../common/logger.js';

const ctxLog = createLogger('runtime:context');

function logContextPush(descriptor: RowDescriptor, note: string, attributes?: any[]) {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	const attrNames = attributes ? attributes.map(attr => `${attr.name}(#${attr.id})`).join(',') : 'unknown';
	ctxLog('PUSH context %s: attrs=[%s] names=[%s]', note, attrs.join(','), attrNames);
}

function logContextPop(descriptor: RowDescriptor, note: string) {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('POP context %s: attrs=[%s]', note, attrs.join(','));
}

// In your emitter:
ctx.context.set(rowDescriptor, () => row);
logContextPush(rowDescriptor, 'my-operation', attributes);
try {
	// Process row...
} finally {
	logContextPop(rowDescriptor, 'my-operation');
	ctx.context.delete(rowDescriptor);
}
```

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

## Common Patterns

### Row Processing with Context
```typescript
async function* run(rctx: RuntimeContext, input: AsyncIterable<Row>): AsyncIterable<Row> {
	for await (const row of input) {
		// Set up row context using row descriptor
		rctx.context.set(rowDescriptor, () => row);
		try {
			// Process row - column references will resolve automatically
			const result = await processRow(row);
			yield result;
		} finally {
			// Always clean up context
			rctx.context.delete(rowDescriptor);
		}
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
	for await (const row of input) {
		rctx.context.set(rowDescriptor, () => row);
		try {
			await performMutation(row);
		} finally {
			rctx.context.delete(rowDescriptor);
		}
	}
	return undefined;
}
```

## Optimiser Architecture (Titan Phase-I)

Titan uses a single plan node hierarchy with a logical→physical transformation pass.
Every plan node built by the *builder* starts as **logical** (no `physical` property).
The *optimiser* then walks the tree and transforms or marks each node so that, after optimisation, **every** node in the tree has a `physical` property and therefore has a registered runtime emitter.

### Key Design Points

1. **Single hierarchy, dual phase**
   •  One `PlanNode` type tree – no duplicated logical/physical subclasses.
   •  Each instance carries optional `physical: PhysicalProperties` to indicate its phase.

2. **Physical Properties**
   •  `PhysicalProperties` captures execution characteristics: ordering, row estimates, unique keys, determinism, etc.
   •  Nodes can implement `getPhysical(childrenPhysical)` to compute their properties based on children.
   •  The optimizer calls this during the logical→physical transformation.

3. **Transformation rules**
   •  Rules are registered per `PlanNodeType` (see `optimizer.ts`).
   •  Each rule can:
     –   return *null* (not applicable),
     –   return a **replacement node** (often a different physical algorithm), or
     –   do a deeper rewrite (e.g. `Aggregate → Sort + StreamAggregate`).

4. **Attribute ID preservation**
   •  **Critical**: Optimizer preserves original attribute IDs during transformations
   •  `ColumnReferenceNode` uses stable `attributeId` instead of node references
   •  Relational nodes implement `getAttributes()` to define their output columns
   •  This enables robust column tracking across plan transformations

### Example Transformations

- `AggregateNode` (logical) → `SortNode + StreamAggregateNode` (physical, preserving attribute IDs)
- `TableScanNode` → `TableScanNode` (marked physical with properties)
- Nodes that cannot be physical (like `AggregateNode`) have `override readonly physical: undefined`

### Physical Properties Inference

The optimizer automatically:
- Collects properties from all children (scalar + relational)
- Calls node's `getPhysical()` if available
- Applies inference rules (e.g., constant propagation)
- **Preserves attribute IDs** when creating physical nodes
- Ensures every node becomes physical or fails with clear error

This completes the minimal framework needed to support ordered and hash aggregation as well as other decisions like index selection and join algorithms, all while maintaining robust column reference resolution through the attribute-based context system.

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
