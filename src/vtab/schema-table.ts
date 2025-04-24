import { VirtualTable } from './table';
import { VirtualTableCursor } from './cursor';
import type { VirtualTableModule, BaseModuleConfig } from './module';
import type { IndexInfo } from './indexInfo';
import { StatusCode, SqlDataType } from '../common/types';
import { SqliteError } from '../common/errors';
import type { Database } from '../core/database';
import type { SqliteContext } from '../func/context';
import type { SqlValue } from '../common/types';
import type { Schema } from '../schema/schema';
import type { TableSchema } from '../schema/table';
import type { FunctionSchema } from '../schema/function';
import { stringifyCreateTable } from '../util/ddl-stringify'; // Helper for SQL generation

// Define the structure of rows returned by sqlite_schema
interface SchemaRow {
	type: 'table' | 'index' | 'view' | 'trigger' | 'function' | 'module';
	name: string;
	tbl_name: string;
	rootpage: number;
	sql: string | null;
	_rowid_: bigint; // Internal rowid for cursor tracking
}

// --- Simple helper to generate function signature ---
function stringifyCreateFunction(func: FunctionSchema): string {
	// Basic representation, could be enhanced
	return `FUNCTION ${func.name}(${Array(func.numArgs).fill('?').join(', ')})`;
}
// --------------------------------------------------

/**
 * Virtual Table instance for sqlite_schema. Doesn't hold much state itself.
 */
class SchemaTable extends VirtualTable {
	// No specific state needed for the table instance itself
}

/**
 * Cursor for iterating over the generated schema rows.
 */
class SchemaTableCursor extends VirtualTableCursor<SchemaTable> {
	private schemaRows: SchemaRow[] = [];
	private currentIndex: number = -1;
	private isEof: boolean = true;

	constructor(table: SchemaTable) {
		super(table);
	}

	reset(): void {
		this.schemaRows = [];
		this.currentIndex = -1;
		this.isEof = true;
	}

	setResults(results: SchemaRow[]): void {
		this.schemaRows = results;
		this.currentIndex = -1;
		this.isEof = this.schemaRows.length === 0;
		if (!this.isEof) {
			this.advance(); // Move to the first valid row
		}
	}

	getCurrentRow(): SchemaRow | null {
		if (this.isEof || this.currentIndex < 0 || this.currentIndex >= this.schemaRows.length) {
			return null;
		}
		return this.schemaRows[this.currentIndex];
	}

	getCurrentRowId(): bigint | null {
		const row = this.getCurrentRow();
		return row?._rowid_ ?? null;
	}

	advance(): void {
		if (this.currentIndex >= this.schemaRows.length - 1) {
			this.isEof = true;
			this.currentIndex = this.schemaRows.length; // Position after the end
		} else {
			this.currentIndex++;
			this.isEof = false;
		}
	}

	eof(): boolean {
		return this.isEof;
	}
}

/**
 * Virtual table module implementation for sqlite_schema.
 */
