import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { SqlDataType } from "../../common/types.js";
import { createIntegratedTableValuedFunction, createTableValuedFunction } from "../registration.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { Database } from "../../core/database.js";
import { Parser } from "../../parser/parser.js";

// Query plan explanation function (table-valued function)
export const queryPlanFunc = createIntegratedTableValuedFunction(
	{
		name: 'query_plan',
		numArgs: 1,
		deterministic: true,
		columns: [
			{ name: 'id', type: SqlDataType.INTEGER, nullable: false },
			{ name: 'parent_id', type: SqlDataType.INTEGER, nullable: true },
			{ name: 'subquery_level', type: SqlDataType.INTEGER, nullable: false },
			{ name: 'op', type: SqlDataType.TEXT, nullable: false },
			{ name: 'detail', type: SqlDataType.TEXT, nullable: false },
			{ name: 'object_name', type: SqlDataType.TEXT, nullable: true },
			{ name: 'alias', type: SqlDataType.TEXT, nullable: true },
			{ name: 'est_cost', type: SqlDataType.REAL, nullable: true },
			{ name: 'est_rows', type: SqlDataType.INTEGER, nullable: true }
		]
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

				// Determine operation type and details
				let op = 'UNKNOWN';
				let detail = 'Unknown operation';
				let objectName: string | null = null;
				let alias: string | null = null;
				let estCost = node.estimatedCost || 1.0;
				let estRows = (node as any).estimatedRows || 10;

				if (node.nodeType) {
					op = node.nodeType.replace(/Node$/, '').toUpperCase();

					switch (node.nodeType) {
						case 'TableScan':
							detail = `SCAN TABLE ${node.source?.tableSchema?.name || 'unknown'}`;
							objectName = node.source?.tableSchema?.name || null;
							alias = node.alias || null;
							break;
						case 'Filter':
							detail = `FILTER WHERE ${node.condition?.toString() || 'condition'}`;
							break;
						case 'Project':
							detail = `PROJECT ${node.projections?.length || 0} columns`;
							break;
						case 'Aggregate':
							detail = `AGGREGATE ${node.aggregates?.length || 0} functions`;
							break;
						case 'LimitOffset':
							detail = `LIMIT ${node.limit?.toString() || 'ALL'} OFFSET ${node.offset?.toString() || '0'}`;
							break;
						case 'TableFunctionCall':
							detail = `CALL ${node.functionName}(${node.operands?.length || 0} args)`;
							objectName = node.functionName;
							alias = node.alias || null;
							break;
						default:
							detail = `${op} operation`;
					}
				}

				yield [
					currentId,           // id
					parentId,           // parent_id
					level,              // subquery_level
					op,                 // op
					detail,             // detail
					objectName,         // object_name
					alias,              // alias
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
			yield [1, null, 0, 'ERROR', `Failed to plan SQL: ${error.message}`, null, null, null, null];
		}
	}
);

// Scheduler program explanation function (table-valued function)
export const schedulerProgramFunc = createIntegratedTableValuedFunction(
	{
		name: 'scheduler_program',
		numArgs: 1,
		deterministic: true,
		columns: [
			{ name: 'addr', type: SqlDataType.INTEGER, nullable: false },
			{ name: 'instruction_id', type: SqlDataType.TEXT, nullable: false },
			{ name: 'dependencies', type: SqlDataType.TEXT, nullable: true }, // JSON array of dependency IDs
			{ name: 'description', type: SqlDataType.TEXT, nullable: false },
			{ name: 'estimated_cost', type: SqlDataType.REAL, nullable: true },
			{ name: 'is_subprogram', type: SqlDataType.INTEGER, nullable: false }, // 0/1 boolean
			{ name: 'parent_addr', type: SqlDataType.INTEGER, nullable: true }
		]
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
					instruction.note || `INSTRUCTION_${i}`, // instruction_id
					JSON.stringify(dependencies), // dependencies
					instruction.note || 'Unknown instruction', // description
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
								subInstruction.note || `SUB_INSTRUCTION_${progIdx}_${subI}`, // instruction_id
								JSON.stringify(subDependencies), // dependencies
								subInstruction.note || 'Unknown sub-instruction', // description
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
		deterministic: false, // Stack traces are not deterministic
		columns: [
			{ name: 'frame_id', type: SqlDataType.INTEGER, nullable: false },
			{ name: 'function_name', type: SqlDataType.TEXT, nullable: true },
			{ name: 'instruction_addr', type: SqlDataType.INTEGER, nullable: true },
			{ name: 'source_location', type: SqlDataType.TEXT, nullable: true },
			{ name: 'local_vars', type: SqlDataType.TEXT, nullable: true } // JSON representation
		]
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
					frame.name,                   // function_name
					i,                           // instruction_addr (simulated)
					frame.location,              // source_location
					JSON.stringify(frame.vars)   // local_vars
				];
			}
		} catch (error: any) {
			// If analysis fails, yield an error frame
			yield [0, 'error', null, 'stack_trace', JSON.stringify({ error: error.message })];
		}
	}
);

// Execution trace function for performance analysis
export const executionTraceFunc = createIntegratedTableValuedFunction(
	{
		name: 'execution_trace',
		numArgs: 1,
		deterministic: false, // Execution traces are not deterministic
		columns: [
			{ name: 'step_id', type: SqlDataType.INTEGER, nullable: false },
			{ name: 'timestamp_ms', type: SqlDataType.REAL, nullable: false },
			{ name: 'operation', type: SqlDataType.TEXT, nullable: false },
			{ name: 'duration_ms', type: SqlDataType.REAL, nullable: true },
			{ name: 'rows_processed', type: SqlDataType.INTEGER, nullable: true },
			{ name: 'memory_used', type: SqlDataType.INTEGER, nullable: true },
			{ name: 'details', type: SqlDataType.TEXT, nullable: true } // JSON representation
		]
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
