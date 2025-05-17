import { VirtualTable } from '../table.js';
import { VirtualTableCursor } from '../cursor.js';
import type { VirtualTableModule, BaseModuleConfig } from '../module.js';
import type { IndexInfo } from '../indexInfo.js';
import { type SqlValue, StatusCode, SqlDataType, type Row } from '../../common/types.js';
import { SqliteError } from '../../common/errors.js';
import type { SqliteContext } from '../../func/context.js';
import type { Database } from '../../core/database.js';
import { safeJsonParse, evaluateJsonPathBasic, getJsonType } from '../../func/builtins/json-helpers.js';
import type { TableSchema } from '../../schema/table.js';
import { createDefaultColumnSchema } from '../../schema/column.js';
import { buildColumnIndexMap } from '../../schema/table.js';
import type { IndexConstraint } from '../indexInfo.js';
import { jsonStringify } from '../../util/serialization.js';

/**
 * Configuration interface for JSON virtual tables
 */
interface JsonConfig extends BaseModuleConfig {
	jsonSource: SqlValue;
	runtimeArgs?: ReadonlyArray<SqlValue>;
	rootPath?: SqlValue;
}

// Schema definition for json_tree table (identical to json_each)
const JSON_TREE_SCHEMA = Object.freeze([
	{ name: 'key', affinity: SqlDataType.INTEGER | SqlDataType.TEXT },
	{ name: 'value', affinity: SqlDataType.TEXT },
	{ name: 'type', affinity: SqlDataType.TEXT },
	{ name: 'atom', affinity: SqlDataType.TEXT },
	{ name: 'id', affinity: SqlDataType.INTEGER },
	{ name: 'parent', affinity: SqlDataType.INTEGER },
	{ name: 'fullkey', affinity: SqlDataType.TEXT },
	{ name: 'path', affinity: SqlDataType.TEXT },
]);

const JSON_TREE_COLUMNS = Object.freeze(
	JSON_TREE_SCHEMA.map(col => ({
		...createDefaultColumnSchema(col.name),
		affinity: col.affinity,
	}))
);
const JSON_TREE_COLUMN_MAP = Object.freeze(buildColumnIndexMap(JSON_TREE_COLUMNS));

/**
 * Virtual table implementation for json_tree function
 */
class JsonTreeTable extends VirtualTable {
	public readonly parsedJson: any;
	public readonly rootPath: string | null;
	public readonly tableSchema: TableSchema;

	constructor(
		db: Database,
		module: VirtualTableModule<any, any>,
		schemaName: string,
		tableName: string,
		jsonText: SqlValue,
		rootPath?: SqlValue
	) {
		super(db, module, schemaName, tableName);
		this.parsedJson = safeJsonParse(jsonText);
		this.rootPath = (typeof rootPath === 'string' && rootPath) ? rootPath : null;

		if (this.parsedJson === null && typeof jsonText === 'string') {
			throw new SqliteError(`Invalid JSON provided to ${tableName}`, StatusCode.ERROR);
		}

		this.tableSchema = Object.freeze({
			name: tableName,
			schemaName: schemaName,
			checkConstraints: [],
			columns: JSON_TREE_COLUMNS,
			columnIndexMap: JSON_TREE_COLUMN_MAP,
			primaryKeyDefinition: [],
			vtabModule: module as any,
			vtabModuleName: 'json_tree',
			isWithoutRowid: false,
			isStrict: false,
			isView: false,
			vtabAuxData: undefined,
			vtabArgs: [],
			indexes: [],
			isTemporary: false,
			subqueryAST: undefined,
		});
	}

	async xOpen(): Promise<JsonTreeCursor<this>> {
		return new JsonTreeCursor(this);
	}

	xBestIndex(indexInfo: IndexInfo): number {
		indexInfo.estimatedCost = 100000;
		indexInfo.idxNum = 0;
		indexInfo.idxStr = null;
		indexInfo.orderByConsumed = false;

		// No constraints are used
		indexInfo.aConstraintUsage = Array.from(
			{ length: indexInfo.nConstraint },
			() => ({ argvIndex: 0, omit: false })
		);
		return StatusCode.OK;
	}

	async xUpdate(): Promise<{ rowid?: bigint }> {
		throw new SqliteError("json_tree table is read-only", StatusCode.READONLY);
	}

