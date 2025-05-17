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

// Schema definition for json_each table
const JSON_EACH_SCHEMA = Object.freeze([
	{ name: 'key', affinity: SqlDataType.INTEGER | SqlDataType.TEXT },
	{ name: 'value', affinity: SqlDataType.TEXT },
	{ name: 'type', affinity: SqlDataType.TEXT },
	{ name: 'atom', affinity: SqlDataType.TEXT },
	{ name: 'id', affinity: SqlDataType.INTEGER },
	{ name: 'parent', affinity: SqlDataType.INTEGER },
	{ name: 'fullkey', affinity: SqlDataType.TEXT },
	{ name: 'path', affinity: SqlDataType.TEXT },
]);

const JSON_EACH_COLUMNS = Object.freeze(
	JSON_EACH_SCHEMA.map(col => ({
		...createDefaultColumnSchema(col.name),
		affinity: col.affinity,
	}))
);
const JSON_EACH_COLUMN_MAP = Object.freeze(buildColumnIndexMap(JSON_EACH_COLUMNS));

/**
 * Virtual table implementation for json_each function
 */
class JsonEachTable extends VirtualTable {
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
			throw new SqliterError(`Invalid JSON provided to ${tableName}`, StatusCode.ERROR);
		}

		// Define fixed schema
		this.tableSchema = Object.freeze({
			name: tableName,
			schemaName: schemaName,
			checkConstraints: [],
			columns: JSON_EACH_COLUMNS,
			columnIndexMap: JSON_EACH_COLUMN_MAP,
			primaryKeyDefinition: [],
			vtabModule: module as any,
			vtabModuleName: 'json_each',
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

	async xOpen(): Promise<JsonEachCursor<this>> {
		return new JsonEachCursor(this);
	}

	xBestIndex(indexInfo: IndexInfo): number {
		// json_each doesn't use indexes, it just iterates
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
		throw new SqliterError("json_each table is read-only", StatusCode.READONLY);
	}

	async xBegin() { return Promise.resolve(); }
	async xSync() { return Promise.resolve(); }
	async xCommit() { return Promise.resolve(); }
	async xRollback() { return Promise.resolve(); }
	async xRename() {
		throw new SqliterError("Cannot rename json_each table", StatusCode.ERROR);
	}

	async xDisconnect(): Promise<void> { /* No-op */ }
	async xDestroy(): Promise<void> { /* No-op */ }

	async* xQuery(filterInfo: import('../filter-info.js').FilterInfo): AsyncIterable<[bigint, Row]> {
		// JsonEach doesn't typically use filterInfo for complex filtering via xBestIndex,
		// but we can extract rootPath if it were passed via VDBE arguments (not standard for TVFs like this yet).
		// For now, assume rootPath is from table construction.
		const rootPath = this.rootPath;
		let startNode = this.parsedJson;
		if (rootPath) {
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}

		// Use the cursor's internal generator directly.
		// The cursor instance is transient here, just to access the generator.
		const cursor = new JsonEachCursor(this);
		const internalGenerator = cursor['_internalIteratorGenerator'](startNode, rootPath);

		for await (const CrtRwDt of internalGenerator) {
			if (!CrtRwDt) continue;
			const rowId = BigInt(CrtRwDt.id as number); // Assuming id is always a number here
			const row: SqlValue[] = [
				CrtRwDt.key,
				CrtRwDt.value, // Placeholder, will be correctly set below
				CrtRwDt.type,
				CrtRwDt.atom,
				CrtRwDt.id,
				CrtRwDt.parent,
				CrtRwDt.fullkey,
				CrtRwDt.path
			];

			const valueColumnIndex = JSON_EACH_COLUMN_MAP.get('value');
			if (valueColumnIndex === undefined) {
				throw new SqliteError("Internal error: 'value' column not found in JSON_EACH_COLUMN_MAP during xQuery", StatusCode.INTERNAL);
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
 * Represents the state of an iteration through the JSON structure
 */
interface IterationState {
	value: any;
	parentPath: string;
	parentKey: string | number | null;
	parentId: number;
	currentIndex: number;
	keys?: string[];
}

/**
 * Cursor implementation for json_each table
 */
class JsonEachCursor<T extends JsonEachTable> extends VirtualTableCursor<T> {
	private stack: IterationState[] = [];
	private currentRowData: Record<string, SqlValue> | null = null;
	private elementIdCounter: number = 0;
	private internalIterator: AsyncIterator<Record<string, SqlValue> | null> | null = null;

	constructor(table: T) {
		super(table);
		this._isEof = true;
	}

	/**
	 * Resets the cursor state
	 */
	reset(): void {
		this.stack = [];
		this.currentRowData = null;
		this._isEof = true;
		this.elementIdCounter = 0;
		this.internalIterator = null;
	}

	// New internal async generator
	private async* _internalIteratorGenerator(startNode: any, initialRootPath: string | null): AsyncIterable<Record<string, SqlValue>> {
		const localStack: IterationState[] = [];
		let localElementIdCounter = 0;

		if (startNode !== undefined) {
			localStack.push({
				value: startNode,
				parentPath: '',
				parentKey: null,
				parentId: 0,
				currentIndex: -1,
			});
		}

		while (localStack.length > 0) {
			const currentState = localStack[localStack.length - 1];
			const currentValue = currentState.value;

			const key = currentState.parentKey;
			const id = localElementIdCounter++; // Use local counter
			const path = currentState.parentPath;
			const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
			const type = getJsonType(currentValue);
			const atom = (type === 'object' || type === 'array') ? null : currentValue;

			const generatedRow: Record<string, SqlValue> = {
				key: key,
				value: (type === 'object' || type === 'array') ? jsonStringify(currentValue) : currentValue,
				type: type,
				atom: atom,
				id: id,
				parent: currentState.parentId,
				fullkey: fullkey,
				path: path,
				_originalValue: currentValue,
			};

			localStack.pop(); // Pop the current state as it's now processed

			if (Array.isArray(currentValue)) {
				for (let i = currentValue.length - 1; i >= 0; i--) {
					localStack.push({
						value: currentValue[i],
						parentPath: fullkey,
						parentKey: i,
						parentId: id,
						currentIndex: -1,
					});
				}
			} else if (typeof currentValue === 'object' && currentValue !== null) {
				const keys = Object.keys(currentValue).sort().reverse();
				for (const objKey of keys) {
					localStack.push({
						value: currentValue[objKey],
						parentPath: fullkey,
						parentKey: objKey,
						parentId: id,
						currentIndex: -1,
					});
				}
			}
			yield generatedRow;
		}
	}

	/**
	 * Initializes iteration based on the JSON start node and optional root path
	 */
	private startIteration(startNode: any, _rootPath: string | null): void {
		this.reset();
		if (startNode !== undefined) {
			// Push the root node to start
			this.stack.push({
				value: startNode,
				parentPath: '',
				parentKey: null,
				parentId: 0,
				currentIndex: -1,
			});
			this._isEof = false;
			this.advanceToNextRow(); // Position on the first element
		} else {
			this._isEof = true;
		}
	}

	/**
	 * Advances to the next row by moving through the JSON structure
	 */
	private advanceToNextRow(): void {
		if (this.stack.length === 0) {
			this._isEof = true;
			this.currentRowData = null;
			return;
		}

		const currentState = this.stack[this.stack.length - 1];
		const currentValue = currentState.value;

		// Determine key/index for the current node based on parent state
		const key = currentState.parentKey;
		const id = this.elementIdCounter++;
		const path = currentState.parentPath;
		const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
		const type = getJsonType(currentValue);
		const atom = (type === 'object' || type === 'array') ? null : currentValue;

		this.currentRowData = {
			key: key,
			value: (type === 'object' || type === 'array') ? jsonStringify(currentValue) : currentValue,
			type: type,
			atom: atom,
			id: id,
			parent: currentState.parentId,
			fullkey: fullkey,
			path: path,
			_originalValue: currentValue, // Store original for potential stringification later
		};

		// Pop the current state as it's now processed
		this.stack.pop();

		// If the current node is an array or object, push its children (in reverse order for stack processing)
		if (Array.isArray(currentValue)) {
			for (let i = currentValue.length - 1; i >= 0; i--) {
				this.stack.push({
					value: currentValue[i],
					parentPath: fullkey,
					parentKey: i,
					parentId: id,
					currentIndex: -1,
				});
			}
		} else if (typeof currentValue === 'object' && currentValue !== null) {
			const keys = Object.keys(currentValue).sort().reverse();
			for (const objKey of keys) {
				this.stack.push({
					value: currentValue[objKey],
					parentPath: fullkey,
					parentKey: objKey,
					parentId: id,
					currentIndex: -1,
				});
			}
		}

		this._isEof = false;
	}

	/**
	 * Initializes cursor for a new query
	 * For json_each, we don't use the query constraints - we iterate the entire JSON structure
	 */
	async filter(
		_idxNum: number,
		_idxStr: string | null,
		_constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>,
		_args: ReadonlyArray<SqlValue>
	): Promise<void> {
		this.reset(); // Resets currentRowData, _isEof, elementIdCounter, and internalIterator
		const rootPath = this.table.rootPath;
		let startNode = this.table.parsedJson;

		if (rootPath) {
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}

		this.internalIterator = this._internalIteratorGenerator(startNode, rootPath)[Symbol.asyncIterator]();
		await this.next(); // Populate the first row
	}

	/**
	 * Advances the cursor to the next row in the result set
	 */
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

	/**
	 * Returns the value for the specified column index of the current row
	 */
	column(context: SqliteContext, index: number): number {
		if (!this.currentRowData) {
			context.resultNull();
			return StatusCode.OK;
		}
		const colName = JSON_EACH_COLUMNS[index]?.name;

		// Handle value formatting specifically for column requests
		if (colName === 'value') {
			const type = this.currentRowData['type'];
			if (type === 'object' || type === 'array') {
				// Use the stored original value for stringification
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

	/**
	 * Returns the rowid for the current row
	 */
	async rowid(): Promise<bigint> {
		if (!this.currentRowData) {
			throw new SqliteError("Cursor is not pointing to a valid row", StatusCode.MISUSE);
		}
		const id = this.currentRowData['id'];
		if (typeof id === 'number') {
			return BigInt(id);
		}
		throw new SqliterError("Cannot get rowid for json_each cursor (missing ID)", StatusCode.INTERNAL);
	}

	/**
	 * Closes this cursor and releases resources
	 */
	async close(): Promise<void> {
		this.reset();
	}

	async* rows(): AsyncIterable<Row> {
		if (this.eof()) {
			return;
		}

		// Create a dummy context for calling this.column()
		// This is okay because JsonEachCursor.column() doesn't actually use the context.
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
			getDbConnection: () => this.table.db,
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
}

/**
 * Module implementation for json_each virtual table function
 */
export class JsonEachModule implements VirtualTableModule<JsonEachTable, JsonConfig> {
	xConnect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: JsonConfig
	): JsonEachTable {
		const table = new JsonEachTable(db, this, schemaName, tableName, options.jsonSource, options.rootPath);
		return table;
	}

	xCreate(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: JsonConfig
	): JsonEachTable {
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
