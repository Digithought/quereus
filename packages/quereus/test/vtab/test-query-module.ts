import type { Database } from '../../src/core/database.js';
import { VirtualTable, type UpdateArgs } from '../../src/vtab/table.js';
import type { VirtualTableModule, BaseModuleConfig, SupportAssessment } from '../../src/vtab/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { Row, RowOp } from '../../src/common/types.js';
import type { ConflictResolution } from '../../src/common/constants.js';
import { StatusCode } from '../../src/common/types.js';
import { IndexInfo } from '../../src/vtab/index-info.js';
import { FilterInfo } from '../../src/vtab/filter-info.js';

/**
 * Test virtual table module that implements supports() method
 * for testing query-based push-down functionality.
 *
 * This module wraps a MemoryTable but adds supports() capability
 * to test the retrieve/push-down infrastructure.
 */
export class TestQueryModule implements VirtualTableModule<TestQueryTable, BaseModuleConfig> {

	async create(db: Database, tableSchema: TableSchema): Promise<TestQueryTable> {
		// Create test query table
		return new TestQueryTable(db, tableSchema);
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: BaseModuleConfig,
		importedTableSchema?: TableSchema
	): Promise<TestQueryTable> {
		// Use imported schema if provided, otherwise retrieve from db
		const tableSchema = importedTableSchema ?? db.schemaManager.getTable(schemaName, tableName);
		if (!tableSchema) {
			throw new Error(`Table ${schemaName}.${tableName} not found`);
		}
		return new TestQueryTable(db, tableSchema);
	}

	/**
	 * Test implementation of supports() method.
	 * For initial testing, accept basic Filter and Project operations.
	 */
	supports(node: PlanNode): SupportAssessment | undefined {
		// For now, support basic Filter and Project operations directly above TableReference
		switch (node.nodeType) {
			case PlanNodeType.TableReference:
				// Always support the table reference itself
				return {
					cost: 100, // Base table scan cost
				};

			case PlanNodeType.Filter:
				// Support filters (assume child is supported)
				return {
					cost: 110, // Slightly more than base scan
					ctx: { operation: 'filter', predicate: 'test-predicate' }
				};

			case PlanNodeType.Project:
				// Support projections (assume child is supported)
				return {
					cost: 105, // Slightly more than base scan
					ctx: { operation: 'project', columns: 'test-columns' }
				};

			case PlanNodeType.LimitOffset:
				// Support limit operations (assume child is supported)
				return {
					cost: 102, // Slightly more than base scan
					ctx: { operation: 'limit', limit: 'test-limit' }
				};

			default:
				// Don't support other operations for now
				return undefined;
		}
	}

	// Required xBestIndex method (not used for query-based modules but required by interface)
xBestIndex(_db: Database, _tableInfo: TableSchema, _indexInfo: IndexInfo): number {
		// Not implemented for query-based modules
		return StatusCode.ERROR;
	}

destroy(
		_db: Database,
		_pAux: unknown,
		_moduleName: string,
		_schemaName: string,
		_tableName: string
	): Promise<void> {
		// Nothing to clean up for test module
		return Promise.resolve();
	}
}

/**
 * Test virtual table that implements executePlan
 */
export class TestQueryTable extends VirtualTable {
	private data: Row[] = [];
	private static testModule: TestQueryModule;

	constructor(db: Database, tableSchema: TableSchema) {
		// Create a module reference if needed
		if (!TestQueryTable.testModule) {
			TestQueryTable.testModule = new TestQueryModule();
		}
    super(db, TestQueryTable.testModule, tableSchema.schemaName, tableSchema.name);
    this.tableSchema = tableSchema;
	}

	// Required disconnect method
	async disconnect(): Promise<void> {
		// Nothing to clean up
	}

	// Required update method
	async update(args: UpdateArgs): Promise<Row | undefined> {
		// Simple implementation for testing
		switch (args.operation) {
			case 'insert':
				if (args.values) {
					this.data.push(args.values);
					return args.values;
				}
				break;
			case 'delete':
				// Remove based on old key values
				// For simplicity, just remove first matching row
				if (args.oldKeyValues) {
					const index = this.data.findIndex(row =>
						row.every((val, i) => val === args.oldKeyValues![i])
					);
					if (index >= 0) {
						this.data.splice(index, 1);
					}
				}
				break;
			case 'update':
				// Update based on old key values
				if (args.oldKeyValues && args.values) {
					const index = this.data.findIndex(row =>
						row.every((val, i) => val === args.oldKeyValues[i])
					);
					if (index >= 0) {
						this.data[index] = args.values;
						return args.values;
					}
				}
				break;
		}
		return undefined;
	}

	// Optional query method for standard table access
	async *query(_filterInfo: FilterInfo): AsyncIterable<Row> {
		// Simple implementation - just return all data
		for (const row of this.data) {
			yield row;
		}
	}

	// Test implementation of executePlan - for now, simulate by logging and returning test data
	async *executePlan(db: Database, plan: PlanNode, ctx?: unknown): AsyncIterable<Row> {
		console.log(`[TestQueryTable] Executing pushed-down plan: ${plan.nodeType}, ctx: ${JSON.stringify(ctx)}`);
		// Simulate execution - in real module, would translate plan to module-specific query
		// For test, return simple test data
		yield* this.query!({
			idxNum: 0,
			idxStr: 'test-pushdown',
			constraints: [],
			args: [],
			indexInfoOutput: {
				nConstraint: 0,
				aConstraint: [],
				nOrderBy: 0,
				aOrderBy: [],
				aConstraintUsage: [],
				idxNum: 0,
				idxStr: 'test-pushdown',
				orderByConsumed: false,
				estimatedCost: 100,
				estimatedRows: 1000n,
				idxFlags: 0,
				colUsed: 0n,
			}
		});
	}
}