	async xBegin() { return Promise.resolve(); }
	async xSync() { return Promise.resolve(); }
	async xCommit() { return Promise.resolve(); }
	async xRollback() { return Promise.resolve(); }
	async xRename() {
		throw new SqliteError("Cannot rename json_tree table", StatusCode.ERROR);
	}

	async xDisconnect(): Promise<void> { /* No-op */ }
	async xDestroy(): Promise<void> { /* No-op */ }

	async* xQuery(filterInfo: import('../filter-info.js').FilterInfo): AsyncIterable<[bigint, Row]> {
		// JsonTree doesn't typically use filterInfo for complex filtering via xBestIndex.
		const rootPath = this.rootPath;
		let startNode = this.parsedJson;
		if (rootPath) {
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}

		const cursor = new JsonTreeCursor(this); // Transient cursor to access generator
		const internalGenerator = cursor['_internalIteratorGenerator'](startNode, rootPath);

		for await (const CrtRwDt of internalGenerator) {
			if (!CrtRwDt) continue;
			const rowId = BigInt(CrtRwDt.id as number);
			const row: SqlValue[] = [
				CrtRwDt.key,
				CrtRwDt.value, // Placeholder
				CrtRwDt.type,
				CrtRwDt.atom,
				CrtRwDt.id,
				CrtRwDt.parent,
				CrtRwDt.fullkey,
				CrtRwDt.path
			];

			const valueColumnIndex = JSON_TREE_COLUMN_MAP.get('value');
			if (valueColumnIndex === undefined) {
				throw new SqliteError("Internal error: 'value' column not found in JSON_TREE_COLUMN_MAP during xQuery", StatusCode.INTERNAL);
			}

			if (CrtRwDt.type === 'object' || CrtRwDt.type === 'array') {
				const originalValue = (CrtRwDt as any)._originalValue;
				row[valueColumnIndex] = originalValue !== undefined ? jsonStringify(originalValue) : null;
			} else {
				row[valueColumnIndex] = CrtRwDt.value ?? null;
			}
			yield [rowId, row];
		}
	}
}

/**
 * Represents the state of a depth-first iteration through the JSON structure
 */
interface IterationState {
	value: any;
	parentPath: string;
	parentKey: string | number | null;
	parentId: number;
	childrenPushed: boolean;
}

/**
 * Cursor implementation for json_tree table
 * Uses depth-first traversal, including both nodes and their children
 */
class JsonTreeCursor<T extends JsonTreeTable> extends VirtualTableCursor<T> {
	private stack: IterationState[] = [];
	private currentRowData: Record<string, SqlValue> | null = null;
	private elementIdCounter: number = 0;
	private internalIterator: AsyncIterator<Record<string, SqlValue> | null> | null = null;

	constructor(table: T) {
		super(table);
		this._isEof = true;
	}

	reset(): void {
		this.stack = [];
		this.currentRowData = null;
		this._isEof = true;
		this.elementIdCounter = 0;
		this.internalIterator = null;
	}

	private async* _internalIteratorGenerator(startNode: any, _initialRootPath: string | null): AsyncIterable<Record<string, SqlValue>> {
		const localStack: IterationState[] = [];
		let localElementIdCounter = 0;

		if (startNode !== undefined) {
			localStack.push({
				value: startNode,
				parentPath: '',
				parentKey: null,
				parentId: 0,
				childrenPushed: false,
			});
		}

		while (localStack.length > 0) {
			const state = localStack[localStack.length - 1];
			const value = state.value;
			const isContainer = typeof value === 'object' && value !== null;

			if (!state.childrenPushed) {
				const key = state.parentKey;
				const id = ++localElementIdCounter;
				const path = state.parentPath;
				const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
				const type = getJsonType(value);
				const atom = !isContainer ? value : null;

				const generatedRow: Record<string, SqlValue> = {
					key: key,
					value: isContainer ? jsonStringify(value) : value,
					type: type,
					atom: atom,
					id: id,
					parent: state.parentId,
					fullkey: fullkey,
					path: path,
					_originalValue: value,
				};
				state.childrenPushed = true;
				yield generatedRow;

				if (isContainer) {
					const parentIdForRow = id;
					const parentFullKeyForRow = fullkey;

					if (Array.isArray(value)) {
						for (let i = value.length - 1; i >= 0; i--) {
							localStack.push({
								value: value[i],
								parentPath: parentFullKeyForRow,
								parentKey: i,
								parentId: parentIdForRow,
								childrenPushed: false,
							});
						}
					} else {
						const keys = Object.keys(value).sort().reverse();
						for (const objKey of keys) {
							localStack.push({
								value: value[objKey],
								parentPath: parentFullKeyForRow,
								parentKey: objKey,
								parentId: parentIdForRow,
								childrenPushed: false,
							});
						}
					}
					continue;
				}
			}
			localStack.pop();
		}
	}

