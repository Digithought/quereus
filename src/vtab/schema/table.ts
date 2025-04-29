import { VirtualTable } from '../table.js';
import { VirtualTableCursor } from '../cursor.js';
import type { VirtualTableModule, BaseModuleConfig } from '../module.js';
import type { IndexInfo } from '../indexInfo.js';
import { StatusCode, SqlDataType, type SqlValue } from '../../common/types.js';
import { SqliteError } from '../../common/errors.js';
import type { Database } from '../../core/database.js';
import type { SqliteContext } from '../../func/context.js';
import type { Schema } from '../../schema/schema.js';
import type { FunctionSchema } from '../../schema/function.js';
import type { TableSchema } from '../../schema/table.js';
import type { IndexConstraint } from '../indexInfo.js';

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
	return `FUNCTION ${func.name}(${Array(func.numArgs).fill('?').join(', ')})`;
}

/**
 * Virtual Table implementation for sqlite_schema
 */
class SchemaTable extends VirtualTable {
	async xOpen(): Promise<SchemaTableCursor<this>> {
		return new SchemaTableCursor(this);
	}

	xBestIndex(indexInfo: IndexInfo): number {
		// Always a full table scan
		indexInfo.idxNum = 0;
		indexInfo.estimatedCost = 1000.0;
		indexInfo.estimatedRows = BigInt(100);
		indexInfo.orderByConsumed = false;
		indexInfo.idxFlags = 0;
		indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		indexInfo.idxStr = "fullscan";
		return StatusCode.OK;
	}

	async xUpdate(values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint }> {
		throw new SqliteError("Cannot modify read-only table: sqlite_schema", StatusCode.READONLY);
	}

	async xBegin(): Promise<void> {}
	async xSync(): Promise<void> {}
	async xCommit(): Promise<void> {}
	async xRollback(): Promise<void> {}

	async xRename(zNew: string): Promise<void> {
		throw new SqliteError("Cannot rename built-in table: sqlite_schema", StatusCode.ERROR);
	}

	async xSavepoint(iSavepoint: number): Promise<void> {}
	async xRelease(iSavepoint: number): Promise<void> {}
	async xRollbackTo(iSavepoint: number): Promise<void> {}

	xShadowName?(name: string): boolean {
		return false;
	}

	async xDisconnect(): Promise<void> {}
	async xDestroy(): Promise<void> {}
}

/**
 * Cursor for iterating over sqlite_schema rows
 */
class SchemaTableCursor<T extends SchemaTable> extends VirtualTableCursor<T> {
	private schemaRows: SchemaRow[] = [];
	private currentIndex: number = -1;

	constructor(table: T) {
		super(table);
	}

	reset(): void {
		this.schemaRows = [];
		this.currentIndex = -1;
		this._isEof = true;
	}

	setResults(results: SchemaRow[]): void {
		this.schemaRows = results;
		this.currentIndex = -1;
		this._isEof = this.schemaRows.length === 0;
		if (!this._isEof) {
			this.currentIndex = 0;
		}
	}

	getCurrentRow(): SchemaRow | null {
		if (this._isEof || this.currentIndex < 0 || this.currentIndex >= this.schemaRows.length) {
			return null;
		}
		return this.schemaRows[this.currentIndex];
	}

	getCurrentRowId(): bigint | null {
		const row = this.getCurrentRow();
		return row?._rowid_ ?? null;
	}

	async filter(idxNum: number, idxStr: string | null, constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>, args: ReadonlyArray<SqlValue>): Promise<void> {
		this.reset();
		const db = this.table.db;
		const schemaManager = db.schemaManager;
		const generatedRows: SchemaRow[] = [];
		let rowidCounter = BigInt(0);

		const processSchema = (schema: Schema) => {
			// Process Tables
			for (const tableSchema of schema.getAllTables()) {
				// Skip the schema table itself
				if (tableSchema.name.toLowerCase() === 'sqlite_schema' && tableSchema.schemaName === 'main') {
					continue;
				}

				let createSql: string | null = null;
				try {
					// Basic representation for virtual tables
					createSql = `CREATE TABLE "${tableSchema.name}" USING ${tableSchema.vtabModuleName}(...)`;
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

			// Process Functions
			for (const funcSchema of schema._getAllFunctions()) {
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

		// Iterate through schemas
		processSchema(schemaManager.getMainSchema());
		processSchema(schemaManager.getTempSchema());

		this.setResults(generatedRows);
	}

	async next(): Promise<void> {
		if (this._isEof) return;

		if (this.currentIndex >= this.schemaRows.length - 1) {
			this._isEof = true;
			this.currentIndex = this.schemaRows.length;
		} else {
			this.currentIndex++;
			this._isEof = false;
		}
	}

	column(context: SqliteContext, columnIndex: number): number {
		const row = this.getCurrentRow();
		if (!row) {
			context.resultNull();
			return StatusCode.OK;
		}

		const columnName = SchemaTableModule.COLUMNS[columnIndex]?.name;

		switch (columnName) {
			case 'type':
				context.resultText(row.type);
				break;
			case 'name':
				context.resultText(row.name);
				break;
			case 'tbl_name':
				context.resultText(row.tbl_name);
				break;
			case 'rootpage':
				context.resultInt(row.rootpage);
				break;
			case 'sql':
				if (row.sql === null) {
					context.resultNull();
				} else {
					context.resultText(row.sql);
				}
				break;
			default:
				if (columnIndex === -1) {
					context.resultInt64(row._rowid_);
				} else {
					context.resultError(`Invalid column index ${columnIndex} for sqlite_schema`, StatusCode.RANGE);
					return StatusCode.RANGE;
				}
				break;
		}
		return StatusCode.OK;
	}

	async rowid(): Promise<bigint> {
		const rowid = this.getCurrentRowId();
		if (rowid === null) {
			throw new SqliteError("Cursor is not pointing to a valid schema row", StatusCode.MISUSE);
		}
		return rowid;
	}

	async close(): Promise<void> {
		this.reset();
	}
}

/**
 * Module implementation for sqlite_schema virtual table
 */
export class SchemaTableModule implements VirtualTableModule<SchemaTable, SchemaTableCursor<SchemaTable>> {
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

	xCreate(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: BaseModuleConfig): SchemaTable {
		return new SchemaTable(db, this, schemaName, tableName);
	}

	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: BaseModuleConfig): SchemaTable {
		return new SchemaTable(db, this, schemaName, tableName);
	}

	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		indexInfo.idxNum = 0;
		indexInfo.estimatedCost = 1000.0;
		indexInfo.estimatedRows = BigInt(100);
		indexInfo.orderByConsumed = false;
		indexInfo.idxFlags = 0;
		indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		indexInfo.idxStr = "fullscan";
		return StatusCode.OK;
	}

	async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		return Promise.resolve();
	}

	xShadowName?(name: string): boolean {
		return false;
	}
}
