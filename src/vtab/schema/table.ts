import { VirtualTable } from '../table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../module.js';
import type { IndexInfo } from '../indexInfo.js';
import { StatusCode, SqlDataType, type SqlValue, type Row, type RowIdRow } from '../../common/types.js';
import { SqliterError } from '../../common/errors.js';
import type { Database } from '../../core/database.js';
import type { Schema } from '../../schema/schema.js';
import type { FunctionSchema } from '../../schema/function.js';
import type { TableSchema } from '../../schema/table.js';
import type { IndexConstraint } from '../indexInfo.js';
import { IndexConstraintOp } from '../../common/constants.js';
import { compareSqlValues } from '../../util/comparison.js';
import { createDefaultColumnSchema } from '../../schema/column.js';
import type { FilterInfo } from '../filter-info.js';

/**
 * Structure of rows returned by sqlite_schema
 */
interface SchemaRow {
	type: 'table' | 'index' | 'view' | 'trigger' | 'function' | 'module';
	name: string;
	tbl_name: string;
	rootpage: number;
	sql: string | null;
	_rowid_: bigint;
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
 * Virtual Table implementation for sqlite_schema
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
			vtabModuleName: 'sqlite_schema',
			isWithoutRowid: true,
			isStrict: false,
			isView: false,
			vtabAuxData: undefined,
			vtabArgs: [],
			isTemporary: false,
			subqueryAST: undefined,
		} as TableSchema;
	}

	xBestIndex(indexInfo: IndexInfo): number {
		indexInfo.idxNum = 0;
		indexInfo.estimatedCost = 1000.0;
		indexInfo.estimatedRows = BigInt(100);
		indexInfo.orderByConsumed = false;
		indexInfo.idxFlags = 0;

		let currentArgvIndex = 1;
		indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, (_, i) => {
			const constraint = indexInfo.aConstraint[i];
			if (constraint.usable) {
				return { argvIndex: currentArgvIndex++, omit: false };
			}
			return { argvIndex: 0, omit: false };
		});
		indexInfo.idxStr = "filtered_scan";
		return StatusCode.OK;
	}

	async xUpdate(values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint }> {
		throw new SqliterError("Cannot modify read-only table: sqlite_schema", StatusCode.READONLY);
	}

	async xBegin(): Promise<void> {}
	async xSync(): Promise<void> {}
	async xCommit(): Promise<void> {}
	async xRollback(): Promise<void> {}

	async xRename(zNew: string): Promise<void> {
		throw new SqliterError("Cannot rename built-in table: sqlite_schema", StatusCode.ERROR);
	}

	async xSavepoint(iSavepoint: number): Promise<void> {}
	async xRelease(iSavepoint: number): Promise<void> {}
	async xRollbackTo(iSavepoint: number): Promise<void> {}

	async xDisconnect(): Promise<void> {}
	async xDestroy(): Promise<void> {}

	private async* _generateSchemaRows(filterInfo: FilterInfo): AsyncIterable<SchemaRow> {
		const { constraints, args } = filterInfo;
		const db = this.db;
		const schemaManager = db.schemaManager;
		let generatedRows: SchemaRow[] = [];
		let rowidCounter = BigInt(0);

		const processSchema = (schemaInstance: Schema) => {
			for (const tableSchema of schemaInstance.getAllTables()) {
				if (tableSchema.name.toLowerCase() === 'sqlite_schema' && tableSchema.schemaName === 'main') {
					continue;
				}
				let createSql: string | null = null;
				try {
					createSql = tableSchema.vtabModuleName
						? `CREATE VIRTUAL TABLE "${tableSchema.name}" USING ${tableSchema.vtabModuleName}(...)`
						: `CREATE TABLE "${tableSchema.name}"(...)`;
				} catch (e) {
					createSql = null;
				}
				generatedRows.push({
					type: 'table',
					name: tableSchema.name,
					tbl_name: tableSchema.name,
					rootpage: 1,
					sql: createSql,
					_rowid_: rowidCounter++,
				});
			}
			for (const funcSchema of schemaInstance._getAllFunctions()) {
				generatedRows.push({
					type: 'function',
					name: funcSchema.name,
					tbl_name: funcSchema.name,
					rootpage: 0,
					sql: stringifyCreateFunction(funcSchema),
					_rowid_: rowidCounter++,
				});
			}
		};

		processSchema(schemaManager.getMainSchema());
		processSchema(schemaManager.getTempSchema());

		for (const schemaRow of generatedRows) {
			let matchesAllConstraints = true;
			for (const { constraint, argvIndex } of constraints) {
				if (constraint.usable === false || argvIndex <= 0) continue;
				const columnIndex = constraint.iColumn;
				const op = constraint.op;
				const valueToCompare = args[argvIndex - 1];

				if (columnIndex < 0 || columnIndex >= SchemaTableModule.COLUMNS.length) {
					matchesAllConstraints = false; break;
				}
				const columnName = SchemaTableModule.COLUMNS[columnIndex].name as keyof SchemaRow;
				const rowValue = schemaRow[columnName];
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
					default: matchesAllConstraints = false; break;
				}
				if (!currentConstraintMatch) { matchesAllConstraints = false; break; }
			}
			if (matchesAllConstraints) {
				yield schemaRow;
			}
		}
	}

	async* xQuery(filterInfo: FilterInfo): AsyncIterable<RowIdRow> {
		for await (const schemaRow of this._generateSchemaRows(filterInfo)) {
			const row: SqlValue[] = [
				schemaRow.type,
				schemaRow.name,
				schemaRow.tbl_name,
				schemaRow.rootpage,
				schemaRow.sql
			];
			yield [schemaRow._rowid_, row];
		}
	}
}

/**
 * Module implementation for sqlite_schema virtual table
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

	xBestIndex(_db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		const table = new SchemaTable(_db, this, tableInfo.schemaName, tableInfo.name);
		return table.xBestIndex(indexInfo);
	}

	async xDestroy(_db: Database, _pAux: unknown, _moduleName: string, _schemaName: string, _tableName: string): Promise<void> {
		return Promise.resolve();
	}

	xShadowName?(_name: string): boolean {
		return false;
	}
}
