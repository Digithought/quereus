import { VirtualTable } from '../table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../module.js';
import type { IndexInfo } from '../index-info.js';
import { StatusCode, SqlDataType, type SqlValue, type Row, type RowIdRow } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import type { Database } from '../../core/database.js';
import type { Schema } from '../../schema/schema.js';
import type { FunctionSchema } from '../../schema/function.js';
import type { TableSchema } from '../../schema/table.js';
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
			throw new QuereusError("SchemaTable: Module or COLUMNS not defined.", StatusCode.INTERNAL);
		}
		return {
			name: this.tableName,
			schemaName: this.schemaName,
			columns: SchemaTableModule.COLUMNS.map(c => ({...createDefaultColumnSchema(c.name), affinity: c.type, collation: c.collation })),
			columnIndexMap: new Map(Object.entries(SchemaTableModule.COLUMN_INDEX_MAP)) as ReadonlyMap<string, number>,
			primaryKeyDefinition: [{ index: 0 }, { index: 1 }],
			checkConstraints: [],
			indexes: [],
			vtabModule: this.module,
			vtabModuleName: '_schema',
			isWithoutRowid: true,
			isStrict: false,
			isView: false,
			vtabAuxData: undefined,
			vtabArgs: {},
			isTemporary: false,
			subqueryAST: undefined,
			isReadOnly: true,
		} as TableSchema;
	}

	// This xBestIndex is for the TABLE INSTANCE, called during query planning.
	xBestIndex(indexInfo: IndexInfo): number {
		// For _schema, we always do a full scan. We will not process any constraints ourselves.
		// Quereus will handle filtering after we return all rows via xQuery.
		indexInfo.idxNum = 0; // Single plan: full scan by xQuery
		indexInfo.estimatedCost = 1000.0; // Default cost for a scan
		indexInfo.estimatedRows = BigInt(100); // Arbitrary estimate of total schema objects
		indexInfo.orderByConsumed = false; // We don't handle ORDER BY
		indexInfo.idxFlags = 0;

		// Tell Quereus we are not using any constraints directly.
		// Quereus will then apply them after xQuery returns all rows.
		indexInfo.aConstraintUsage = indexInfo.aConstraint.map(() => ({
			argvIndex: 0, // Not used by xQuery
			omit: false    // Quereus should still evaluate the constraint
		}));
		indexInfo.idxStr = "_schema_full_scan_by_xQuery";
		return StatusCode.OK;
	}

	async xUpdate(values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint }> {
		throw new QuereusError("Cannot modify read-only table: _schema", StatusCode.READONLY);
	}

	async xBegin(): Promise<void> {}
	async xSync(): Promise<void> {}
	async xCommit(): Promise<void> {}
	async xRollback(): Promise<void> {}

	async xRename(zNew: string): Promise<void> {
		throw new QuereusError("Cannot rename built-in table: _schema", StatusCode.ERROR);
	}

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
				let createSql: string | null = null;
				try {
					const columnsStr = tableSchema.columns.map(c => `"${c.name}" ${c.affinity ?? SqlDataType.TEXT}`).join(', ');
					const argsStr = Object.entries(tableSchema.vtabArgs ?? {}).map(([key, value]) => `${key}=${value}`).join(', ');
					createSql = `create table "${tableSchema.name}" (${columnsStr}) using ${tableSchema.vtabModuleName}(${argsStr})`;
				} catch (e) {
					createSql = null;
				}
				generatedRows.push({
					type: tableSchema.isView ? 'view' : 'table',
					name: tableSchema.name,
					tbl_name: tableSchema.name,
					sql: createSql,
					_rowid_: rowidCounter++,
				});
			}
			// Process Functions
			for (const funcSchema of schemaInstance._getAllFunctions()) {
				generatedRows.push({
					type: 'function',
					name: funcSchema.name,
					tbl_name: funcSchema.name,
					sql: stringifyCreateFunction(funcSchema),
					_rowid_: rowidCounter++,
				});
			}
		};

		processSchemaInstance(schemaManager.getMainSchema());
		processSchemaInstance(schemaManager.getTempSchema());
		return generatedRows;
	}

	async *xQuery(filterInfo: FilterInfo): AsyncIterable<RowIdRow> {
		const allSchemaRows = this._generateInternalSchemaRows(this.db);
		// No need for filterInfo.constraints or filterInfo.args as we are not filtering here.
		// Quereus will do the filtering.

		for (const row of allSchemaRows) {
			const outputRow: Row = [
				row.type,
				row.name,
				row.tbl_name,
				row.sql
			];
			yield [row._rowid_, outputRow];
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
		{ name: 'sql', type: SqlDataType.TEXT, collation: 'BINARY' },
	];
	static readonly COLUMN_INDEX_MAP: Record<string, number> = Object.fromEntries(
		this.COLUMNS.map((col, i) => [col.name, i])
	);

	constructor() {}

	xCreate(): SchemaTable {
		throw new QuereusError("Cannot create table using module _schema", StatusCode.ERROR);
	}

	xConnect(_db: Database, _pAux: unknown, _moduleName: string, schemaName: string, tableName: string): SchemaTable {
		return new SchemaTable(_db, this, schemaName, tableName);
	}

	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		// This module-level xBestIndex is typically for CREATE VIRTUAL TABLE time argument parsing.
		// _schema takes no arguments, so this is a simple pass-through indicating a full scan.
		// The actual query planning details are deferred to the SchemaTable instance's xBestIndex.
		indexInfo.idxNum = 0;
		indexInfo.estimatedCost = 1000.0;
		indexInfo.estimatedRows = BigInt(100);
		indexInfo.orderByConsumed = false;
		indexInfo.idxFlags = 0;
		indexInfo.aConstraintUsage = Array.from({ length: indexInfo.nConstraint }, () => ({ argvIndex: 0, omit: true }));
		indexInfo.idxStr = "_schema_default_module_scan";
		return StatusCode.OK;
	}

	async xDestroy(_db: Database, _pAux: unknown, _moduleName: string, _schemaName: string, _tableName: string): Promise<void> {
		return Promise.resolve();
	}

	xShadowName?(_name: string): boolean {
		return false;
	}
}
