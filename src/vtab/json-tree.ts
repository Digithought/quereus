import { VirtualTable } from './table';
import { VirtualTableCursor } from './cursor';
import type { VirtualTableModule } from './module';
import type { IndexInfo } from './indexInfo';
import { type SqlValue, StatusCode, SqlDataType } from '../common/types';
import { SqliteError } from '../common/errors';
import type { SqliteContext } from '../func/context';
import type { Database } from '../core/database';
import { safeJsonParse, evaluateJsonPathBasic, getJsonType } from '../func/builtins/json-helpers';
import type { TableSchema } from '../schema/table';
import { createDefaultColumnSchema } from '../schema/column';
import { buildColumnIndexMap } from '../schema/table';

// --- Constants for json_tree Schema (Identical to json_each) ---
const JSON_TREE_SCHEMA: ReadonlyArray<{ name: string, affinity: SqlDataType }> = Object.freeze([
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

// --- Table Instance (Can potentially inherit if no differences needed) ---
// For now, keep separate to set correct vtabModuleName in schema
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
			columns: JSON_TREE_COLUMNS,
			columnIndexMap: JSON_TREE_COLUMN_MAP,
			primaryKeyDefinition: [],
			isVirtual: true,
			vtabModule: module,
			vtabInstance: this,
			vtabModuleName: 'json_tree', // Correct module name
		});
	}
}

// --- Cursor Instance (Must be specific due to different iteration logic) --- //

interface IterationState {
	value: any;
	parentPath: string;
	parentKey: string | number | null;
	parentId: number;
	childrenPushed?: boolean; // Specific to json_tree
}

class JsonTreeCursor extends VirtualTableCursor<JsonTreeTable> {
	private stack: IterationState[] = [];
	private currentRow: Record<string, SqlValue> | null = null;
	private isEof: boolean = true;
	private elementIdCounter: number = 0;

	constructor(table: JsonTreeTable) {
		super(table);
	}

	reset(): void {
		this.stack = [];
		this.currentRow = null;
		this.isEof = true;
		this.elementIdCounter = 0;
	}

	startIteration(startNode: any, rootPath: string | null): void {
		this.reset();
		const initialPath = rootPath ?? '$';
		if (startNode !== undefined) {
			this.stack.push({
				value: startNode,
				parentPath: '',
				parentKey: null,
				parentId: 0,
				childrenPushed: false,
			});
			this.isEof = false;
			this.next();
		} else {
			this.isEof = true;
		}
	}

	next(): void {
		if (this.stack.length === 0) {
			this.isEof = true;
			this.currentRow = null;
			return;
		}

		const currentState = this.stack[this.stack.length - 1];
		const currentValue = currentState.value;
		const isContainer = typeof currentValue === 'object' && currentValue !== null;

		if (this.currentRow === null || !currentState.childrenPushed) {
			const key = currentState.parentKey;
			const id = ++this.elementIdCounter;
			const path = currentState.parentPath;
			const fullkey = key !== null ? `${path}${typeof key === 'number' ? `[${key}]` : `.${key}`}` : path;
			const type = getJsonType(currentValue);
			const atom = !isContainer ? currentValue : null;

			this.currentRow = {
				key: key,
				value: isContainer ? JSON.stringify(currentValue) : currentValue,
				type: type,
				atom: atom,
				id: id,
				parent: currentState.parentId,
				fullkey: fullkey,
				path: path,
				_originalValue: isContainer ? currentValue : undefined
			};

			if (isContainer) {
				currentState.childrenPushed = false;
				return;
			} else {
				this.stack.pop();
				this.next();
				return;
			}
		}

		currentState.childrenPushed = true;
		const parentId = (this.currentRow as any).id;
		const parentFullKey = (this.currentRow as any).fullkey;

		this.stack.pop();

		if (Array.isArray(currentValue)) {
			for (let i = currentValue.length - 1; i >= 0; i--) {
				this.stack.push({
					value: currentValue[i],
					parentPath: parentFullKey,
					parentKey: i,
					parentId: parentId,
					childrenPushed: false,
				});
			}
		} else if (typeof currentValue === 'object' && currentValue !== null) {
			const keys = Object.keys(currentValue).sort().reverse();
			for (const objKey of keys) {
				this.stack.push({
					value: currentValue[objKey],
					parentPath: parentFullKey,
					parentKey: objKey,
					parentId: parentId,
					childrenPushed: false,
				});
			}
		}

		this.currentRow = null;
		this.next();
	}

