import { SqliteError } from '../../common/errors';
import { StatusCode } from '../../common/types';
import type { ColumnDef } from '../../parser';
import { getAffinity } from '../../schema/column';
import { columnDefToSchema, buildColumnIndexMap } from '../../schema/table';
import { Latches } from '../../util/latches';
import type { MemoryTable, MemoryTableRow } from './table';
import type { SchemaChangeInfo } from '../module';

export function addColumnLogic(self: MemoryTable, columnDef: ColumnDef): void {
	if (self.isReadOnly()) {
		throw new SqliteError(`Table '${self.tableName}' is read-only`, StatusCode.READONLY);
	}
	if (!self.data) throw new Error("MemoryTable BTree not initialized.");

	const newColNameLower = columnDef.name.toLowerCase();
	if (self.columns.some(c => c.name.toLowerCase() === newColNameLower)) {
		throw new SqliteError(`Duplicate column name: ${columnDef.name}`, StatusCode.ERROR);
	}
	const defaultValue = null; // TODO: Handle default values

	const newColumnSchema = columnDefToSchema(columnDef);
	const newColumnAffinity = getAffinity(columnDef.dataType);

	const oldColumns = [...self.columns];
	const oldTableSchema = self.tableSchema;
	self.columns.push({ name: newColumnSchema.name, type: newColumnAffinity, collation: newColumnSchema.collation });

	if (oldTableSchema) {
		const updatedColumnsSchema = [...oldTableSchema.columns, newColumnSchema];
		self.tableSchema = Object.freeze({
			...oldTableSchema,
			columns: updatedColumnsSchema,
			columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
		});
	}

	try {
		const updatedRows: MemoryTableRow[] = [];
		for (const path of self.data.ascending(self.data.first())) {
			const row = self.data.at(path);
			if (row) {
				const newRow = { ...row, [newColumnSchema.name]: defaultValue };
				updatedRows.push(newRow);
				self.data.deleteAt(path);
				if (self.rowidToKeyMap && self.keyFromEntry(row) !== row._rowid_) {
					self.rowidToKeyMap.delete(row._rowid_);
				}
			}
		}
		for (const row of updatedRows) {
			self.data.insert(row);
			if (self.rowidToKeyMap && self.keyFromEntry(row) !== row._rowid_) {
				self.rowidToKeyMap.set(row._rowid_, self.keyFromEntry(row));
			}
		}

		if (self.inTransaction) {
			const addProp = (row: Record<string, any>) => { row[newColumnSchema.name] = defaultValue; };
			self.pendingInserts?.forEach(addProp);
			self.pendingUpdates?.forEach(update => { addProp(update.oldRow); addProp(update.newRow); });
			self.pendingDeletes?.forEach(del => { addProp(del.oldRow); });
			self.savepoints.forEach(sp => {
				sp.inserts?.forEach(addProp);
				sp.updates?.forEach(update => { addProp(update.oldRow); addProp(update.newRow); });
				sp.deletes?.forEach(del => { addProp(del.oldRow); });
			});
		}
		console.log(`MemoryTable ${self.tableName}: Added column ${newColumnSchema.name}`);

	} catch (e) {
		self.columns = oldColumns;
		self.tableSchema = oldTableSchema;
		console.error(`Error adding column ${columnDef.name}, data might be inconsistent.`, e);
		throw new SqliteError(`Failed to add column ${columnDef.name}: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL, e instanceof Error ? e : undefined);
	}
}

export function dropColumnLogic(self: MemoryTable, columnName: string): void {
	if (self.isReadOnly()) {
		throw new SqliteError(`Table '${self.tableName}' is read-only`, StatusCode.READONLY);
	}
	if (!self.data) throw new Error("MemoryTable BTree not initialized.");

	const colNameLower = columnName.toLowerCase();
	const colIndex = self.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
	if (colIndex === -1) {
		throw new SqliteError(`Column not found: ${columnName}`, StatusCode.ERROR);
	}
	if (!self.tableSchema) {
		throw new SqliteError(`Internal Error: Table schema not found for ${self.tableName} during DROP COLUMN.`, StatusCode.INTERNAL);
	}
	if (self.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
		throw new SqliteError(`Cannot drop column '${columnName}' because it is part of the primary key`, StatusCode.CONSTRAINT);
	}

	const oldColumns = [...self.columns];
	const oldTableSchema = self.tableSchema;
	self.columns.splice(colIndex, 1);
	self.primaryKeyColumnIndices = self.primaryKeyColumnIndices.map(idx => idx > colIndex ? idx - 1 : idx);

	const updatedColumnsSchema = oldTableSchema.columns.filter((_, idx) => idx !== colIndex);
	const updatedPkDefinition = oldTableSchema.primaryKeyDefinition.map(def => ({ ...def, index: def.index > colIndex ? def.index - 1 : def.index }));

	self.tableSchema = Object.freeze({
		...oldTableSchema,
		columns: updatedColumnsSchema,
		columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
		primaryKeyDefinition: updatedPkDefinition,
	});

	try {
		const updatedRows: MemoryTableRow[] = [];
		for (const path of self.data.ascending(self.data.first())) {
			const row = self.data.at(path);
			if (row) {
				const { [columnName]: _, ...newRow } = row;
				updatedRows.push(newRow as MemoryTableRow);
				self.data.deleteAt(path);
				if (self.rowidToKeyMap && self.keyFromEntry(row) !== row._rowid_) {
					self.rowidToKeyMap.delete(row._rowid_);
				}
			}
		}
		for (const row of updatedRows) {
			self.data.insert(row);
			if (self.rowidToKeyMap && self.keyFromEntry(row) !== row._rowid_) {
				self.rowidToKeyMap.set(row._rowid_, self.keyFromEntry(row));
			}
		}

		if (self.inTransaction) {
			const removeProp = (row: Record<string, any>) => { delete row[columnName]; };
			self.pendingInserts?.forEach(removeProp);
			self.pendingUpdates?.forEach(update => { removeProp(update.oldRow); removeProp(update.newRow); });
			self.pendingDeletes?.forEach(del => { removeProp(del.oldRow); });
			self.savepoints.forEach(sp => {
				sp.inserts?.forEach(removeProp);
				sp.updates?.forEach(update => { removeProp(update.oldRow); removeProp(update.newRow); });
				sp.deletes?.forEach(del => { removeProp(del.oldRow); });
			});
		}
		console.log(`MemoryTable ${self.tableName}: Dropped column ${columnName}`);
	} catch (e) {
		self.columns = oldColumns;
		self.tableSchema = oldTableSchema;
		self.primaryKeyColumnIndices = oldTableSchema?.primaryKeyDefinition.map(def => def.index) ?? [];
		console.error(`Error dropping column ${columnName}, data might be inconsistent.`, e);
		throw new SqliteError(`Failed to drop column ${columnName}: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL, e instanceof Error ? e : undefined);
	}
}

