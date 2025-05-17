import { VirtualTable } from '../table.js';
import { VirtualTableCursor } from '../cursor.js';
import type { VirtualTableModule, BaseModuleConfig } from '../module.js';
import type { IndexInfo } from '../indexInfo.js';
import { StatusCode, SqlDataType, type SqlValue, type Row } from '../../common/types.js';
import { SqliteError } from '../../common/errors.js';
import type { Database } from '../../core/database.js';
import type { SqliteContext } from '../../func/context.js';
import type { Schema } from '../../schema/schema.js';
import type { FunctionSchema } from '../../schema/function.js';
import type { TableSchema } from '../../schema/table.js';
import type { IndexConstraint } from '../indexInfo.js';
import { IndexConstraintOp } from '../../common/constants.js';
import { compareSqlValues } from '../../util/comparison.js';
import { createDefaultColumnSchema } from '../../schema/column.js';

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
	async xOpen(): Promise<SchemaTableCursor<this>> {
		return new SchemaTableCursor(this);
	}

	getSchema(): TableSchema | undefined {
		const module = this.module as SchemaTableModule;
		if (!module || !SchemaTableModule.COLUMNS) {
			throw new SqliteError("SchemaTable: Module or COLUMNS not defined.", StatusCode.INTERNAL);
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

	async* xQuery(filterInfo: import('../filter-info.js').FilterInfo): AsyncIterable<[bigint, Row]> {
		const { constraints, args } = filterInfo;

		// Use the cursor's internal generator directly.
		const cursor = new SchemaTableCursor(this); // Transient cursor
		const internalGenerator = cursor['_internalIteratorGenerator'](constraints, args);

		for await (const schemaRow of internalGenerator) {
			if (!schemaRow) continue;
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
 * Cursor for iterating over sqlite_schema rows
 */
class SchemaTableCursor<T extends SchemaTable> extends VirtualTableCursor<T> {
	private schemaRowsData: SchemaRow[] = [];
	private currentIndex: number = -1;
	private internalIterator: AsyncIterator<SchemaRow | null> | null = null;
	private currentFilteredRows: SchemaRow[] = [];
	private currentIteratorIndex: number = -1;

	constructor(table: T) {
		super(table);
	}

	private async* _internalIteratorGenerator(constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>, args: ReadonlyArray<SqlValue>): AsyncIterable<SchemaRow> {
		const db = this.table.db;
		const schemaManager = db.schemaManager;
		let generatedRows: SchemaRow[] = [];
		let rowidCounter = BigInt(0);

		const processSchema = (schema: Schema) => {
			// Process Tables
			for (const tableSchema of schema.getAllTables()) {
				if (tableSchema.name.toLowerCase() === 'sqlite_schema' && tableSchema.schemaName === 'main') {
					continue;
				}
				let createSql: string | null = null;
				try {
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

		processSchema(schemaManager.getMainSchema());
		processSchema(schemaManager.getTempSchema());

		if (constraints.length > 0 && args.length > 0) {
			generatedRows = generatedRows.filter(row => {
				for (const { constraint, argvIndex } of constraints) {
					if (constraint.usable === false || argvIndex <= 0) continue;
					const columnIndex = constraint.iColumn;
					const op = constraint.op;
					const valueToCompare = args[argvIndex - 1];
					if (columnIndex < 0 || columnIndex >= SchemaTableModule.COLUMNS.length) return false;
					const columnName = SchemaTableModule.COLUMNS[columnIndex].name as keyof SchemaRow;
					const rowValue = row[columnName];
					const comparisonResult = compareSqlValues(rowValue, valueToCompare);
					let match = false;
					switch (op) {
						case IndexConstraintOp.EQ: match = comparisonResult === 0; break;
						case IndexConstraintOp.GT: match = comparisonResult > 0; break;
						case IndexConstraintOp.LE: match = comparisonResult <= 0; break;
						case IndexConstraintOp.LT: match = comparisonResult < 0; break;
						case IndexConstraintOp.GE: match = comparisonResult >= 0; break;
						case IndexConstraintOp.NE: match = comparisonResult !== 0; break;
						case IndexConstraintOp.ISNULL: match = rowValue === null; break;
						case IndexConstraintOp.ISNOTNULL: match = rowValue !== null; break;
						case IndexConstraintOp.IS: match = (rowValue === null && valueToCompare === null) || comparisonResult === 0; break;
						case IndexConstraintOp.ISNOT: match = !((rowValue === null && valueToCompare === null) || comparisonResult === 0); break;
						default: return false;
					}
					if (!match) return false;
				}
				return true;
			});
		}
		for (const row of generatedRows) {
			yield row;
		}
	}

	reset(): void {
		this.schemaRowsData = [];
		this.currentIndex = -1;
		this._isEof = true;
		this.internalIterator = null;
		this.currentFilteredRows = [];
		this.currentIteratorIndex = -1;
	}

	getCurrentRow(): SchemaRow | null {
		if (this._isEof || this.currentIteratorIndex < 0 || this.currentIteratorIndex >= this.currentFilteredRows.length) {
			return null;
		}
		return this.currentFilteredRows[this.currentIteratorIndex];
	}

	getCurrentRowId(): bigint | null {
		const row = this.getCurrentRow();
		return row?._rowid_ ?? null;
	}

	async filter(idxNum: number, idxStr: string | null, constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>, args: ReadonlyArray<SqlValue>): Promise<void> {
		this.reset();
		this.internalIterator = this._internalIteratorGenerator(constraints, args)[Symbol.asyncIterator]();

		let result = await this.internalIterator.next();
		while (!result.done) {
			if (result.value) {
				this.currentFilteredRows.push(result.value);
			}
			result = await this.internalIterator.next();
		}

		if (this.currentFilteredRows.length > 0) {
			this.currentIteratorIndex = 0;
			this._isEof = false;
		} else {
			this._isEof = true;
		}
	}

	async next(): Promise<void> {
		if (this._isEof) return;

		this.currentIteratorIndex++;
		if (this.currentIteratorIndex >= this.currentFilteredRows.length) {
			this._isEof = true;
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
		return Promise.resolve(rowid);
	}

	async* rows(): AsyncIterable<Row> {
		if (this.eof()) {
			return;
		}

		while (!this.eof()) {
			const currentSchemaRow = this.getCurrentRow();
			if (!currentSchemaRow) {
				// This might happen if next() was called and eof became true
				// but the loop condition hadn't checked yet.
				break;
			}

			const row: SqlValue[] = [];
			const columnDefinitions = SchemaTableModule.COLUMNS;

			for (const colDef of columnDefinitions) {
				switch (colDef.name as keyof SchemaRow) {
					case 'type':
						row.push(currentSchemaRow.type);
						break;
					case 'name':
						row.push(currentSchemaRow.name);
						break;
					case 'tbl_name':
						row.push(currentSchemaRow.tbl_name);
						break;
					case 'rootpage':
						row.push(currentSchemaRow.rootpage);
						break;
					case 'sql':
						row.push(currentSchemaRow.sql);
						break;
					// _rowid_ is not a standard column, handled by rowid()
					default:
						// Should not happen if COLUMNS is aligned with SchemaRow
						row.push(null);
				}
			}
			yield row;
			await this.next();
		}
	}

	async close(): Promise<void> {
		this.reset();
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

	xBestIndex(_db: Database, _tableInfo: TableSchema, indexInfo: IndexInfo): number {
		console.log(`[sqlite_schema] xBestIndex called. nConstraint: ${indexInfo.nConstraint}`);
		indexInfo.idxNum = 0;
		indexInfo.estimatedCost = 1000.0;
		indexInfo.estimatedRows = BigInt(100);
		indexInfo.orderByConsumed = false;
		indexInfo.idxFlags = 0;
		indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, (_, i) => ({ argvIndex: i + 1, omit: false }));
		indexInfo.idxStr = "fullscan";
		return StatusCode.OK;
	}

	async xDestroy(_db: Database, _pAux: unknown, _moduleName: string, _schemaName: string, _tableName: string): Promise<void> {
		return Promise.resolve();
	}

	xShadowName?(_name: string): boolean {
		return false;
	}
}
