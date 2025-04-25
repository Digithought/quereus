import { Path, BTree } from 'digitree';
import { SqliteError, ConstraintError } from '../../common/errors';
import { type SqlValue, StatusCode } from '../../common/types';
import type { MemoryTable, MemoryTableRow, BTreeKey } from './table';
import { ConflictResolution } from '../../common/constants';

export function addRowLogic(self: MemoryTable, row: Record<string, SqlValue>): { rowid?: bigint; } {
	if (!self.data) throw new Error("MemoryTable BTree not initialized.");

	const rowid = self.nextRowid;
	const rowWithId: MemoryTableRow = { ...row, _rowid_: rowid };
	const key = self.keyFromEntry(rowWithId);
	let existingKeyFound = false;

	if (self.data.get(key) !== undefined) {
		existingKeyFound = true;
	}

	if (!existingKeyFound && self.inTransaction) {
		if (self.pendingInserts?.has(key)) {
			existingKeyFound = true;
		} else if (self.pendingUpdates) {
			for (const update of self.pendingUpdates.values()) {
				if (self.compareKeys(update.newKey, key) === 0) {
					existingKeyFound = true;
					break;
				}
			}
		}
	}

	if (existingKeyFound) {
		return {}; // CONFLICT
	}

	self.nextRowid++;

	try {
		if (self.inTransaction) {
			if (!self.pendingInserts) self.pendingInserts = new Map();
			if (self.pendingDeletes) {
				for (const [delRowid, delInfo] of self.pendingDeletes.entries()) {
					if (self.compareKeys(delInfo.oldKey, key) === 0) {
						self.pendingDeletes.delete(delRowid);
						break;
					}
				}
			}
			self.pendingInserts.set(key, rowWithId);
		} else {
			self.data.insert(rowWithId);
			if (self.rowidToKeyMap) {
				self.rowidToKeyMap.set(rowid, key);
			}
		}
		return { rowid: rowid }; // SUCCESS
	} catch (e: any) {
		self.nextRowid = rowid; // Rollback rowid increment
		throw new SqliteError(`Internal BTree error during insert: ${e.message}`, StatusCode.INTERNAL);
	}
}

export function updateRowLogic(self: MemoryTable, rowid: bigint, newData: Record<string, SqlValue>): boolean {
	if (!self.data) throw new Error("MemoryTable BTree not initialized.");

	let existingRow: MemoryTableRow | undefined | null;
	let oldKey: BTreeKey | undefined;
	let path: Path<BTreeKey, MemoryTableRow> | null = null;
	let isPendingInsert = false;

	if (self.inTransaction) {
		const pendingUpdate = self.pendingUpdates?.get(rowid);
		if (pendingUpdate) {
			existingRow = pendingUpdate.newRow;
			oldKey = pendingUpdate.newKey;
		} else {
			for (const [key, row] of self.pendingInserts?.entries() ?? []) {
				if (row._rowid_ === rowid) {
					existingRow = row;
					oldKey = key;
					isPendingInsert = true;
					break;
				}
			}
		}
		if (self.pendingDeletes?.has(rowid)) {
			return false;
		}
	}

	if (!existingRow) {
		path = self.findPathByRowid(rowid);
		if (!path) return false;
		existingRow = self.data.at(path);
		if (!existingRow) return false;
		oldKey = self.keyFromEntry(existingRow);
	}
	if (!oldKey) throw new Error("Old key not found during update");

	const potentialNewRow: MemoryTableRow = { ...existingRow, ...newData, _rowid_: rowid };
	const newKey = self.keyFromEntry(potentialNewRow);
	const keyChanged = self.compareKeys(newKey, oldKey) !== 0;

	if (keyChanged) {
		let conflictingKeyFound = false;
		if (self.data.get(newKey) !== undefined) conflictingKeyFound = true;
		if (!conflictingKeyFound && self.inTransaction) {
			if (self.pendingInserts?.has(newKey)) conflictingKeyFound = true;
			else if (self.pendingUpdates) {
				for (const update of self.pendingUpdates.values()) {
					if (update.newRow._rowid_ !== rowid && self.compareKeys(update.newKey, newKey) === 0) {
						conflictingKeyFound = true;
						break;
					}
				}
			}
		}
		if (conflictingKeyFound) {
			const pkColName = self.getPkColNames() ?? 'rowid';
			throw new ConstraintError(`UNIQUE constraint failed: ${self.tableName}.${pkColName}`);
		}
	}

	try {
		if (self.inTransaction) {
			if (!self.pendingUpdates) self.pendingUpdates = new Map();
			if (isPendingInsert) {
				self.pendingInserts?.set(newKey, potentialNewRow);
				if (keyChanged) {
					self.pendingInserts?.delete(oldKey);
				}
			} else {
				const originalRowFromBtree = self.pendingUpdates.has(rowid) ? self.pendingUpdates.get(rowid)!.oldRow : existingRow;
				self.pendingUpdates.set(rowid, { oldRow: originalRowFromBtree, newRow: potentialNewRow, oldKey, newKey });
			}
			return true;
		} else {
			if (keyChanged) {
				if (!path) path = self.data.find(oldKey);
				if (!path || !path.on) throw new Error("Cannot find original row path for key change update");
				self.data.deleteAt(path);
				if (self.rowidToKeyMap) self.rowidToKeyMap.delete(rowid);
				self.data.insert(potentialNewRow);
				if (self.rowidToKeyMap) self.rowidToKeyMap.set(rowid, newKey);
				return true;
			} else {
				if (!path) path = self.data.find(oldKey);
				if (!path || !path.on) throw new Error("Cannot find original row path for same key update");
				self.data.updateAt(path, potentialNewRow);
				return true;
			}
		}
	} catch (e) {
		if (e instanceof ConstraintError) throw e;
		console.error("Failed to update row:", e);
		if (!self.inTransaction && keyChanged && existingRow) {
			try { if (path) self.data.deleteAt(path); self.data.insert(existingRow); if (self.rowidToKeyMap) self.rowidToKeyMap.set(rowid, oldKey); } catch { }
		}
		throw new SqliteError(`Internal BTree error during update: ${e instanceof Error ? e.message : String(e)}`, StatusCode.INTERNAL);
	}
}

