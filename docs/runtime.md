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
- `RelationalNode`: Plan nodes that produce rows
- `ExpressionNode`: Plan nodes that produce scalar values

## Adding a New Plan Node

### 1. Create the Node Interface (`src/planner/nodes/`)

```typescript
// src/planner/nodes/my-operation-node.ts
import { RelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';

export interface MyOperationNode extends RelationalNode {
	nodeType: PlanNodeType.MyOperation;
	inputNode: RelationalNode;
	operationParam: string;
}

export class MyOperationPlanNode extends RelationalNode implements MyOperationNode {
	readonly nodeType = PlanNodeType.MyOperation;

	constructor(
		scope: Scope,
		public readonly inputNode: RelationalNode,
		public readonly operationParam: string
	) {
		super(scope, inputNode.cost + 10); // Add operation cost
	}
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
import { MyOperationPlanNode } from '../nodes/my-operation-node.js';
import { buildSelectStmt } from './select.js';

export function buildMyOperationStmt(ctx: PlanningContext, stmt: AST.MyOperationStmt): MyOperationPlanNode {
	// Build child nodes
	const inputNode = buildSelectStmt(ctx, stmt.inputQuery);
	
	// Validate parameters
	if (!stmt.operationParam) {
		throw new QuereusError('Operation parameter required', StatusCode.ERROR);
	}

	return new MyOperationPlanNode(ctx.scope, inputNode, stmt.operationParam);
}
```

### 4. Register in some other builder

```typescript
// src/planner/building/block.ts
import { buildMyOperationStmt } from './my-operation.js';

export function buildBlock(ctx: PlanningContext, statements: AST.Statement[]): BlockNode {
	const plannedStatements = statements.map((stmt) => {
		switch (stmt.type) {
			// ... existing cases
			case 'myOperation':
				return buildMyOperationStmt(ctx, stmt as AST.MyOperationStmt);
		}
	});
}
```

## Creating an Emitter

### 1. Create the Emitter (`src/runtime/emit/`)

```typescript
// src/runtime/emit/my-operation.ts
import type { MyOperationNode } from '../../planner/nodes/my-operation-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitPlanNode } from '../emitters.js';

export function emitMyOperation(plan: MyOperationNode, ctx: EmissionContext): Instruction {
  // Do non-runtime work here to make run faster.    Can select from different run functions to avoid runtime work.

	// Optimal run function patterns:
	
	// For async generators (row-producing operations):
	async function* run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>): AsyncIterable<Row> {
		for await (const row of inputRows) {
			// Process each row
			const processedRow = processRow(row, plan.operationParam);
			yield processedRow;
		}
	}

	// For scalar operations:
	// function run(rctx: RuntimeContext, inputValue: SqlValue): SqlValue {
	//     return processValue(inputValue, plan.operationParam);
	// }

	// For void operations (DDL/DML) - async example:
	// async function run(rctx: RuntimeContext, inputRows: AsyncIterable<Row>): Promise<void> {
	//     for await (const row of inputRows) {
	//         await performSideEffect(row);
	//     }
	//     return void;
	// }

	// Emit child instructions
	const inputInstruction = emitPlanNode(plan.inputNode, ctx);

	return {
		params: [inputInstruction],
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

## Scheduler Execution Model

The Scheduler executes instructions in dependency order:

1. **Flattening**: Converts instruction tree to linear array
2. **Dependency Resolution**: Ensures instructions execute after their dependencies
3. **Async Handling**: Uses `Promise.all()` for concurrent dependency resolution
4. **Memory Management**: Clears instruction arguments after execution

### Key Points for Emitter Authors

- **Return Types**: Match your function signature to expected output type
- **Async Iterables**: Use `async function*` for row-producing operations
- **Error Handling**: Throw `QuereusError` with appropriate `StatusCode`
- **Resource Cleanup**: Handle cleanup in `finally` blocks if needed

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

## Common Patterns

### Row Processing
```typescript
async function* run(rctx: RuntimeContext, input: AsyncIterable<Row>): AsyncIterable<Row> {
	for await (const row of input) {
		// Process row
		yield transformedRow;
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
		await performMutation(row);
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

4. **Column references via attributes**
   •  `ColumnReferenceNode` uses stable `attributeId` instead of node references.
   •  Relational nodes implement `getAttributes()` to define their output columns.
   •  This enables robust column tracking across plan transformations.

### Example Transformations

- `AggregateNode` (logical) → `SortNode + StreamAggregateNode` (physical)
- `TableScanNode` → `TableScanNode` (marked physical with properties)
- Nodes that cannot be physical (like `AggregateNode`) have `override readonly physical: undefined`

### Physical Properties Inference

The optimizer automatically:
- Collects properties from all children (scalar + relational)
- Calls node's `getPhysical()` if available
- Applies inference rules (e.g., constant propagation)
- Ensures every node becomes physical or fails with clear error

This completes the minimal framework needed to support ordered and hash aggregation as well as other decisions like index selection and join algorithms.

