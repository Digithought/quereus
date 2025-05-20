import { VirtualTable } from '../table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../module.js';
import type { IndexInfo } from '../index-info.js';
import { StatusCode, SqlDataType, type SqlValue, type Row, type RowIdRow } from '../../common/types.js';
import { SqliterError } from '../../common/errors.js';
import type { Database } from '../../core/database.js';
import type { Schema } from '../../schema/schema.js';
import type { FunctionSchema } from '../../schema/function.js';
import type { TableSchema } from '../../schema/table.js';
import { IndexConstraintOp } from '../../common/constants.js';
import { compareSqlValues } from '../../util/comparison.js';
import { createDefaultColumnSchema } from '../../schema/column.js';
import type { FilterInfo } from '../filter-info.js';

/**
 * Structure of rows returned by _schema
 */
interface SchemaRowInternal {
	type: 'table' | 'index' | 'view' | 'trigger' | 'function' | 'module';
	name: string;
	tbl_name: string;
	rootpage: number;
	sql: string | null;
	_rowid_: bigint; // Internal rowid for iteration
}

/**
 * Generates a function signature string for display
 */
function stringifyCreateFunction(func: FunctionSchema): string {
	const argsString = func.numArgs === -1
		? '...' // Indicate variable arguments
		: Array(func.numArgs).fill('?').join(', ');
	return `FUNCTION ${func.name}(${argsString})`;
}

/**
 * Virtual Table implementation for _schema
 */
class SchemaTable extends VirtualTable {
	getSchema(): TableSchema | undefined {
		const module = this.module as SchemaTableModule;
		if (!module || !SchemaTableModule.COLUMNS) {
			throw new SqliterError("SchemaTable: Module or COLUMNS not defined.", StatusCode.INTERNAL);
		}
		return {
			name: this.tableName,
			schemaName: this.schemaName,
			columns: SchemaTableModule.COLUMNS.map(c => ({...createDefaultColumnSchema(c.name), affinity: c.type, collation: c.collation })),
			columnIndexMap: new Map(Object.entries(SchemaTableModule.COLUMN_INDEX_MAP)) as ReadonlyMap<string, number>,
			primaryKeyDefinition: [],
			checkConstraints: [],
			indexes: [],
			vtabModule: this.module,
			vtabModuleName: '_schema',
			isWithoutRowid: true,
			isStrict: false,
			isView: false,
			vtabAuxData: undefined,
			vtabArgs: [],
			isTemporary: false,
			subqueryAST: undefined,
		} as TableSchema;
	}

	async xUpdate(values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint }> {
		throw new SqliterError("Cannot modify read-only table: _schema", StatusCode.READONLY);
	}

	// xBegin, xSync, xCommit, xRollback can be no-ops for a read-only schema table
	async xBegin(): Promise<void> {}
	async xSync(): Promise<void> {}
	async xCommit(): Promise<void> {}
	async xRollback(): Promise<void> {}

	async xRename(zNew: string): Promise<void> {
		throw new SqliterError("Cannot rename built-in table: _schema", StatusCode.ERROR);
	}

	// Savepoint methods can also be no-ops
	async xSavepoint(iSavepoint: number): Promise<void> {}
	async xRelease(iSavepoint: number): Promise<void> {}
	async xRollbackTo(iSavepoint: number): Promise<void> {}

	async xDisconnect(): Promise<void> {}
	async xDestroy(): Promise<void> {}

	private _generateInternalSchemaRows(db: Database): SchemaRowInternal[] {
		const schemaManager = db.schemaManager;
		let generatedRows: SchemaRowInternal[] = [];
		let rowidCounter = BigInt(0);

		const processSchemaInstance = (schemaInstance: Schema) => {
			// Process Tables
			for (const tableSchema of schemaInstance.getAllTables()) {
				if (tableSchema.name.toLowerCase() === '_schema' && tableSchema.schemaName === 'main') {
					continue;
				}
				let createSql: string | null = null;
				try {
					// Basic CREATE TABLE or CREATE VIRTUAL TABLE string construction
					// This is a simplified representation for the _schema table.
					const columnsStr = tableSchema.columns.map(c => `"${c.name}" ${c.affinity ?? SqlDataType.TEXT}`).join(', ');
					if (tableSchema.vtabModuleName) {
						const argsStr = tableSchema.vtabArgs?.join(', ') || '';
						createSql = `CREATE VIRTUAL TABLE "${tableSchema.name}" USING ${tableSchema.vtabModuleName}(${argsStr})`;
					} else {
						createSql = `CREATE TABLE "${tableSchema.name}" (${columnsStr})`;
					}
				} catch (e) {
					createSql = null; // Or some error string
				}
				generatedRows.push({
					type: tableSchema.isView ? 'view' : 'table',
					name: tableSchema.name,
					tbl_name: tableSchema.name,
					rootpage: 1, // Placeholder
					sql: createSql,
					_rowid_: rowidCounter++,
				});
			}
			// Process Functions
			for (const funcSchema of schemaInstance._getAllFunctions()) { // Assuming _getAllFunctions exists and is public for this context
				generatedRows.push({
					type: 'function',
					name: funcSchema.name,
					tbl_name: funcSchema.name, // Typically same as name for functions in sqlite_schema
					rootpage: 0, // Functions don't have root pages
					sql: stringifyCreateFunction(funcSchema),
					_rowid_: rowidCounter++,
				});
			}
			// TODO: Add Indexes, Views, Triggers, Modules if necessary for completeness
		};

		processSchemaInstance(schemaManager.getMainSchema());
		processSchemaInstance(schemaManager.getTempSchema());
		return generatedRows;
	}