export function deleteRowLogic(self: MemoryTable, rowid: bigint): boolean {
	if (!self.data) throw new Error("MemoryTable BTree not initialized.");

	if (self.inTransaction) {
		let foundPendingInsert = false;
		if (self.pendingInserts) {
			for (const [key, row] of self.pendingInserts.entries()) {
				if (row._rowid_ === rowid) {
					self.pendingInserts.delete(key);
					foundPendingInsert = true;
					break;
				}
			}
		}
		if (foundPendingInsert) return true;

		const pendingUpdate = self.pendingUpdates?.get(rowid);
		if (pendingUpdate) {
			if (!self.pendingDeletes) self.pendingDeletes = new Map();
			self.pendingDeletes.set(rowid, { oldRow: pendingUpdate.oldRow, oldKey: pendingUpdate.oldKey });
			self.pendingUpdates?.delete(rowid);
			return true;
		}

		const path = self.findPathByRowid(rowid);
		if (!path) return false;
		const oldRow = self.data.at(path);
		if (!oldRow) return false;
		const oldKey = self.keyFromEntry(oldRow);

		if (!self.pendingDeletes) self.pendingDeletes = new Map();
		self.pendingDeletes.set(rowid, { oldRow, oldKey });
		return true;

	} else {
		const path = self.findPathByRowid(rowid);
		if (!path) return false;
		try {
			self.data.deleteAt(path);
			if (self.rowidToKeyMap) {
				self.rowidToKeyMap.delete(rowid);
			}
			return true;
		} catch (e) {
			console.error("BTree deleteAt failed:", e);
			return false;
		}
	}
}

export function clearLogic(self: MemoryTable): void {
	if (self.data) {
		self.data = new BTree<BTreeKey, MemoryTableRow>(self.keyFromEntry, self.compareKeys);
	}
	if (self.rowidToKeyMap) {
		self.rowidToKeyMap.clear();
	}
	self.nextRowid = BigInt(1);
}export async function xUpdateLogic(self: MemoryTable, values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint; }> {
	if (self.isReadOnly()) {
		throw new SqliteError(`Table '${self.tableName}' is read-only`, StatusCode.READONLY);
	}
	const onConflict = (values as any)._onConflict || ConflictResolution.ABORT;

	try {
		if (values.length === 1 && typeof values[0] === 'bigint') { // DELETE
			self.deleteRow(values[0]); return {};
		} else if (values.length > 1 && values[0] === null) { // INSERT
			const data = Object.fromEntries(self.columns.map((col, idx) => [col.name, values[idx + 1]]));
			const addResult = self.addRow(data);
			if (addResult.rowid !== undefined) return { rowid: addResult.rowid };
			else if (onConflict === ConflictResolution.IGNORE) return {};
			else { const pkColName = self.getPkColNames() ?? 'rowid'; throw new ConstraintError(`UNIQUE constraint failed: ${self.tableName}.${pkColName}`); }
		} else if (values.length > 1 && typeof values[0] === 'bigint') { // UPDATE
			const targetRowid = values[0];
			const data = Object.fromEntries(self.columns.map((col, idx) => [col.name, values[idx + 1]]));
			try {
				const updated = self.updateRow(targetRowid, data);
				if (!updated) throw new SqliteError(`Update failed for rowid ${targetRowid}`, StatusCode.NOTFOUND);
				return {};
			} catch (e) {
				if (e instanceof ConstraintError && onConflict === ConflictResolution.IGNORE) return {};
				else throw e;
			}
		} else {
			throw new SqliteError("Unsupported arguments for xUpdate", StatusCode.ERROR);
		}
	} finally {
		// Release lock if we were using one per call
	}
}

