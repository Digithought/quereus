import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { SqlDataType } from "../../common/types.js";
import { createIntegratedTableValuedFunction, createTableValuedFunction } from "../registration.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { Database } from "../../core/database.js";
import { Parser } from "../../parser/parser.js";
import { safeJsonStringify } from "../../util/serialization.js";

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
			const nodeStack: Array<{ node: any; parentId: number | null; level: number }> = [
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
				let estCost = node.estimatedCost || 1.0;
				let estRows = (node as any).estimatedRows || 10;

				// Use node's toString() method for detail if available
				if (typeof node.toString === 'function') {
					detail = node.toString();
				}

				if (node.nodeType) {
					op = node.nodeType.replace(/Node$/, '').toUpperCase();

					switch (node.nodeType) {
						case 'TableScan':
							objectName = node.source?.tableSchema?.name || null;
							alias = node.alias || null;
							break;
						case 'TableFunctionCall':
							objectName = node.functionName;
							alias = node.alias || null;
							break;
						default:
							// For other node types, try to extract common properties
							if (node.alias) {
								alias = node.alias;
							}
							if (node.tableName) {
								objectName = node.tableName;
							}
							if (node.functionName) {
								objectName = node.functionName;
							}
					}
				}

				// Get logical properties (if available)
				let properties: string | null = null;
				if (node.getLogicalProperties) {
					const logicalProps = node.getLogicalProperties();
					if (logicalProps) {
						properties = safeJsonStringify(logicalProps);
					}
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
				const children = node.getChildren ? node.getChildren() : [];
				for (let i = children.length - 1; i >= 0; i--) {
					nodeStack.push({ node: children[i], parentId: currentId, level });
				}

				// Add relations (input tables/nodes)
				const relations = node.getRelations ? node.getRelations() : [];
				for (let i = relations.length - 1; i >= 0; i--) {
					nodeStack.push({ node: relations[i], parentId: currentId, level });
				}
			}
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
			const { EmissionContext } = await import('../../runtime/emission-context.js');
			const { emitPlanNode } = await import('../../runtime/emitters.js');
			const { Scheduler } = await import('../../runtime/scheduler.js');

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
			const addPlanFrames = (node: any, depth: number = 0) => {
				if (!node || depth > 10) return; // Prevent infinite recursion

				switch (node.nodeType) {
					case 'Block':
						stack.push({
							name: 'buildBlock',
							location: 'building/block.ts:buildBlock',
							vars: { statementCount: node.statements?.length || 0 }
						});
						break;
					case 'TableScan':
						stack.push({
							name: 'buildTableScan',
							location: 'building/table.ts:buildTableScan',
							vars: { tableName: node.source?.tableSchema?.name || 'unknown' }
						});
						break;
					case 'Filter':
						stack.push({
							name: 'buildFilter',
							location: 'building/select.ts:buildSelectStmt',
							vars: { condition: node.condition?.toString() || 'unknown' }
						});
						break;
					case 'Project':
						stack.push({
							name: 'buildProject',
							location: 'building/select.ts:buildSelectStmt',
							vars: { projectionCount: node.projections?.length || 0 }
						});
						break;
				}

				// Recursively add frames for children
				const children = node.getChildren ? node.getChildren() : [];
				children.forEach((child: any) => addPlanFrames(child, depth + 1));
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
				{ name: 'step_id', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'timestamp_ms', type: { typeClass: 'scalar', affinity: SqlDataType.REAL, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'operation', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'duration_ms', type: { typeClass: 'scalar', affinity: SqlDataType.REAL, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'rows_processed', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'memory_used', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'details', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true } // JSON representation
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		if (typeof sql !== 'string') {
			throw new QuereusError('execution_trace() requires a SQL string argument', StatusCode.ERROR);
		}

		const startTime = Date.now();
		let stepId = 0;
		let currentTime = startTime;

		try {
			// Step 1: Parse
			const parseStart = performance.now();
			const parser = new Parser();
			const ast = parser.parse(sql);
			const parseEnd = performance.now();
			const parseDuration = parseEnd - parseStart;

			yield [
				stepId++,
				currentTime,
				'PARSE',
				parseDuration,
				null,
				Math.round(JSON.stringify(ast).length), // Rough memory estimate
				JSON.stringify({
					statementType: ast.type,
					hasSubqueries: sql.toLowerCase().includes('select') && sql.split(/\bselect\b/i).length > 2
				})
			];
			currentTime += parseDuration;

			// Step 2: Plan
			const planStart = performance.now();
			const plan = db.getPlan(sql);
			const planEnd = performance.now();
			const planDuration = planEnd - planStart;

			// Count plan nodes
			let nodeCount = 0;
			const countNodes = (node: any) => {
				nodeCount++;
				const children = node.getChildren ? node.getChildren() : [];
				children.forEach(countNodes);
				const relations = node.getRelations ? node.getRelations() : [];
				relations.forEach(countNodes);
			};
			countNodes(plan);

			yield [
				stepId++,
				currentTime,
				'PLAN',
				planDuration,
				null,
				nodeCount * 100, // Rough memory estimate per node
				JSON.stringify({
					nodeCount,
					rootNodeType: plan.nodeType,
					estimatedCost: plan.estimatedCost || null,
					estimatedRows: (plan as any).estimatedRows || null
				})
			];
			currentTime += planDuration;

			// Step 3: Emit
			const emitStart = performance.now();
			const { EmissionContext } = await import('../../runtime/emission-context.js');
			const { emitPlanNode } = await import('../../runtime/emitters.js');
			const emissionContext = new EmissionContext(db);
			const rootInstruction = emitPlanNode(plan, emissionContext);
			const emitEnd = performance.now();
			const emitDuration = emitEnd - emitStart;

			yield [
				stepId++,
				currentTime,
				'EMIT',
				emitDuration,
				null,
				1000, // Rough estimate for instruction tree
				JSON.stringify({
					hasSubPrograms: !!(rootInstruction.programs && rootInstruction.programs.length > 0),
					instructionNote: rootInstruction.note || 'unknown'
				})
			];
			currentTime += emitDuration;

			// Step 4: Schedule
			const scheduleStart = performance.now();
			const { Scheduler } = await import('../../runtime/scheduler.js');
			const scheduler = new Scheduler(rootInstruction);
			const scheduleEnd = performance.now();
			const scheduleDuration = scheduleEnd - scheduleStart;

			yield [
				stepId++,
				currentTime,
				'SCHEDULE',
				scheduleDuration,
				null,
				scheduler.instructions.length * 50, // Rough memory per instruction
				JSON.stringify({
					instructionCount: scheduler.instructions.length,
					hasSubPrograms: scheduler.instructions.some(i => i.programs && i.programs.length > 0)
				})
			];
			currentTime += scheduleDuration;

			// Step 5: Execute (simulated - we don't actually run it)
			const totalTime = currentTime - startTime;
			yield [
				stepId++,
				currentTime,
				'READY',
				null,
				null,
				null,
				JSON.stringify({
					totalPreparationTime: totalTime,
					readyForExecution: true,
					note: 'Execution not performed in trace mode'
				})
			];

		} catch (error: any) {
			// If any step fails, yield an error trace
			yield [
				stepId,
				currentTime,
				'ERROR',
				null,
				null,
				null,
				JSON.stringify({ error: error.message, step: 'execution_trace' })
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
	async function* (db: Database, sql: SqlValue): AsyncIterable<Row> {
		// Implementation of schemaSizeFunc
	}
);