export function renameColumnLogic(self: MemoryTable, oldName: string, newName: string): void {
	if (self.isReadOnly()) {
		throw new SqliteError(`Table '${self.tableName}' is read-only`, StatusCode.READONLY);
	}
	if (!self.data) throw new Error("MemoryTable BTree not initialized.");

	const oldNameLower = oldName.toLowerCase();
	const newNameLower = newName.toLowerCase();
	const colIndex = self.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);

	if (colIndex === -1) {
		throw new SqliteError(`Column not found: ${oldName}`, StatusCode.ERROR);
	}
	if (self.columns.some(c => c.name.toLowerCase() === newNameLower)) {
		throw new SqliteError(`Duplicate column name: ${newName}`, StatusCode.ERROR);
	}
	if (!self.tableSchema) {
		throw new SqliteError(`Internal Error: Table schema not found for ${self.tableName} during RENAME COLUMN.`, StatusCode.INTERNAL);
	}
	if (self.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
		throw new SqliteError(`Cannot rename column '${oldName}' because it is part of the primary key`, StatusCode.CONSTRAINT);
	}

	const oldColumns = [...self.columns];
	const oldTableSchema = self.tableSchema;
	self.columns[colIndex].name = newName;

	const updatedColumnsSchema = oldTableSchema.columns.map((colSchema, idx) => idx === colIndex ? { ...colSchema, name: newName } : colSchema
	);
	self.tableSchema = Object.freeze({
		...oldTableSchema,
		columns: updatedColumnsSchema,
		columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
	});

	try {
		for (const path of self.data.ascending(self.data.first())) {
			const row = self.data.at(path);
			if (row && Object.prototype.hasOwnProperty.call(row, oldName)) {
				const { [oldName]: value, ...rest } = row;
				const newRow = { ...rest, [newName]: value };
				self.data.updateAt(path, newRow as MemoryTableRow);
			} else if (row) {
				console.warn(`Rowid ${row._rowid_} missing column ${oldName} during rename to ${newName}`);
			}
		}

		if (self.inTransaction) {
			const renameProp = (row: Record<string, any>) => {
				if (Object.prototype.hasOwnProperty.call(row, oldName)) {
					row[newName] = row[oldName];
					delete row[oldName];
				}
			};
			self.pendingInserts?.forEach(renameProp);
			self.pendingUpdates?.forEach(update => { renameProp(update.oldRow); renameProp(update.newRow); });
			self.pendingDeletes?.forEach(del => { renameProp(del.oldRow); });
			self.savepoints.forEach(sp => {
				sp.inserts?.forEach(renameProp);
				sp.updates?.forEach(update => { renameProp(update.oldRow); renameProp(update.newRow); });
				sp.deletes?.forEach(del => { renameProp(del.oldRow); });
			});
		}
		console.log(`MemoryTable ${self.tableName}: Renamed column ${oldName} to ${newName}`);
	} catch (e) {
		self.columns = oldColumns;
		self.tableSchema = oldTableSchema;
		try {
			for (const path of self.data.ascending(self.data.first())) {
				const row = self.data.at(path);
				if (row && Object.prototype.hasOwnProperty.call(row, newName)) {
					row[oldName] = row[newName];
					delete row[newName];
					self.data.updateAt(path, row);
				}
			}
		} catch (rollbackError) {
			console.error("Error rolling back rename operation data:", rollbackError);
		}
		console.error(`Error renaming column ${oldName} to ${newName}, data might be inconsistent.`, e);
		throw new SqliteError(`Failed to rename column ${oldName} to ${newName}: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL, e instanceof Error ? e : undefined);
	}
}export async function xRenameLogic(self: MemoryTable, newName: string): Promise<void> {
	// Access module's registry via this.module
	const module = self.module as any; // Cast needed to access potentially private 'tables'
	if (!module || typeof module.tables?.delete !== 'function' || typeof module.tables?.set !== 'function' || typeof module.tables?.has !== 'function') {
		throw new SqliteError("Cannot rename: Module context or table registry is invalid.", StatusCode.INTERNAL);
	}

	const oldTableKey = `${self.schemaName.toLowerCase()}.${self.tableName.toLowerCase()}`;
	const newTableKey = `${self.schemaName.toLowerCase()}.${newName.toLowerCase()}`;

	if (oldTableKey === newTableKey) return;
	if (module.tables.has(newTableKey)) {
		throw new SqliteError(`Cannot rename memory table: target name '${newName}' already exists in schema '${self.schemaName}'`);
	}

	module.tables.delete(oldTableKey);
	(self as any).tableName = newName; // Update instance property (careful with readonly)
	module.tables.set(newTableKey, self);

	if (self.tableSchema) {
		self.tableSchema = Object.freeze({ ...self.tableSchema, name: newName });
	}
	console.log(`Memory table renamed from '${oldTableKey}' to '${newName}'`);
}
export async function xAlterSchemaLogic(self: MemoryTable, changeInfo: SchemaChangeInfo): Promise<void> {
	const lockKey = `MemoryTable.SchemaChange:${self.schemaName}.${self.tableName}`;
	const release = await Latches.acquire(lockKey); // Keep lock for safety
	console.log(`MemoryTable xAlterSchema: Acquired lock for ${self.tableName}, change type: ${changeInfo.type}`);
	try {
		switch (changeInfo.type) {
			case 'addColumn': self._addColumn(changeInfo.columnDef); break;
			case 'dropColumn': self._dropColumn(changeInfo.columnName); break;
			case 'renameColumn': self._renameColumn(changeInfo.oldName, changeInfo.newName); break;
			default: throw new SqliteError(`Unsupported schema change type: ${(changeInfo as any).type}`, StatusCode.INTERNAL);
		}
	} finally {
		release();
		console.log(`MemoryTable xAlterSchema: Released lock for ${self.tableName}`);
	}
}

