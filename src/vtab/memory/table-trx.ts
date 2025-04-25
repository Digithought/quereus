import type { MemoryTable, BTreeKey, MemoryTableRow } from './table';

export function xBeginLogic(self: MemoryTable): Promise<void> {
	try {
		if (!self.inTransaction) {
			self.inTransaction = true;
			self.pendingInserts = new Map();
			self.pendingUpdates = new Map();
			self.pendingDeletes = new Map();
		} else {
			// According to SQLite docs, BEGIN is a no-op inside a transaction
			// but we can warn if savepoints aren't being used.
			console.warn(`MemoryTable ${self.tableName}: BEGIN called inside an active transaction.`);
		}
	} finally { }
	return Promise.resolve(); // xBegin is synchronous in behavior
}

export async function xCommitLogic(self: MemoryTable): Promise<void> {
	try {
		if (!self.inTransaction) return; // Commit without begin is no-op
		if (!self.data) throw new Error("MemoryTable BTree not initialized during commit.");

		// Apply pending changes
		// Order matters: Deletes, Updates (handle key changes), Inserts
		if (self.pendingDeletes) {
			for (const [rowid, delInfo] of self.pendingDeletes.entries()) {
				const path = self.data.find(delInfo.oldKey);
				if (path.on) { try { self.data.deleteAt(path); if (self.rowidToKeyMap) self.rowidToKeyMap.delete(rowid); } catch (e) { console.error(`Commit: Failed to delete rowid ${rowid}`, e); } }
			}
		}
		if (self.pendingUpdates) {
			for (const [rowid, upInfo] of self.pendingUpdates.entries()) {
				const keyChanged = self.compareKeys(upInfo.oldKey, upInfo.newKey) !== 0;
				if (keyChanged) {
					if (!self.pendingDeletes?.has(rowid)) { const oldPath = self.data.find(upInfo.oldKey); if (oldPath.on) { try { self.data.deleteAt(oldPath); } catch (e) { console.warn(`Commit Update: Failed to delete old key ${upInfo.oldKey}`, e); } } }
					if (self.rowidToKeyMap) self.rowidToKeyMap.delete(rowid);
					try { self.data.insert(upInfo.newRow); if (self.rowidToKeyMap) self.rowidToKeyMap.set(rowid, upInfo.newKey); } catch (e) { console.error(`Commit: Failed to insert updated rowid ${rowid}`, e); }
				} else {
					const path = self.data.find(upInfo.oldKey);
					if (path.on) { try { self.data.updateAt(path, upInfo.newRow); } catch (e) { console.error(`Commit: Failed to update in-place rowid ${rowid}`, e); } }
					else { console.warn(`Commit Update: Rowid ${rowid} not found for in-place update.`); }
				}
			}
		}
		if (self.pendingInserts) {
			for (const [key, row] of self.pendingInserts.entries()) {
				try { self.data.insert(row); if (self.rowidToKeyMap) self.rowidToKeyMap.set(row._rowid_, key); } catch (e) { console.error(`Commit: Failed to insert rowid ${row._rowid_}`, e); }
			}
		}

		// Clear transaction state
		self.pendingInserts = null; self.pendingUpdates = null; self.pendingDeletes = null;
		self.inTransaction = false;
		self.savepoints = []; // Clear savepoints on commit
	} finally { }
}

export async function xRollbackLogic(self: MemoryTable): Promise<void> {
	try {
		if (!self.inTransaction) return; // Rollback without begin is no-op
		// Just discard pending changes
		self.pendingInserts = null; self.pendingUpdates = null; self.pendingDeletes = null;
		self.inTransaction = false;
		self.savepoints = []; // Clear savepoints on rollback
	} finally { }
}

export function createSavepointLogic(self: MemoryTable, savepointIndex: number): void {
	if (!self.inTransaction) {
		// It's an error to SAVEPOINT outside a transaction in SQLite
		// We could throw, but maybe just warn for now?
		console.warn(`MemoryTable ${self.tableName}: SAVEPOINT called outside of a transaction.`);
		return;
	}
	while (self.savepoints.length < savepointIndex) {
		console.warn(`MemoryTable ${self.tableName}: Filling missing savepoint index ${self.savepoints.length}`);
		// Use the helper function correctly
		const previousState = self.savepoints.length > 0 ? self.savepoints[self.savepoints.length - 1] : createBufferSnapshotLogic(self);
		self.savepoints.push(previousState);
	}
	// Use the helper function correctly
	self.savepoints[savepointIndex] = createBufferSnapshotLogic(self);
	console.log(`MemoryTable ${self.tableName}: Created savepoint at index ${savepointIndex}`);
}

export function releaseSavepointLogic(self: MemoryTable, savepointIndex: number): void {
	if (!self.inTransaction) return;
	if (savepointIndex >= 0 && savepointIndex < self.savepoints.length) {
		self.savepoints.length = savepointIndex; // Discard this and subsequent savepoints
		 console.log(`MemoryTable ${self.tableName}: Released savepoints from index ${savepointIndex}`);
	}
}

export function rollbackToSavepointLogic(self: MemoryTable, savepointIndex: number): void {
	if (!self.inTransaction) return;
	if (savepointIndex < 0 || savepointIndex >= self.savepoints.length) {
		// SQLite seems to ignore invalid savepoint names/indices in ROLLBACK TO
		console.warn(`MemoryTable ${self.tableName}: Invalid savepoint index ${savepointIndex} for rollback.`);
		return;
	}
	// Restore buffer state from the specified savepoint
	const savedState = self.savepoints[savepointIndex];
	self.pendingInserts = new Map(savedState.inserts);
	self.pendingUpdates = new Map(savedState.updates);
	self.pendingDeletes = new Map(savedState.deletes);

	// Discard subsequent savepoints
	self.savepoints.length = savepointIndex; // Crucially, don't keep the one we rolled back to when using RELEASE
										// For ROLLBACK TO, we should keep the target savepoint, but discard later ones.
										// Correction: SQLite discards the target savepoint and all subsequent ones upon ROLLBACK TO.
	self.savepoints.length = savepointIndex;

	console.log(`MemoryTable ${self.tableName}: Rolled back to savepoint index ${savepointIndex}`);
}

// Moved from memory-table-logic
export function createBufferSnapshotLogic(self: MemoryTable): {
	inserts: Map<BTreeKey, MemoryTableRow>;
	updates: Map<bigint, { oldRow: MemoryTableRow, newRow: MemoryTableRow, oldKey: BTreeKey, newKey: BTreeKey }>;
	deletes: Map<bigint, { oldRow: MemoryTableRow, oldKey: BTreeKey }>;
} {
	return {
		inserts: new Map(self.pendingInserts ?? []),
		updates: new Map(self.pendingUpdates ?? []),
		deletes: new Map(self.pendingDeletes ?? []),
	};
}
