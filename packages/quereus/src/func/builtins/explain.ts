import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { SqlDataType } from "../../common/types.js";
import { createIntegratedTableValuedFunction } from "../registration.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { Database } from "../../core/database.js";
import { safeJsonStringify } from "../../util/serialization.js";
import { CollectingInstructionTracer, InstructionTraceEvent } from "../../runtime/types.js";
import { PlanNode, RelationalPlanNode } from "../../planner/nodes/plan-node.js";
import { EmissionContext } from "../../runtime/emission-context.js";
import { emitPlanNode } from "../../runtime/emitters.js";
import { Scheduler } from "../../runtime/scheduler.js";

// Helper function to safely get function name from nodes that have it
function getFunctionName(node: PlanNode): string | null {
	// Check for nodes that have functionName property
	if ('functionName' in node && typeof (node as any).functionName === 'string') {
		return (node as any).functionName;
	}
	return null;
}

// Helper function to safely get alias from nodes that have it
function getAlias(node: PlanNode): string | null {
	// Check for nodes that have alias property
	if ('alias' in node && typeof (node as any).alias === 'string') {
		return (node as any).alias;
	}
	return null;
}

// Helper function to safely get table name or related identifier
function getObjectName(node: PlanNode): string | null {
	// Check for function name first (table functions, scalar functions, etc.)
	const functionName = getFunctionName(node);
	if (functionName) {
		return functionName;
	}

	// Check for table schema in table reference nodes
	if ('tableSchema' in node) {
		const tableSchema = (node as any).tableSchema;
		if (tableSchema && typeof tableSchema.name === 'string') {
			return tableSchema.schemaName ? `${tableSchema.schemaName}.${tableSchema.name}` : tableSchema.name;
		}
	}

	// Check for CTE name
	if ('cteName' in node && typeof (node as any).cteName === 'string') {
		return (node as any).cteName;
	}

	// Check for view schema in view reference nodes
	if ('viewSchema' in node) {
		const viewSchema = (node as any).viewSchema;
		if (viewSchema && typeof viewSchema.name === 'string') {
			return viewSchema.schemaName ? `${viewSchema.schemaName}.${viewSchema.name}` : viewSchema.name;
		}
	}

	return null;
}