export class SchemaTableModule implements VirtualTableModule<SchemaTable, SchemaTableCursor> {
	// Define the columns for the sqlite_schema table
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
		// xCreate might not be called if we handle it dynamically via SchemaManager
		console.log(`SchemaTableModule xCreate: ${schemaName}.${tableName}`);
		return new SchemaTable(db, this, schemaName, tableName);
	}

	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: BaseModuleConfig): SchemaTable {
		console.log(`SchemaTableModule xConnect: ${schemaName}.${tableName}`);
		// Connect simply returns a new instance, state is transient per-query
		return new SchemaTable(db, this, schemaName, tableName);
	}

	async xDisconnect(table: SchemaTable): Promise<void> {
		// No persistent state to clean up
		console.log(`Schema table '${table.tableName}' disconnected`);
	}

	async xDestroy(table: SchemaTable): Promise<void> {
		// Should not be called as it's built-in
		console.warn(`Attempted to destroy schema table '${table.tableName}'`);
	}

	async xOpen(table: SchemaTable): Promise<SchemaTableCursor> {
		return new SchemaTableCursor(table);
	}

	async xClose(cursor: SchemaTableCursor): Promise<void> {
		cursor.reset();
	}

	xBestIndex(table: SchemaTable, indexInfo: IndexInfo): number {
		// Always a full table scan. No constraints or ordering supported.
		indexInfo.idxNum = 0; // Plan 0: Full scan
		indexInfo.estimatedCost = 1000.0; // Arbitrary high cost for full scan
		indexInfo.estimatedRows = BigInt(100); // Estimate ~100 schema objects
		indexInfo.orderByConsumed = false; // No ordering provided
		indexInfo.idxFlags = 0;
		// Indicate no constraints are used
		indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: false }));
		indexInfo.idxStr = "fullscan";
		return StatusCode.OK;
	}

	async xFilter(cursor: SchemaTableCursor, idxNum: number, idxStr: string | null, args: ReadonlyArray<SqlValue>): Promise<void> {
		cursor.reset();
		const db = cursor.table.db;
		const schemaManager = db.schemaManager;
		const generatedRows: SchemaRow[] = [];
		let rowidCounter = BigInt(0);

		const processSchema = (schema: Schema) => {
			// Process Tables
			for (const tableSchema of schema.getAllTables()) {
				// Skip the schema table itself if it somehow appears in the list
				if (tableSchema.name.toLowerCase() === 'sqlite_schema' && tableSchema.schemaName === 'main') {
					continue;
				}

				let createSql: string | null = null;
				try {
					// Generate CREATE statement SQL if possible
					if (tableSchema.isVirtual && tableSchema.vtabModuleName) {
						// Basic representation for virtual tables without original AST
						// TODO: Capture original arguments for better representation
						createSql = `create table ${tableSchema.name} using ${tableSchema.vtabModuleName}(...)`;
					}
				} catch (e) {
					console.warn(`Failed to stringify CREATE TABLE for ${tableSchema.name}:`, e);
				}

				generatedRows.push({
					type: 'table', // TODO: Differentiate views/indexes later
					name: tableSchema.name,
					tbl_name: tableSchema.name,
					rootpage: 1, // Use 1 for tables
					sql: createSql,
					_rowid_: rowidCounter++,
				});
			}

			// Process Functions (only non-internal ones?)
			for (const funcSchema of schema._getAllFunctions()) {
				// Maybe filter internal/built-in functions? For now, list all.
				generatedRows.push({
					type: 'function',
					name: funcSchema.name,
					tbl_name: funcSchema.name, // Use name for tbl_name for functions
					rootpage: 0, // Use 0 for functions/non-tables
					sql: stringifyCreateFunction(funcSchema), // Generate signature
					_rowid_: rowidCounter++,
				});
			}

            // TODO: Add modules? Indexes? Triggers? Views?
		};

		// Iterate through 'main' and 'temp' schemas
		processSchema(schemaManager.getMainSchema());
		processSchema(schemaManager.getTempSchema());
        // TODO: Iterate attached schemas if/when they are implemented

		cursor.setResults(generatedRows);
	}

	async xNext(cursor: SchemaTableCursor): Promise<void> {
		cursor.advance();
	}

	async xEof(cursor: SchemaTableCursor): Promise<boolean> {
		return cursor.eof();
	}

	xColumn(cursor: SchemaTableCursor, context: SqliteContext, columnIndex: number): number {
		const row = cursor.getCurrentRow();
		if (!row) {
			context.resultNull(); // Should not happen if xEof is checked
			return StatusCode.OK;
		}

		// Find column name by index (more robust than assuming order)
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
				// Handle -1 rowid request or invalid index
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

	async xRowid(cursor: SchemaTableCursor): Promise<bigint> {
		const rowid = cursor.getCurrentRowId();
		if (rowid === null) {
			throw new SqliteError("Cursor is not pointing to a valid schema row", StatusCode.MISUSE);
		}
		return rowid;
	}

	async xUpdate(table: SchemaTable, values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint }> {
		// This table is read-only
		throw new SqliteError("Cannot modify read-only table: sqlite_schema", StatusCode.READONLY);
	}

	// --- Optional transaction methods ---
	// These are likely no-ops as the schema table reflects current state
	async xBegin(table: SchemaTable): Promise<void> {}
	async xSync(table: SchemaTable): Promise<void> {}
	async xCommit(table: SchemaTable): Promise<void> {}
	async xRollback(table: SchemaTable): Promise<void> {}

	// --- Optional rename ---
	async xRename(table: SchemaTable, zNew: string): Promise<void> {
		throw new SqliteError("Cannot rename built-in table: sqlite_schema", StatusCode.ERROR);
	}

	// --- Optional savepoint methods ---
	async xSavepoint(table: SchemaTable, iSavepoint: number): Promise<void> {}
	async xRelease(table: SchemaTable, iSavepoint: number): Promise<void> {}
	async xRollbackTo(table: SchemaTable, iSavepoint: number): Promise<void> {}

	// --- Optional shadow name check ---
	xShadowName?(name: string): boolean {
		// sqlite_schema itself is not a shadow name for other tables
		return false;
	}
}