	async *xQuery(filterInfo: FilterInfo): AsyncIterable<RowIdRow> {
		const allSchemaRows = this._generateInternalSchemaRows(this.db);
		const { constraints, args } = filterInfo;

		for (const internalRow of allSchemaRows) {
			let matchesAllConstraints = true;
			if (constraints && constraints.length > 0 && args && args.length > 0) {
				for (const constraintItem of constraints) {
					// FilterInfo from planner might pass all constraints from IndexInfo.aConstraint
					// Need to use filterInfo.indexInfoOutput.aConstraintUsage to know which ones are active
					const usage = filterInfo.indexInfoOutput?.aConstraintUsage?.find(u => u.argvIndex === constraintItem.argvIndex && u.argvIndex > 0);
					if (!usage || usage.omit || !constraintItem.constraint.usable || constraintItem.argvIndex <= 0) {
						continue;
					}

					const { constraint, argvIndex } = constraintItem;
					const columnIndex = constraint.iColumn;
					const op = constraint.op;
					const valueToCompare = args[argvIndex - 1];

					if (columnIndex < 0 || columnIndex >= SchemaTableModule.COLUMNS.length) {
						matchesAllConstraints = false; break;
					}
					const columnName = SchemaTableModule.COLUMNS[columnIndex].name as keyof SchemaRowInternal;
					const rowValue = internalRow[columnName];
					const comparisonResult = compareSqlValues(rowValue, valueToCompare);
					let currentConstraintMatch = false;
					switch (op) {
						case IndexConstraintOp.EQ: currentConstraintMatch = comparisonResult === 0; break;
						case IndexConstraintOp.GT: currentConstraintMatch = comparisonResult > 0; break;
						case IndexConstraintOp.LE: currentConstraintMatch = comparisonResult <= 0; break;
						case IndexConstraintOp.LT: currentConstraintMatch = comparisonResult < 0; break;
						case IndexConstraintOp.GE: currentConstraintMatch = comparisonResult >= 0; break;
						case IndexConstraintOp.NE: currentConstraintMatch = comparisonResult !== 0; break;
						case IndexConstraintOp.ISNULL: currentConstraintMatch = rowValue === null; break;
						case IndexConstraintOp.ISNOTNULL: currentConstraintMatch = rowValue !== null; break;
						case IndexConstraintOp.IS: currentConstraintMatch = (rowValue === null && valueToCompare === null) || comparisonResult === 0; break;
						case IndexConstraintOp.ISNOT: currentConstraintMatch = !((rowValue === null && valueToCompare === null) || comparisonResult === 0); break;
						default: matchesAllConstraints = false; break; // Should not happen if op is valid
					}
					if (!currentConstraintMatch || !matchesAllConstraints) {
						matchesAllConstraints = false; break;
					}
				}
			}

			if (matchesAllConstraints) {
				// Convert SchemaRowInternal to Row for yielding
				const outputRow: Row = [
					internalRow.type,
					internalRow.name,
					internalRow.tbl_name,
					internalRow.rootpage,
					internalRow.sql
				];
				yield [internalRow._rowid_, outputRow];
			}
		}
	}
}

/**
 * Module implementation for _schema virtual table
 */
export class SchemaTableModule implements VirtualTableModule<SchemaTable> {
	static readonly COLUMNS = [
		{ name: 'type', type: SqlDataType.TEXT, collation: 'BINARY' },
		{ name: 'name', type: SqlDataType.TEXT, collation: 'BINARY' },
		{ name: 'tbl_name', type: SqlDataType.TEXT, collation: 'BINARY' },
		{ name: 'rootpage', type: SqlDataType.INTEGER, collation: 'BINARY' },
		{ name: 'sql', type: SqlDataType.TEXT, collation: 'BINARY' },
	];
	static readonly COLUMN_INDEX_MAP: Record<string, number> = Object.fromEntries(
		this.COLUMNS.map((col, i) => [col.name, i])
	);

	constructor() {}

	xCreate(_db: Database, _pAux: unknown, _moduleName: string, schemaName: string, tableName: string, _options: BaseModuleConfig): SchemaTable {
		return new SchemaTable(_db, this, schemaName, tableName);
	}

	xConnect(_db: Database, _pAux: unknown, _moduleName: string, schemaName: string, tableName: string, _options: BaseModuleConfig): SchemaTable {
		return new SchemaTable(_db, this, schemaName, tableName);
	}

	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		// For _schema, we always do a full scan, but we can utilize constraints.
		// This xBestIndex (on the module) is called for query planning.
		indexInfo.idxNum = 0; // Using 0 to indicate a scan that will use filterInfo for xQuery
		indexInfo.estimatedCost = 1000.0; // Default cost for a scan
		indexInfo.estimatedRows = BigInt(100); // Arbitrary estimate
		indexInfo.orderByConsumed = false;
		indexInfo.idxFlags = 0;

		// Populate aConstraintUsage to inform SQLite which constraints can be handled by xQuery
		let argvIndex = 1;
		indexInfo.aConstraintUsage = indexInfo.aConstraint.map(constraint => {
			if (constraint.usable) {
				// Check if the column index is valid for our known columns
				if (constraint.iColumn >= 0 && constraint.iColumn < SchemaTableModule.COLUMNS.length) {
					return { argvIndex: argvIndex++, omit: false }; // We will handle it, SQLite doesn't need to omit
				}
			}
			return { argvIndex: 0, omit: true }; // Not usable by us or invalid column
		});
		indexInfo.idxStr = "_schema_filtered_scan_by_xQuery"; // Indicate xQuery will handle filtering
		return StatusCode.OK;
	}

	async xDestroy(_db: Database, _pAux: unknown, _moduleName: string, _schemaName: string, _tableName: string): Promise<void> {
		return Promise.resolve();
	}

	xShadowName?(_name: string): boolean {
		return false;
	}
}