// Query plan explanation function (table-valued function)
export const queryPlanFunc = createIntegratedTableValuedFunction(
	{
		name: 'query_plan',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'id', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'parent_id', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'subquery_level', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'node_type', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'op', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'detail', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'object_name', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'alias', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'properties', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'physical', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'est_cost', type: { typeClass: 'scalar', affinity: SqlDataType.REAL, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'est_rows', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: true, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('query_plan() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Parse and plan the SQL to get the actual plan tree
			const plan = db.getPlan(sql);

			// Traverse the plan tree and yield information about each node
			let nodeId = 1;
			const nodeStack: Array<{ node: PlanNode; parentId: number | null; level: number }> = [
				{ node: plan, parentId: null, level: 0 }
			];

			while (nodeStack.length > 0) {
				const { node, parentId, level } = nodeStack.pop()!;
				const currentId = nodeId++;

				// Get node type
				const nodeType = node.nodeType || 'UNKNOWN';

				// Determine operation type and details
				let op = 'UNKNOWN';
				let detail = 'Unknown operation';
				let objectName: string | null = null;
				let alias: string | null = null;
				const estCost = node.estimatedCost || 1.0;
				const estRows = (node as RelationalPlanNode).estimatedRows || 10;

				// Use node's toString() method for detail if available
				if (typeof node.toString === 'function') {
					detail = node.toString();
				}

				if (node.nodeType) {
					op = node.nodeType.replace(/Node$/, '').toUpperCase();

					// Extract object name and alias using helper functions
					objectName = getObjectName(node);
					alias = getAlias(node);
				}

				// Get logical properties using the correct method name
				let properties: string | null = null;
				const logicalAttributes = node.getLogicalAttributes();
				if (logicalAttributes && Object.keys(logicalAttributes).length > 0) {
					properties = safeJsonStringify(logicalAttributes);
				}

				// Get physical properties (if available)
				let physical: string | null = null;
				if (node.physical) {
					physical = safeJsonStringify(node.physical);
				}

				yield [
					currentId,           // id
					parentId,           // parent_id
					level,              // subquery_level
					nodeType,           // node_type
					op,                 // op
					detail,             // detail
					objectName,         // object_name
					alias,              // alias
					properties,         // properties
					physical,           // physical
					estCost,            // est_cost
					estRows             // est_rows
				];

				// Add children to stack (in reverse order so they're processed in correct order)
				// getChildren() is guaranteed to exist on all PlanNode instances
				const children = node.getChildren();
				for (let i = children.length - 1; i >= 0; i--) {
					nodeStack.push({ node: children[i], parentId: currentId, level });
				}
			}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (error: any) {
			// If planning fails, yield an error row
			yield [1, null, 0, 'ERROR', 'ERROR', `Failed to plan SQL: ${error.message}`, null, null, null, null, null, null];
		}
	}
);

// Scheduler program explanation function (table-valued function)
export const schedulerProgramFunc = createIntegratedTableValuedFunction(
	{
		name: 'scheduler_program',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'addr', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'dependencies', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true }, // JSON array of dependency IDs
				{ name: 'description', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'estimated_cost', type: { typeClass: 'scalar', affinity: SqlDataType.REAL, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'is_subprogram', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true }, // 0/1 boolean
				{ name: 'parent_addr', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: true, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('scheduler_program() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Parse and plan the SQL to get the actual plan tree
			const plan = db.getPlan(sql);

			// Emit the plan to get the instruction tree
			const emissionContext = new EmissionContext(db);
			const rootInstruction = emitPlanNode(plan, emissionContext);

			// Create a scheduler to get the instruction sequence
			const scheduler = new Scheduler(rootInstruction);

			// Yield information about each instruction
			for (let i = 0; i < scheduler.instructions.length; i++) {
				const instruction = scheduler.instructions[i];
				const dependencies = instruction.params.map((_, idx) => idx).filter(idx => idx < i);

				yield [
					i, // addr
					JSON.stringify(dependencies), // dependencies
					instruction.note || `INSTRUCTION_${i}`, // instruction_id
					null, // estimated_cost (not available in current implementation)
					0, // is_subprogram (main program)
					null // parent_addr (main program)
				];

				// If this instruction has sub-programs, yield those too
				if (instruction.programs) {
					for (let progIdx = 0; progIdx < instruction.programs.length; progIdx++) {
						const subProgram = instruction.programs[progIdx];
						for (let subI = 0; subI < subProgram.instructions.length; subI++) {
							const subInstruction = subProgram.instructions[subI];
							const subDependencies = subInstruction.params.map((_, idx) => idx).filter(idx => idx < subI);

							yield [
								scheduler.instructions.length + progIdx * 1000 + subI, // addr (offset for sub-programs)
								JSON.stringify(subDependencies), // dependencies
								subInstruction.note || `SUB_INSTRUCTION_${progIdx}_${subI}`, // instruction_id
								null, // estimated_cost
								1, // is_subprogram
								i // parent_addr
							];
						}
					}
				}
			}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (error: any) {
			// If compilation fails, yield an error instruction
			yield [0, 'ERROR', '[]', `Failed to compile SQL: ${error.message}`, null, 0, null];
		}
	}
);

// Stack trace function for debugging execution
export const stackTraceFunc = createIntegratedTableValuedFunction(
	{
		name: 'stack_trace',
		numArgs: 1,
		deterministic: true,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'frame_id', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'depth', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'location', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'plan_node_type', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operation', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'table_or_function', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'is_virtual', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true } // 0/1 boolean
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('stack_trace() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Parse and plan the SQL to capture the call stack
			const plan = db.getPlan(sql);

			// Simulate a call stack based on the plan structure
			let frameId = 0;
			const stack: Array<{ name: string; location: string; vars: any }> = [];

			// Add main execution frame
			stack.push({
				name: 'main',
				location: 'database.ts:exec',
				vars: { sql, autocommit: db.getAutocommit() }
			});

			// Add planning frames
			stack.push({
				name: 'buildPlan',
				location: 'database.ts:_buildPlan',
				vars: { planType: plan.nodeType }
			});

			// Add frames based on plan node types
			const addPlanFrames = (node: PlanNode, depth: number = 0) => {
				if (!node || depth > 10) return; // Prevent infinite recursion

				switch (node.nodeType) {
					case 'Block':
						stack.push({
							name: 'buildBlock',
							location: 'building/block.ts:buildBlock',
							vars: { statementCount: ('statements' in node) ? (node as any).statements?.length || 0 : 0 }
						});
						break;
					case 'Filter':
						stack.push({
							name: 'buildFilter',
							location: 'building/select.ts:buildSelectStmt',
							vars: { condition: ('condition' in node) ? (node as any).condition?.toString() || 'unknown' : 'unknown' }
						});
						break;
					case 'Project':
						stack.push({
							name: 'buildProject',
							location: 'building/select.ts:buildSelectStmt',
							vars: { projectionCount: ('projections' in node) ? (node as any).projections?.length || 0 : 0 }
						});
						break;
				}

				// Recursively add frames for children
				// getChildren() is guaranteed to exist on all PlanNode instances
				const children = node.getChildren();
				children.forEach((child: PlanNode) => addPlanFrames(child, depth + 1));
			};

			addPlanFrames(plan);

			// Yield stack frames (reverse order - deepest first)
			for (let i = stack.length - 1; i >= 0; i--) {
				const frame = stack[i];
				yield [
					frameId++,                    // frame_id
					i,                           // depth
					frame.location,              // location
					frame.name,                   // plan_node_type
					frame.name,                   // operation
					null,                        // table_or_function
					0                            // is_virtual
				];
			}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (error: any) {
			// If analysis fails, yield an error frame
			yield [0, 0, 'error', 'stack_trace', JSON.stringify({ error: error.message })];
		}
	}
);

// Execution trace function for performance analysis
export const executionTraceFunc = createIntegratedTableValuedFunction(
	{
		name: 'execution_trace',
		numArgs: 1,
		deterministic: false, // Execution traces are not deterministic
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'instruction_index', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operation', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'dependencies', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true }, // JSON array of instruction indices this depends on
				{ name: 'input_values', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true }, // JSON
				{ name: 'output_value', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true }, // JSON
				{ name: 'duration_ms', type: { typeClass: 'scalar', affinity: SqlDataType.REAL, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'sub_programs', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true }, // JSON
				{ name: 'error_message', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'timestamp_ms', type: { typeClass: 'scalar', affinity: SqlDataType.REAL, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('execution_trace() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// First, get the scheduler program to understand instruction dependencies
			const instructionDependencies = new Map<number, number[]>();
			const instructionOperations = new Map<number, string>();

			try {
				// Get scheduler program information
				for await (const row of db.eval('SELECT * FROM scheduler_program(?)', [sql])) {
					const addr = row.addr as number;
					const dependencies = JSON.parse((row.dependencies as string) || '[]') as number[];
					const description = row.description as string;

					instructionDependencies.set(addr, dependencies);
					instructionOperations.set(addr, description);
				}
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} catch (schedulerError: any) {
				console.warn('Could not get scheduler program info:', schedulerError.message);
			}

			// Import the CollectingInstructionTracer
			const tracer = new CollectingInstructionTracer();

			// Parse the query and execute with tracing
			let stmt: any;
			try {
				stmt = db.prepare(sql);

				// Execute the query with tracing to collect actual instruction events
				const results: any[] = [];
				for await (const row of stmt.iterateRowsWithTrace(undefined, tracer)) {
					results.push(row); // We don't yield the results, just the trace events
				}

				await stmt.finalize();
			} catch (executionError: unknown) {
				// If execution fails, we might still have some trace events
				console.warn('Query execution failed during tracing:', executionError instanceof Error ? executionError.message : String(executionError));
			}

			// Get the collected trace events
			const traceEvents = tracer.getTraceEvents();

			// Group events by instruction index and consolidate into single rows
			const eventsByInstruction = new Map<number, InstructionTraceEvent[]>();
			for (const event of traceEvents) {
				const instructionIndex = event.instructionIndex;
				if (!eventsByInstruction.has(instructionIndex)) {
					eventsByInstruction.set(instructionIndex, []);
				}
				eventsByInstruction.get(instructionIndex)!.push(event);
			}

			// Get sub-program information for enhanced context
			const subPrograms = tracer.getSubPrograms ? tracer.getSubPrograms() : new Map();

			// Create one row per instruction execution
			for (const [instructionIndex, events] of eventsByInstruction.entries()) {
				const inputEvent = events.find(e => e.type === 'input');
				const outputEvent = events.find(e => e.type === 'output');
				const errorEvent = events.find(e => e.type === 'error');

				// Use operation name from scheduler program, fallback to event note
				const operationName = instructionOperations.get(instructionIndex) || inputEvent?.note || 'Unknown';
				const dependencies = instructionDependencies.get(instructionIndex) || [];

				// Calculate duration between input and output
				let duration: number | null = null;
				if (inputEvent && outputEvent) {
					duration = outputEvent.timestamp - inputEvent.timestamp;
				}

				// Build enhanced sub-program information
				let subProgramsInfo: any = null;
				if (inputEvent?.subPrograms && inputEvent.subPrograms.length > 0) {
					// Enhance sub-program info with details from the tracer
					subProgramsInfo = inputEvent.subPrograms.map(sp => {
						const subProgramDetail = subPrograms.get(sp.programIndex);
						const baseInfo = {
							programIndex: sp.programIndex,
							instructionCount: sp.instructionCount,
							rootNote: sp.rootNote
						};

						if (subProgramDetail) {
							// Add instruction details from the sub-program
							const instructions = subProgramDetail.scheduler.instructions.map((instr: any, idx: number) => ({
								index: idx,
								operation: instr.note || `instruction_${idx}`,
								dependencies: instr.params.map((_: any, paramIdx: number) => paramIdx).filter((paramIdx: number) => paramIdx < idx)
							}));
							return { ...baseInfo, instructions };
						}

						return baseInfo;
					});
				}

				const timestamp = inputEvent?.timestamp || outputEvent?.timestamp || Date.now();

				yield [
					instructionIndex,                                                          // instruction_index
					operationName,                                                            // operation
					safeJsonStringify(dependencies),                                          // dependencies
					inputEvent?.args ? safeJsonStringify(inputEvent.args) : null,            // input_values
					outputEvent?.result !== undefined ? safeJsonStringify(outputEvent.result) : null, // output_value
					duration,                                                                  // duration_ms
					subProgramsInfo ? safeJsonStringify(subProgramsInfo) : null,             // sub_programs
					errorEvent?.error || null,                                                // error_message
					timestamp                                                                  // timestamp_ms
				];
			}

			// If no trace events were captured, yield a summary row
			if (eventsByInstruction.size === 0) {
				yield [
					0,                    // instruction_index
					'NO_TRACE_DATA',      // operation
					safeJsonStringify([]), // dependencies
					null,                 // input_values
					safeJsonStringify('No instruction-level trace events captured'), // output_value
					null,                 // duration_ms
					null,                 // sub_programs
					null,                 // error_message
					Date.now()            // timestamp_ms
				];
			}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (error: any) {
			// If tracing setup fails, yield an error event
			yield [
				0,                                                        // instruction_index
				'TRACE_SETUP',                                           // operation
				safeJsonStringify([]),                                    // dependencies
				null,                                                     // input_values
				null,                                                     // output_value
				null,                                                     // duration_ms
				null,                                                     // sub_programs
				`Failed to setup execution trace: ${error.message}`,     // error_message
				Date.now()                                                // timestamp_ms
			];
		}
	}
);

// Row-level execution trace function for detailed data flow analysis
export const rowTraceFunc = createIntegratedTableValuedFunction(
	{
		name: 'row_trace',
		numArgs: 1,
		deterministic: false, // Row traces are not deterministic
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'instruction_index', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operation', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'row_index', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'row_data', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true }, // JSON array of row values
				{ name: 'timestamp_ms', type: { typeClass: 'scalar', affinity: SqlDataType.REAL, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'row_count', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: true, isReadOnly: true }, generated: true } // Total rows for this instruction (filled in last row)
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('row_trace() requires a SQL string argument', StatusCode.ERROR);
		}

		try {
			// Import the CollectingInstructionTracer
			const tracer = new CollectingInstructionTracer();

			// Parse the query and execute with tracing
			let stmt: any;
			try {
				stmt = db.prepare(sql);

				// Execute the query with tracing to collect row-level events
				const results: any[] = [];
				for await (const row of stmt.iterateRowsWithTrace(undefined, tracer)) {
					results.push(row); // We don't yield the results, just the trace events
				}

				await stmt.finalize();
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			} catch (executionError: any) {
				// If execution fails, we might still have some trace events
				console.warn('Query execution failed during row tracing:', executionError.message);
			}

			// Get the collected trace events and filter for row events
			const traceEvents = tracer.getTraceEvents();
			const rowEvents = traceEvents.filter(event => event.type === 'row');

			// Group row events by instruction index to calculate row counts
			const rowsByInstruction = new Map<number, typeof rowEvents>();
			for (const event of rowEvents) {
				const instructionIndex = event.instructionIndex;
				if (!rowsByInstruction.has(instructionIndex)) {
					rowsByInstruction.set(instructionIndex, []);
				}
				rowsByInstruction.get(instructionIndex)!.push(event);
			}

			// Yield detailed information for each row
			for (const [instructionIndex, instructionRowEvents] of rowsByInstruction.entries()) {
				const totalRows = instructionRowEvents.length;

				for (let i = 0; i < instructionRowEvents.length; i++) {
					const event = instructionRowEvents[i];
					const isLastRow = i === instructionRowEvents.length - 1;

					yield [
						instructionIndex,                                                    // instruction_index
						event.note || 'Unknown',                                           // operation
						event.rowIndex ?? i,                                               // row_index
						safeJsonStringify(event.row),                                      // row_data
						event.timestamp,                                                    // timestamp_ms
						isLastRow ? totalRows : null                                       // row_count (only on last row)
					];
				}
			}

			// If no row events were captured, yield a summary row
			if (rowEvents.length === 0) {
				yield [
					0,                                            // instruction_index
					'NO_ROW_DATA',                               // operation
					0,                                           // row_index
					safeJsonStringify('No row-level trace events captured'), // row_data
					Date.now(),                                  // timestamp_ms
					0                                            // row_count
				];
			}

		} catch (error: unknown) {
			// If tracing setup fails, yield an error event
			yield [
				0,                                                        // instruction_index
				'ROW_TRACE_SETUP',                                       // operation
				0,                                                       // row_index
				safeJsonStringify(`Failed to setup row trace: ${error instanceof Error ? error.message : String(error)}`), // row_data
				Date.now(),                                              // timestamp_ms
				null                                                     // row_count
			];
		}
	}
);

// Schema size function (table-valued function)
export const schemaSizeFunc = createIntegratedTableValuedFunction(
	{
		name: 'schema_size',
		numArgs: 0,
		deterministic: false, // Schema can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'object_type', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'object_name', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'estimated_rows', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'estimated_size_kb', type: { typeClass: 'scalar', affinity: SqlDataType.REAL, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'column_count', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'index_count', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (_db: Database, _sql: SqlValue): AsyncIterable<Row> {
		// TODO: Implementation of schemaSizeFunc
	}
);