	eof(): boolean {
		return this.isEof;
	}

	column(index: number): SqlValue {
		if (!this.currentRow) return null;
		const colName = JSON_TREE_COLUMNS[index]?.name;

		if (colName === 'value' && this.currentRow) {
			const type = this.currentRow['type'];
			if (type === 'object' || type === 'array') {
				const originalValue = (this.currentRow as any)._originalValue;
				return originalValue !== undefined ? JSON.stringify(originalValue) : null;
			} else {
				return this.currentRow[colName] ?? null;
			}
		} else {
			return this.currentRow[colName] ?? null;
		}
	}
}

// --- Module Implementation (No Inheritance) --- //

export class JsonTreeModule implements VirtualTableModule<JsonTreeTable, JsonTreeCursor> {
	// Add back all required methods
	xConnect(db: Database, pAux: unknown, args: ReadonlyArray<string>): JsonTreeTable {
		// Args: module_name, schema_name, table_name, json_text, [root_path]
		if (args.length < 4 || args.length > 5) {
			throw new SqliteError(`json_tree requires 1 or 2 arguments (json, [path])`, StatusCode.ERROR);
		}
		const schemaName = args[1];
		const tableName = args[2];
		const jsonText = args[3];
		const rootPath = args.length > 4 ? args[4] : undefined;

		const table = new JsonTreeTable(db, this, schemaName, tableName, jsonText, rootPath);
		return table;
	}

	xCreate = this.xConnect;

	async xDisconnect(table: JsonTreeTable): Promise<void> { /* No-op */ }
	async xDestroy(table: JsonTreeTable): Promise<void> { /* No-op */ }

	async xOpen(table: JsonTreeTable): Promise<JsonTreeCursor> {
		return new JsonTreeCursor(table);
	}

	async xClose(cursor: JsonTreeCursor): Promise<void> {
		cursor.reset();
	}

	xBestIndex(table: JsonTreeTable, indexInfo: IndexInfo): number {
		indexInfo.estimatedCost = 100000; // Arbitrary large cost
		indexInfo.idxNum = 0; // Plan 0: Full iteration
		indexInfo.idxStr = null;
		indexInfo.orderByConsumed = false; // Output order is depth-first
		return StatusCode.OK;
	}

	async xFilter(cursor: JsonTreeCursor, idxNum: number, idxStr: string | null, args: ReadonlyArray<SqlValue>): Promise<void> {
		const rootPath = cursor.table.rootPath;
		let startNode = cursor.table.parsedJson;
		if (rootPath) {
			startNode = evaluateJsonPathBasic(startNode, rootPath);
		}
		cursor.startIteration(startNode, rootPath);
	}

	async xNext(cursor: JsonTreeCursor): Promise<void> {
		cursor.next();
	}

	async xEof(cursor: JsonTreeCursor): Promise<boolean> {
		return cursor.eof();
	}

	xColumn(cursor: JsonTreeCursor, context: SqliteContext, i: number): number {
		context.resultValue(cursor.column(i));
		return StatusCode.OK;
	}

	xRowid(cursor: JsonTreeCursor): Promise<bigint> {
		const idColIndex = JSON_TREE_COLUMN_MAP.get('id')!;
		const id = cursor.column(idColIndex);
		if (typeof id === 'number') {
			return Promise.resolve(BigInt(id));
		}
		return Promise.reject(new SqliteError("Cannot get rowid for json_tree cursor", StatusCode.ERROR));
	}

	async xUpdate(): Promise<{ rowid?: bigint }> {
		throw new SqliteError("json_tree table is read-only", StatusCode.READONLY);
	}
	async xBegin() { return Promise.resolve(); }
	async xSync() { return Promise.resolve(); }
	async xCommit() { return Promise.resolve(); }
	async xRollback() { return Promise.resolve(); }
	async xRename() { throw new SqliteError("Cannot rename json_tree table", StatusCode.ERROR); }
}