	async filter(
		_idxNum: number,
		_idxStr: string | null,
		_constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>,
		_args: ReadonlyArray<SqlValue>
	): Promise<void> {
		this.reset();
		const rootPath = this.table.rootPath;
		let startNode = this.table.parsedJson;
		if (rootPath) {
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}
		this.internalIterator = this._internalIteratorGenerator(startNode, rootPath)[Symbol.asyncIterator]();
		await this.next();
	}

	async next(): Promise<void> {
		if (this._isEof || !this.internalIterator) return;
		const result = await this.internalIterator.next();
		if (result.done) {
			this._isEof = true;
			this.currentRowData = null;
		} else {
			this._isEof = false;
			this.currentRowData = result.value;
		}
	}

	column(context: SqliteContext, index: number): number {
		if (!this.currentRowData) {
			context.resultNull();
			return StatusCode.OK;
		}
		const colName = JSON_TREE_COLUMNS[index]?.name;

		if (colName === 'value') {
			const type = this.currentRowData['type'];
			if (type === 'object' || type === 'array') {
				const originalValue = (this.currentRowData as any)._originalValue;
				context.resultValue(originalValue !== undefined ? jsonStringify(originalValue) : null);
			} else {
				context.resultValue(this.currentRowData[colName] ?? null);
			}
		} else {
			context.resultValue(this.currentRowData[colName] ?? null);
		}
		return StatusCode.OK;
	}

	async rowid(): Promise<bigint> {
		if (!this.currentRowData) {
			throw new SqliteError("Cursor is not pointing to a valid row", StatusCode.MISUSE);
		}
		const id = this.currentRowData['id'];
		if (typeof id === 'number') {
			return BigInt(id);
		}
		throw new SqliteError("Cannot get rowid for json_tree cursor (missing ID)", StatusCode.INTERNAL);
	}

	async* rows(): AsyncIterable<Row> {
		if (this.eof()) {
			return;
		}

		// Create a dummy context for calling this.column()
		// This is okay because JsonTreeCursor.column() doesn't actually use the context.
		const dummyContext: SqliteContext = {
			setAuxData: (_N: number, _data: unknown) => { /* no-op */ },
			resultBlob: () => { /* no-op */ },
			resultDouble: () => { /* no-op */ },
			resultError: () => { /* no-op */ },
			resultInt: () => { /* no-op */ },
			resultInt64: () => { /* no-op */ },
			resultNull: () => { /* no-op */ },
			resultText: () => { /* no-op */ },
			resultValue: () => { /* no-op */ },
			resultZeroblob: () => { /* no-op */ },
			resultSubtype: () => { /* no-op */ },
			getUserData: () => null,
			getDbConnection: () => this.table.db, // Provide actual db connection
			getAuxData: (_N: number) => undefined,
			getAggregateContext: () => undefined,
			setAggregateContext: () => { /* no-op */ },
		};

		while (!this.eof()) {
			const row: SqlValue[] = [];
			for (let i = 0; i < this.table.tableSchema.columns.length; i++) {
				row.push(this.column(dummyContext, i));
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
 * Module implementation for json_tree virtual table function
 */
export class JsonTreeModule implements VirtualTableModule<JsonTreeTable, JsonConfig> {
	xConnect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: JsonConfig
	): JsonTreeTable {
		const table = new JsonTreeTable(db, this, schemaName, tableName, options.jsonSource, options.rootPath);
		return table;
	}

	xCreate(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: JsonConfig
	): JsonTreeTable {
		return this.xConnect(db, pAux, moduleName, schemaName, tableName, options);
	}

	xBestIndex(db: Database, tableInfo: TableSchema, indexInfo: IndexInfo): number {
		indexInfo.estimatedCost = 100000;
		indexInfo.idxNum = 0;
		indexInfo.idxStr = null;
		indexInfo.orderByConsumed = false;

		// No constraints are used
		indexInfo.aConstraintUsage = Array.from(
			{ length: indexInfo.nConstraint },
			() => ({ argvIndex: 0, omit: false })
		);
		return StatusCode.OK;
	}

	async xDestroy(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string
	): Promise<void> {
		return Promise.resolve();
	}
}
