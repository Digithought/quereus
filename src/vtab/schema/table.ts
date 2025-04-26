import { VirtualTable } from '../table';
import { VirtualTableCursor } from '../cursor';
import type { VirtualTableModule, BaseModuleConfig } from '../module';
import type { IndexInfo } from '../indexInfo';
import { StatusCode, SqlDataType, type SqlValue } from '../../common/types';
import { SqliteError } from '../../common/errors';
import type { Database } from '../../core/database';
import type { SqliteContext } from '../../func/context';
import type { Schema } from '../../schema/schema';
import type { FunctionSchema } from '../../schema/function';
import type { TableSchema } from '../../schema/table';
import type { IndexConstraint } from '../indexInfo';

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
	// --- Implement methods from VirtualTable ---

	async xOpen(): Promise<VirtualTableCursor<this, any>> {
		// Just create and return the cursor instance
		return new SchemaTableCursor(this) as unknown as VirtualTableCursor<this, any>;
	}

	xBestIndex(indexInfo: IndexInfo): number {
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

	async xUpdate(values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint }> {
		// This table is read-only
		throw new SqliteError("Cannot modify read-only table: sqlite_schema", StatusCode.READONLY);
	}

	// --- Optional transaction methods ---
	// These are likely no-ops as the schema table reflects current state
	async xBegin(): Promise<void> {}
	async xSync(): Promise<void> {}
	async xCommit(): Promise<void> {}
	async xRollback(): Promise<void> {}

	// --- Optional rename ---
	async xRename(zNew: string): Promise<void> {
		throw new SqliteError("Cannot rename built-in table: sqlite_schema", StatusCode.ERROR);
	}

	// --- Optional savepoint methods ---
	async xSavepoint(iSavepoint: number): Promise<void> {}
	async xRelease(iSavepoint: number): Promise<void> {}
	async xRollbackTo(iSavepoint: number): Promise<void> {}

	// --- Optional shadow name check ---
	xShadowName?(name: string): boolean {
		// sqlite_schema itself is not a shadow name for other tables
		return false;
	}

	// Disconnect/Destroy are no-ops for this internal table
	async xDisconnect(): Promise<void> {
		console.log(`Schema table '${this.tableName}' connection instance disconnected`);
	}
	async xDestroy(): Promise<void> {
		console.warn(`Attempted to destroy schema table '${this.tableName}'`);
	}

	// -----------------------------------------
}

/**
 * Cursor for iterating over the generated schema rows.
 */
class SchemaTableCursor extends VirtualTableCursor<SchemaTable, SchemaTableCursor> {
	private schemaRows: SchemaRow[] = [];
	private currentIndex: number = -1;

	constructor(table: SchemaTable) {
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
						// Note: we've changed the syntax to CREATE TABLE ... USING ...
						createSql = `CREATE TABLE "${tableSchema.name}" USING ${tableSchema.vtabModuleName}(...)`;
					} else if (!tableSchema.isVirtual) {
						// Attempt to stringify standard tables (might need ddl-stringify)
						// For now, leave null if complex
						// createSql = stringifyCreateTable(tableSchema); // Placeholder
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

		this.setResults(generatedRows);
	}

	async next(): Promise<void> {
		if (this._isEof) return; // Already at end

		if (this.currentIndex >= this.schemaRows.length - 1) {
			this._isEof = true;
			this.currentIndex = this.schemaRows.length; // Position after the end
		} else {
			this.currentIndex++;
			this._isEof = false;
		}
	}

	column(context: SqliteContext, columnIndex: number): number {
		const row = this.getCurrentRow();
		if (!row) {
			// Should not happen if VDBE checks eof() before calling column(), but handle defensively
			context.resultNull();
			return StatusCode.OK;
		}

		// Find column name by index (more robust than assuming order)
		// Use SchemaTableModule static property for column definitions
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

	async rowid(): Promise<bigint> {
		const rowid = this.getCurrentRowId();
		if (rowid === null) {
			throw new SqliteError("Cursor is not pointing to a valid schema row", StatusCode.MISUSE);
		}
		return rowid;
	}

	async close(): Promise<void> {
		this.reset(); // Clear internal state
		// No external resources to release
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
		console.log(`SchemaTableModule xCreate: ${schemaName}.${tableName}`);
		// xCreate and xConnect return the same lightweight object for this read-only table
		return new SchemaTable(db, this, schemaName, tableName);
	}

	xConnect(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string, options: BaseModuleConfig): SchemaTable {
		console.log(`SchemaTableModule xConnect: ${schemaName}.${tableName}`);
		return new SchemaTable(db, this, schemaName, tableName);
	}

	// Add missing xBestIndex implementation to the module
	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
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

	// Add missing xDestroy implementation to the module (no-op)
	async xDestroy(db: Database, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		console.warn(`Attempted to destroy built-in schema table definition '${tableName}' via module.`);
		// No persistent state to destroy for the module itself
		return Promise.resolve();
	}

	// Instance-specific methods are now on SchemaTable

	// --- Optional shadow name check ---
	xShadowName?(name: string): boolean {
		// sqlite_schema itself is not a shadow name for other tables
		return false;
	}
}
