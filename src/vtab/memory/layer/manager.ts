import type { Database } from '../../../core/database.js';
import type { TableSchema, IndexSchema } from '../../../schema/table.js';
import type { MemoryTableRow, BTreeKey } from '../types.js';
import { StatusCode, type SqlValue } from '../../../common/types.js';
import { BaseLayer } from './base.js';
import { TransactionLayer } from './transaction.js';
import type { Layer, ModificationKey, ModificationValue, DeletionMarker } from './interface.js';
import { isDeletionMarker, DELETED } from '../types.js';
import { MemoryTableConnection } from './connection.js';
import { Latches } from '../../../util/latches.js'; // Simple async lock
import { QuereusError, ConstraintError } from '../../../common/errors.js';
import { ConflictResolution, IndexConstraintOp } from '../../../common/constants.js';
import { MemoryIndex } from '../index.js'; // Needed for index ops
import type { ColumnDef } from '../../../parser/ast.js'; // Needed for schema ops
import { buildColumnIndexMap, columnDefToSchema } from '../../../schema/table.js'; // Needed for schema ops
import { compareSqlValues } from '../../../util/comparison.js'; // Import for comparison functions
import { createLogger } from '../../../common/logger.js'; // Import logger
import { safeJsonStringify } from '../../../util/serialization.js';
import { createBaseLayerPkFunctions } from './base.js'; // Import the new helper
import type { ScanPlan } from './scan-plan.js'; // Added ScanPlan

let tableManagerCounter = 0;
const log = createLogger('vtab:memory:layer:manager'); // Create logger
const warnLog = log.extend('warn');
const errorLog = log.extend('error');
const debugLog = log; // Use base log for debug level

/**
 * Manages the state and operations for a MemoryTable using the layer-based MVCC model.
 * This class holds the base layer, committed layer pointer, active connections,
 * and handles commit, collapse, and lookup logic.
 */
export class MemoryTableManager {
	public readonly managerId: number;
	public readonly db: Database;
	public readonly schemaName: string;
	public readonly tableName: string;
	private readonly module: any; // Reference to the MemoryTableModule instance
	private readonly vtabAux: unknown; // Auxiliary data from module registration

	private baseLayer: BaseLayer;
	private currentCommittedLayer: Layer;
	// Map connection ID to connection state object
	private connections: Map<number, MemoryTableConnection> = new Map();
	private nextConnectionId: number = 0;
	// No longer need an instance variable for Latches since we'll use static methods
	private nextRowid: bigint = BigInt(1); // TODO: Needs locking for concurrent access
	private readOnly: boolean;
	public tableSchema: TableSchema; // The *current* canonical schema

	// --- Primary Key / Indexing Info (derived from initial schema) ---
	// These are needed for operations like lookups and applying changes.
	// They reflect the *current* schema state managed by the manager.
	private pkIndices: ReadonlyArray<number> = [];
	private pkIsRowid: boolean = true;
	private comparePrimaryKeys: (a: BTreeKey, b: BTreeKey) => number;
	private primaryKeyFromRow: (row: MemoryTableRow) => BTreeKey;
	// Helper to get columns info easily
	private get columnInfo(): ReadonlyArray<{ name: string, type: SqlValue, collation?: string }> {
		return this.tableSchema.columns.map(cs => ({
			name: cs.name,
			type: cs.affinity, // Use affinity which is the correct property
			collation: cs.collation
		}));
	}
	// --- ---

	constructor(
		db: Database,
		module: any, // Assuming MemoryTableModule type structure
		pAux: unknown,
		moduleName: string, // Used in TableSchema
		schemaName: string,
		tableName: string,
		initialSchema: TableSchema, // Pass the fully constructed schema
		readOnly: boolean = false
	) {
		this.managerId = tableManagerCounter++;
		this.db = db;
		this.module = module;
		this.vtabAux = pAux;
		this.schemaName = schemaName;
		this.tableName = tableName;
		this.tableSchema = initialSchema; // Store the canonical schema
		this.readOnly = readOnly;

		this.pkIndices = Object.freeze(this.tableSchema.primaryKeyDefinition.map(def => def.index));
		this.pkIsRowid = this.pkIndices.length === 0;

		// Get BTree functions for the primary index based on the *current* canonical schema
		const primaryPkFuncs = createBaseLayerPkFunctions(this.tableSchema); // Use the same helper as BaseLayer
		this.primaryKeyFromRow = primaryPkFuncs.keyFromEntry;
		this.comparePrimaryKeys = primaryPkFuncs.compareKeys;

		const needsRowidMap = !this.pkIsRowid;

		this.baseLayer = new BaseLayer(
			this.tableSchema,
			this.tableSchema.columns.map(c => ({ name: c.name })), // Pass column names for MemoryIndex
			needsRowidMap
		);

		// Initialize secondary indexes in the BaseLayer (already handled by BaseLayer constructor)
		this.currentCommittedLayer = this.baseLayer;
	}

	/** Connects a new client/statement to this table */
	connect(): MemoryTableConnection {
		const connection = new MemoryTableConnection(this, this.currentCommittedLayer);
		this.connections.set(connection.connectionId, connection);
		return connection;
	}

	/** Disconnects a client/statement */
	disconnect(connectionId: number): void {
		const connection = this.connections.get(connectionId);
		if (connection) {
			// If the connection had pending changes, commit or roll them back
			if (connection.pendingTransactionLayer) {
				// Check autocommit status of the parent DB
				if (this.db.getAutocommit()) {
					// Use namespaced warn logger
					warnLog(`Connection %d disconnecting with pending transaction in autocommit mode; committing.`, connectionId);
					// Commit the transaction instead of rolling back in autocommit mode
					// Need to await commit, making disconnect async
					// Use a separate async function to handle this to keep disconnect sync if possible?
					// Let's make disconnect async for simplicity for now.
					this.commitTransaction(connection).catch(err => {
						// Use namespaced error logger
						errorLog(`Error during implicit commit on disconnect for connection %d: %O`, connectionId, err);
						// Even if commit fails, proceed with disconnect cleanup
					});
				} else {
					// Use namespaced warn logger
					warnLog(`Connection %d disconnected with pending transaction (explicit transaction active); rolling back.`, connectionId);
					connection.rollback(); // Standard rollback if not in autocommit
				}
			}
			this.connections.delete(connectionId);
			// After disconnecting, try to collapse layers as this connection might have been holding one up
			this.tryCollapseLayers().catch(err => {
				// Use namespaced error logger
				errorLog(`Error during layer collapse after disconnect: %O`, err);
			});
		}
	}

	/**
	 * Commits the transaction associated with the given connection.
	 * Updates the global committed layer pointer and the connection's read layer.
	 * Triggers a layer collapse attempt.
	 */
	async commitTransaction(connection: MemoryTableConnection): Promise<void> {
		if (this.readOnly) {
			throw new QuereusError(`Table ${this.tableName} is read-only`, StatusCode.READONLY);
		}
		const pendingLayer = connection.pendingTransactionLayer;
		if (!pendingLayer) {
			// Commit without pending changes is a no-op
			return;
		}

		const lockKey = `MemoryTable.Commit:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey); // Use the static method
		// Use namespaced debug logger
		debugLog(`[Commit %d] Acquired lock for %s`, connection.connectionId, this.tableName);
		try {
			// --- Staleness Check (Optimistic Concurrency Control) ---
			// If the parent of the layer we are trying to commit is NOT the *current*
			// globally committed layer, it means another transaction committed in between,
			// and this transaction was based on stale data.
			if (pendingLayer.getParent() !== this.currentCommittedLayer) {
				// Rollback the pending changes automatically
				connection.pendingTransactionLayer = null;
				// Use namespaced warn logger
				warnLog(`[Commit %d] Stale commit detected for %s. Rolling back.`, connection.connectionId, this.tableName);
				// TODO: Should this throw busy or similar? Standard behavior might depend on isolation level.
				// For now, treat as a failed commit leading to automatic rollback.
				throw new QuereusError(`Commit failed due to concurrent update (staleness check failed) on table ${this.tableName}`, StatusCode.BUSY); // Or StatusCode.ABORT?
			}

			// Mark the pending layer as committed (making it immutable)
			pendingLayer.markCommitted();

			// Update the global pointer to the newest committed layer
			this.currentCommittedLayer = pendingLayer;
			// Use namespaced debug logger
			debugLog(`[Commit %d] Updated currentCommittedLayer to %d for %s`, connection.connectionId, pendingLayer.getLayerId(), this.tableName);

			// Update this connection's state
			connection.readLayer = pendingLayer; // Subsequent reads by this connection see its own commit
			connection.pendingTransactionLayer = null; // Clear pending layer

			// Attempt to collapse layers asynchronously (don't block commit)
			this.tryCollapseLayers().catch(err => {
				// Use namespaced error logger
				errorLog(`[Commit %d] Error during background layer collapse: %O`, connection.connectionId, err);
			});

		} finally {
			release();
			// Use namespaced debug logger
			debugLog(`[Commit %d] Released lock for %s`, connection.connectionId, this.tableName);
		}
	}

	/**
	 * Attempts to merge committed TransactionLayers into the BaseLayer
	 * if they are no longer needed by any active connections.
	 */
	async tryCollapseLayers(): Promise<void> {
		const lockKey = `MemoryTable.Collapse:${this.schemaName}.${this.tableName}`;
		// We don't have a tryAcquire method in the Latches class, so use a timeout with acquire
		let release: (() => void) | null = null;
		try {
			// Set a short timeout to acquire the lock
			const acquirePromise = Latches.acquire(lockKey);
			const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 50));

			// Race between acquiring the lock and the timeout
			const result = await Promise.race([
				acquirePromise.then(releaseFn => ({ release: releaseFn })),
				timeoutPromise.then(() => ({ release: null }))
			]);

			release = result.release;

			if (!release) {
				// Use namespaced debug logger
				debugLog(`[Collapse] Lock busy for %s, skipping collapse attempt.`, this.tableName);
				return; // Another collapse is likely in progress or we timed out
			}

			// Use namespaced debug logger
			debugLog(`[Collapse] Acquired lock for %s`, this.tableName);

			let collapsedCount = 0;
			// Loop as long as the current committed layer is mergeable
			while (true) {
				const layerToMerge = this.currentCommittedLayer;

				// Conditions for merging:
				// 1. Must be a TransactionLayer (i.e., not the BaseLayer)
				// 2. Must be committed
				// 3. Must have a parent (which BaseLayer doesn't)
				// 4. No active connection should be reading directly from its *parent* layer.
				//    (It's okay if connections read from layerToMerge itself, they will be updated).
				if (!(layerToMerge instanceof TransactionLayer) || !layerToMerge.isCommitted()) {
					debugLog(`[Collapse] Layer ${layerToMerge.getLayerId()} is base or not committed. Stopping.`);
					break; // Cannot merge base layer or uncommitted layer
				}

				const parentLayer = layerToMerge.getParent();
				if (!parentLayer) {
					errorLog(`[Collapse] Committed TransactionLayer ${layerToMerge.getLayerId()} has no parent!`);
					break; // Should not happen
				}

				// Check if any connection is still reading from the parent layer
				let parentInUse = false;
				for (const conn of this.connections.values()) {
					// Check both the official readLayer and any pending layer's parent
					if (conn.readLayer === parentLayer || conn.pendingTransactionLayer?.getParent() === parentLayer) {
						parentInUse = true;
						// Use namespaced debug logger
						debugLog(`[Collapse] Parent layer %d still in use by connection %d. Cannot merge layer %d.`, parentLayer.getLayerId(), conn.connectionId, layerToMerge.getLayerId());
						break;
					}
				}

				if (parentInUse) {
					break; // Cannot merge yet
				}

				// --- Perform the Merge ---
				// Use namespaced debug logger
				debugLog(`[Collapse] Merging layer %d into parent %d (eventually base) for %s`, layerToMerge.getLayerId(), parentLayer.getLayerId(), this.tableName);
				this.applyLayerToBase(layerToMerge);

				// Update the global committed layer pointer to the parent
				this.currentCommittedLayer = parentLayer;
				// Use namespaced debug logger
				debugLog(`[Collapse] Updated currentCommittedLayer to %d for %s`, parentLayer.getLayerId(), this.tableName);

				// Update any connections that were reading from the merged layer to now read from the parent
				for (const conn of this.connections.values()) {
					if (conn.readLayer === layerToMerge) {
						conn.readLayer = parentLayer;
						// Use namespaced debug logger
						debugLog(`[Collapse] Updated connection %d readLayer to %d`, conn.connectionId, parentLayer.getLayerId());
					}
				}

				// The layerToMerge is now effectively discarded (GC will handle it)
				collapsedCount++;
			}
			if (collapsedCount > 0) {
				// Use namespaced debug logger
				debugLog(`[Collapse] Merged %d layer(s) for %s. Current committed layer: %d`, collapsedCount, this.tableName, this.currentCommittedLayer.getLayerId());
			} else {
				debugLog(`[Collapse] No layers eligible for merging for ${this.tableName}.`);
			}

		} catch (e) {
			// Use namespaced error logger
			errorLog(`[Collapse] Error during layer collapse for %s: %O`, this.tableName, e);
			// Consider marking the table as potentially corrupt or needing recovery?
		} finally {
			if (release) {
				release();
				// Use namespaced debug logger
				debugLog(`[Collapse] Released lock for %s`, this.tableName);
			}
		}
	}

	/**
	 * Applies the changes from a TransactionLayer directly to the BaseLayer.
	 * This MUST be called under the managementLock.
	 */
	private applyLayerToBase(layer: TransactionLayer): void {
		if (!this.baseLayer) {
			throw new Error("Cannot apply layer: BaseLayer is not initialized.");
		}
		const parentLayer = layer.getParent();
		if (!parentLayer) {
			throw new Error("Cannot apply layer: Merging layer has no parent.");
		}

		const primaryModTree = layer.getModificationTree('primary');
		if (primaryModTree) {
			const primaryModKeyExtractor = layer.getKeyExtractor('primary');
			for (const path of primaryModTree.ascending(primaryModTree.first())) {
				const modValue = primaryModTree.at(path);
				if (modValue === undefined) continue;
				const primaryKey = primaryModKeyExtractor(modValue);
				const oldEffectiveValue = this.lookupEffectiveValueInternal(primaryKey, 'primary', parentLayer);
				try {
					const oldRowTuple = oldEffectiveValue !== undefined && !isDeletionMarker(oldEffectiveValue) ? oldEffectiveValue as MemoryTableRow : null;
					this.baseLayer.applyChange(primaryKey as BTreeKey, modValue, oldRowTuple);
				} catch (applyError) {
					errorLog(`[Collapse Apply] Failed for PK %s from layer %d to base. Table %s. Error: %O`, safeJsonStringify(primaryKey), layer.getLayerId(), this.tableName, applyError);
					throw applyError;
				}
			}
		}

		for (const rowid of layer.getDeletedRowids()) {
			const pk = this.findPrimaryKeyForRowid(rowid, parentLayer);
			if (pk !== null) {
				const oldEffectiveValue = this.lookupEffectiveValueInternal(pk, 'primary', parentLayer);
				const currentBaseValue = this.baseLayer.primaryTree.get(pk);
				if (currentBaseValue !== undefined) {
					debugLog(`[Collapse Apply] Explicit delete for rowid %s (PK: %s) from layer %d to base.`, rowid, safeJsonStringify(pk), layer.getLayerId());
					try {
						const deletionMarker: DeletionMarker = { _marker_: DELETED, _key_: pk, _rowid_: rowid };
						const oldRowTuple = oldEffectiveValue !== undefined && !isDeletionMarker(oldEffectiveValue) ? oldEffectiveValue as MemoryTableRow : null;
						this.baseLayer.applyChange(pk, deletionMarker, oldRowTuple);
					} catch (applyError) {
						errorLog(`[Collapse Apply] Failed explicit delete for rowid %s (PK: %s). Error: %O`, rowid, safeJsonStringify(pk), applyError);
						throw applyError;
					}
				}
			} else {
				debugLog(`[Collapse Apply] Explicitly deleted rowid ${rowid} from layer ${layer.getLayerId()} had no PK in parent.`);
			}
		}
	}

	/**
	 * Looks up the effective value (row or deletion marker) for a key in a specific index,
	 * starting the search from a given layer and going down the chain.
	 *
	 * @param key The index-specific key (BTreeKey for primary, [IndexKey, rowid] for secondary mods)
	 * @param indexName Index name or 'primary'
	 * @param startLayer The layer to begin searching from
	 * @returns The effective value (MemoryTableRow or DELETED) or null if not found
	 */
	lookupEffectiveValue(key: ModificationKey, indexName: string | 'primary', startLayer: Layer): ModificationValue | null {
		// Public facing method, ensures base case returns null if not found
		const result = this.lookupEffectiveValueInternal(key, indexName, startLayer);
		return result === undefined ? null : result;
	}

	/** Internal recursive implementation for lookup */
	private lookupEffectiveValueInternal(
		key: ModificationKey,
		indexName: string | 'primary',
		currentLayer: Layer | null
	): ModificationValue | undefined {
		if (!currentLayer) {
			return undefined; // Reached end of chain without finding
		}

		// 1. Check modifications in the current layer
		if (currentLayer instanceof TransactionLayer) {
			const modTree = currentLayer.getModificationTree(indexName);
			if (modTree) {
				// Need BTree funcs for the schema *at the time currentLayer was created*
				const keyExtractor = currentLayer.getKeyExtractor(indexName); // Use layer's own extractor

				// Find using the key directly, BTree uses its internal funcs
				const path = modTree.find(key);

				if (path.on) {
					// Need to potentially iterate if keys aren't unique in mod tree
					// (e.g., secondary index mods using [Key, rowid])
					let foundValue: ModificationValue | undefined = undefined;
					const iter = modTree.ascending(path); // Start from found path
					for (const p of iter) {
						const val = modTree.at(p);
						if (val === undefined) continue;
						const currentKey = keyExtractor(val);

						// Compare the actual ModificationKeys fully
						if (this.compareModificationKeys(currentKey, key, indexName, currentLayer.getSchema()) === 0) {
							foundValue = val;
							break; // Found exact key match
						}
						// If the key part no longer matches, stop iterating
						if (this.compareModificationKeys(currentKey, key, indexName, currentLayer.getSchema()) !== 0) {
							break;
						}
					}

					if (foundValue !== undefined) {
						// Found modification in this layer, return it (could be row or DeletionMarker)
						return foundValue;
					}
				}
			}
			// If primary index, also check the layer's specific deleted set by rowid *if* the key includes it
			if (indexName !== 'primary' && Array.isArray(key)) {
				const rowid = key[1] as bigint; // Assert bigint type
				if (currentLayer.getDeletedRowids().has(rowid)) {
					// Construct and return the DeletionMarker
					const marker: DeletionMarker = { _marker_: DELETED, _key_: key, _rowid_: rowid };
					return marker;
				}
			} else if (indexName === 'primary' && typeof key === 'bigint' && this.pkIsRowid) {
				// If primary key is rowid
				if (currentLayer.getDeletedRowids().has(key)) {
					// Construct and return the DeletionMarker
					const marker: DeletionMarker = { _marker_: DELETED, _key_: key, _rowid_: key };
					return marker;
				}
			} else if (indexName === 'primary' && !this.pkIsRowid) {
				// If primary key is not rowid, we need to find the rowid associated with the PK
				// This is complex without a reverse map or iterating mods.
				// Let's assume the modTree check or explicit delete set check is sufficient for now.
				// A full solution might require iterating mods to find the rowid for the PK if deleted.
				// *But* if the modTree check above returned a DeletionMarker for this PK, we should have caught it.
				// If it didn't, and the rowid isn't explicitly deleted, we should proceed to the parent.
			}
		} else if (currentLayer instanceof BaseLayer) {
			// 2. Reached the BaseLayer
			const baseLayer = currentLayer as BaseLayer;
			if (indexName === 'primary') {
				const value = baseLayer.primaryTree.get(key as BTreeKey);
				return value; // Returns MemoryTableRow or undefined
			} else {
				// Lookup in base secondary index requires the full [IndexKey, rowid] pair
				const secondaryTree = baseLayer.getSecondaryIndexTree(indexName);
				if (secondaryTree) {
					// The key for lookup *is* the value stored
					const value = secondaryTree.get(key as [BTreeKey, bigint]);
					if (value !== undefined) {
						// Found the index entry [IndexKey, rowid]. Need the actual row.
						const rowid = value[1];
						const primaryKey = baseLayer.rowidToKeyMap?.get(rowid) ?? (this.pkIsRowid ? rowid : null);
						if (primaryKey !== null) {
							const row = baseLayer.primaryTree.get(primaryKey);
							return row; // Returns MemoryTableRow or undefined
						}
					}
				}
				return undefined; // Not found in this secondary index
			}
		}

		// 3. Not found in current layer, recurse down to parent
		return this.lookupEffectiveValueInternal(key, indexName, currentLayer.getParent());
	}

	/** Finds the primary key for a given rowid by searching down the layer chain */
	private findPrimaryKeyForRowid(rowid: bigint, startLayer: Layer | null): BTreeKey | null {
		let currentLayer = startLayer;
		while (currentLayer) {
			if (currentLayer instanceof TransactionLayer) {
				let foundKey: BTreeKey | null = null;
				const primaryModTree = currentLayer.getModificationTree('primary');
				if (primaryModTree) {
					const pkExtractor = currentLayer.getKeyExtractor('primary');
					for (const path of primaryModTree.ascending(primaryModTree.first())) {
						const modValue = primaryModTree.at(path);
						if (modValue && !isDeletionMarker(modValue)) {
							const rowTuple = modValue as MemoryTableRow;
							if (rowTuple[0] === rowid) {
								foundKey = pkExtractor(modValue) as BTreeKey;
								break;
							}
						} else if (modValue && isDeletionMarker(modValue)) {
							if (modValue._rowid_ === rowid) {
								break;
							}
						}
					}
				}
				if (foundKey !== null) return foundKey;
				if (currentLayer.getDeletedRowids().has(rowid)) { currentLayer = currentLayer.getParent(); continue; }
			} else if (currentLayer instanceof BaseLayer) {
				if (currentLayer.rowidToKeyMap) return currentLayer.rowidToKeyMap.get(rowid) ?? null;
				else if (this.pkIsRowid) return currentLayer.primaryTree.get(rowid) !== undefined ? rowid : null;
				else return null;
			}
			currentLayer = currentLayer.getParent();
		}
		return null;
	}

	/** Gets the next available rowid (requires locking) */
	async getNextRowid(): Promise<bigint> {
		const lockKey = `MemoryTable.Rowid:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey); // Use static method
		try {
			const id = this.nextRowid;
			this.nextRowid++;
			return id;
		} finally {
			release();
		}
	}

	/** Helper to get BTree key extractor and comparator for a specific index, based on a given schema */
	private getBTreeFuncsForIndex(indexName: string | 'primary', schema: TableSchema): {
		keyExtractor: (value: ModificationValue) => ModificationKey | BTreeKey; // Adjusted return for primary/secondary logic
		comparator: (a: BTreeKey, b: BTreeKey) => number;
	} {
		if (indexName === 'primary') {
			const pkDef = schema.primaryKeyDefinition ?? [];
			if (pkDef.length === 0) { // Rowid key
				return {
					keyExtractor: (value) => isDeletionMarker(value) ? value._key_ as BTreeKey : (value as MemoryTableRow)[0],
					comparator: (a, b) => compareSqlValues(a as bigint, b as bigint)
				};
			} else if (pkDef.length === 1) { // Single column PK
				const { index: pkSchemaIndex, desc: isDesc, collation } = pkDef[0];
				return {
					keyExtractor: (value) => isDeletionMarker(value) ? value._key_ as BTreeKey : (value as MemoryTableRow)[1][pkSchemaIndex],
					comparator: (a, b) => { const cmp = compareSqlValues(a as SqlValue, b as SqlValue, collation || 'BINARY'); return isDesc ? -cmp : cmp; }
				};
			} else { // Composite PK
				const pkColSchemaIndices = pkDef.map(def => def.index);
				return {
					keyExtractor: (value) => isDeletionMarker(value) ? value._key_ as SqlValue[] : pkColSchemaIndices.map(i => (value as MemoryTableRow)[1][i]),
					comparator: (a, b) => {
						const arrA = a as SqlValue[]; const arrB = b as SqlValue[];
						for (let i = 0; i < pkDef.length; i++) {
							if (i >= arrA.length || i >= arrB.length) return arrA.length - arrB.length;
							const def = pkDef[i];
							const dirMultiplier = def.desc ? -1 : 1;
							const collation = def.collation || 'BINARY';
							const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
							if (cmp !== 0) return cmp;
						}
						return arrA.length - arrB.length;
					}
				};
			}
		} else { // Secondary Index
			const indexSchema = schema.indexes?.find(idx => idx.name === indexName);
			if (!indexSchema) throw new Error(`Secondary index ${indexName} not found in schema for getBTreeFuncsForIndex`);
			// MemoryIndex needs table column *names* for its own spec interpretation if names were used in IndexSpec.columns
			// However, our IndexSchema from tableSchema.indexes has .columns with .index (schema index), .desc, .collation.
			// MemoryIndex constructor was updated to use these direct indices.
			const tableColNames = schema.columns.map(c => ({ name: c.name }));
			const tempIndex = new MemoryIndex({ name: indexSchema.name, columns: indexSchema.columns }, tableColNames);
			return {
				keyExtractor: (value) => { // This should return BTreeKey (the actual index key part)
					if (isDeletionMarker(value)) {
						// _key_ for secondary index deletion marker is [IndexKey, rowid]
						return (value._key_ as [BTreeKey, bigint])[0];
					} else {
						// value is MemoryTableRow tuple [rowid, data_array]
						return tempIndex.keyFromRow(value as MemoryTableRow);
					}
				},
				comparator: tempIndex.compareKeys // This compares BTreeKeys (IndexKey parts)
			};
		}
	}

	/** Compares two ModificationKeys based on index type and schema */
	private compareModificationKeys(keyA: ModificationKey, keyB: ModificationKey, indexName: string | 'primary', schema: TableSchema): number {
		const { comparator: btreeKeyComparator } = this.getBTreeFuncsForIndex(indexName, schema);

		if (indexName === 'primary') {
			return btreeKeyComparator(keyA as BTreeKey, keyB as BTreeKey);
		} else {
			// Secondary index: key is [IndexKey, rowid]
			const [indexKeyA, rowidA] = keyA as [BTreeKey, bigint];
			const [indexKeyB, rowidB] = keyB as [BTreeKey, bigint];

			const keyCmp = btreeKeyComparator(indexKeyA, indexKeyB);
			if (keyCmp !== 0) return keyCmp;

			// If index keys are equal, compare rowids
			return compareSqlValues(rowidA, rowidB);
		}
	}

	// --- Schema Operations ---
	// These need the management lock and potentially layer collapse checks

	async addColumn(columnDef: ColumnDef): Promise<void> {
		if (this.readOnly) throw new QuereusError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);
		try {
			// Check if safe to modify schema (ideally only base layer exists)
			await this.ensureSchemaChangeSafety();

			const newColNameLower = columnDef.name.toLowerCase();
			if (this.tableSchema.columns.some(c => c.name.toLowerCase() === newColNameLower)) {
				throw new QuereusError(`Duplicate column name: ${columnDef.name}`, StatusCode.ERROR);
			}
			const defaultValue = null; // TODO: Handle column defaults

			const newColumnSchema = columnDefToSchema(columnDef);
			const oldTableSchema = this.tableSchema;

			// Update canonical schema
			const updatedColumnsSchema = [...oldTableSchema.columns, newColumnSchema];
			this.tableSchema = Object.freeze({
				...oldTableSchema,
				columns: updatedColumnsSchema,
				columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
			});

			// Apply change to BaseLayer data (assuming it's safe)
			this.baseLayer.addColumnToBase(newColumnSchema.name, defaultValue);

			// TODO: How to handle layers created with the old schema during collapse?
			// BaseLayer.applyChange might need schema context passed in.

			// Use namespaced log
			log(`MemoryTable %s: Added column %s`, this.tableName, newColumnSchema.name);
		} finally {
			release();
		}
	}

	async dropColumn(columnName: string): Promise<void> {
		if (this.readOnly) throw new QuereusError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);
		try {
			await this.ensureSchemaChangeSafety();
			const colNameLower = columnName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
			if (colIndex === -1) throw new QuereusError(`Column not found: ${columnName}`, StatusCode.ERROR);
			if (this.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) throw new QuereusError(`Cannot drop PK column: ${columnName}`, StatusCode.CONSTRAINT);
			// TODO: Check secondary indexes using this column and prevent drop or drop them too.

			const oldTableSchema = this.tableSchema;
			const updatedColumnsSchema = oldTableSchema.columns.filter((_, idx) => idx !== colIndex);
			const updatedPkDefinition = oldTableSchema.primaryKeyDefinition.map(def => ({ ...def, index: def.index > colIndex ? def.index - 1 : def.index })).filter(def => def.index !== colIndex);
			const updatedIndexes = (oldTableSchema.indexes ?? []).map(idx => ({
				...idx,
				columns: idx.columns.map(ic => ({ ...ic, index: ic.index > colIndex ? ic.index -1 : ic.index })).filter(ic => ic.index !== colIndex)
			})).filter(idx => idx.columns.length > 0);

			this.tableSchema = Object.freeze({
				...oldTableSchema, columns: updatedColumnsSchema, columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
				primaryKeyDefinition: updatedPkDefinition, indexes: Object.freeze(updatedIndexes)
			});
			this.baseLayer.dropColumnFromBase(columnName, colIndex); // Verified: passing colIndex
			log(`MemoryTable %s: Dropped column %s`, this.tableName, columnName);
		} finally { release(); }
	}

	async renameColumn(oldName: string, newName: string): Promise<void> {
		if (this.readOnly) throw new QuereusError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);
		try {
			await this.ensureSchemaChangeSafety();

			const oldNameLower = oldName.toLowerCase();
			const newNameLower = newName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);

			if (colIndex === -1) throw new QuereusError(`Column not found: ${oldName}`, StatusCode.ERROR);
			if (this.tableSchema.columns.some((c, i) => i !== colIndex && c.name.toLowerCase() === newNameLower)) {
				throw new QuereusError(`Duplicate column name: ${newName}`, StatusCode.ERROR);
			}
			// TODO: Check PK / Indexes

			const oldTableSchema = this.tableSchema;

			// Update canonical schema
			const updatedColumnsSchema = oldTableSchema.columns.map((colSchema, idx) =>
				idx === colIndex ? { ...colSchema, name: newName } : colSchema
			);
			// TODO: Update IndexSchema definitions if column name is used there

			this.tableSchema = Object.freeze({
				...oldTableSchema,
				columns: updatedColumnsSchema,
				columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
				// TODO: Update indexes array
			});

			// Apply change to BaseLayer data
			this.baseLayer.renameColumnInBase(oldName, newName);

			// Use namespaced log
			log(`MemoryTable %s: Renamed column %s to %s`, this.tableName, oldName, newName);
		} finally {
			release();
		}
	}

	async renameTable(newName: string): Promise<void> {
		// This needs coordination with the MemoryTableModule's table registry
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`; // Use schema lock
		const release = await Latches.acquire(lockKey);
		try {
			await this.ensureSchemaChangeSafety(); // Ensure stable state

			const oldTableKey = `${this.schemaName.toLowerCase()}.${this.tableName.toLowerCase()}`;
			const newTableKey = `${this.schemaName.toLowerCase()}.${newName.toLowerCase()}`;

			if (oldTableKey === newTableKey) return; // No change

			// Check registry via module reference
			if (!this.module || typeof this.module.tables?.has !== 'function' || typeof this.module.tables?.delete !== 'function' || typeof this.module.tables?.set !== 'function') {
				throw new QuereusError("Cannot rename: Module context or table registry is invalid.", StatusCode.INTERNAL);
			}
			if (this.module.tables.has(newTableKey)) {
				throw new QuereusError(`Cannot rename memory table: target name '${newName}' already exists in schema '${this.schemaName}'`);
			}

			// Update registry
			this.module.tables.delete(oldTableKey);
			(this as any).tableName = newName; // Update instance property (hacky, assumes writable)
			this.module.tables.set(newTableKey, this);

			// Update canonical schema
			this.tableSchema = Object.freeze({ ...this.tableSchema, name: newName });

			// Use namespaced log
			log(`Memory table renamed from '%s' to '%s'`, oldTableKey, newName);
		} finally {
			release();
		}
	}

	async createIndex(indexSchema: IndexSchema): Promise<void> {
		if (this.readOnly) throw new QuereusError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);
		try {
			await this.ensureSchemaChangeSafety();

			const indexName = indexSchema.name;
			if (this.tableSchema.indexes?.some(idx => idx.name === indexName)) {
				throw new QuereusError(`Index '${indexName}' already exists on table '${this.tableName}'.`, StatusCode.ERROR);
			}
			// TODO: Validate index columns exist

			// Update canonical schema
			const updatedIndexes = [...(this.tableSchema.indexes ?? []), indexSchema];
			this.tableSchema = Object.freeze({ ...this.tableSchema, indexes: Object.freeze(updatedIndexes) });

			// Add index to BaseLayer (populates it)
			this.baseLayer.addIndexToBase(indexSchema);

			// Use namespaced log
			log(`MemoryTable %s: Created index %s`, this.tableName, indexName);
		} catch (e) {
			// Rollback schema change?
			// Use namespaced error logger
			if(e instanceof Error) errorLog("Error creating index: %s", e.message);
			throw e; // Re-throw
		}
		finally {
			release();
		}
	}

	async dropIndex(indexName: string): Promise<void> {
		if (this.readOnly) throw new QuereusError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);
		try {
			await this.ensureSchemaChangeSafety();

			if (!this.tableSchema.indexes?.some(idx => idx.name === indexName)) {
				throw new QuereusError(`Index not found: ${indexName}`);
			}

			// Update canonical schema
			const updatedIndexes = this.tableSchema.indexes.filter(idx => idx.name !== indexName);
			this.tableSchema = Object.freeze({ ...this.tableSchema, indexes: Object.freeze(updatedIndexes) });

			// Drop index from BaseLayer
			const dropped = this.baseLayer.dropIndexFromBase(indexName);
			if (!dropped) {
				// This shouldn't happen if schema check passed, but handle defensively
				// Use namespaced warn logger
				warnLog(`BaseLayer failed to drop index %s, schema/base mismatch?`, indexName);
			}

			// Use namespaced log
			log(`MemoryTable %s: Dropped index %s`, this.tableName, indexName);
		} finally {
			release();
		}
	}

	/** Check if schema changes are safe (only base layer exists). Waits/throws if not safe. */
	private async ensureSchemaChangeSafety(): Promise<void> {
		if (this.currentCommittedLayer !== this.baseLayer) {
			// TODO: Implement waiting strategy or throw immediately
			// Use namespaced warn logger
			warnLog(`Schema change attempted on %s while transaction layers exist. Forcing collapse...`, this.tableName);
			// Potentially wait for collapse or force it if possible, or just throw.
			// Forcing collapse might be complex if layers are in use.
			// Throwing is safer for now.
			await this.tryCollapseLayers(); // Attempt collapse first
			if (this.currentCommittedLayer !== this.baseLayer) {
				throw new QuereusError(`Cannot perform schema change on table ${this.tableName} while older transaction versions exist. Commit/rollback active transactions.`, StatusCode.BUSY);
			}
		}
	}

	// --- Helper Methods for accessing constructors ---
	getBaseLayerConstructor(): typeof BaseLayer {
		return BaseLayer;
	}
	getTransactionLayerConstructor(): typeof TransactionLayer {
		return TransactionLayer;
	}

	/** Checks if the table is in read-only mode */
	isReadOnly(): boolean {
		return this.readOnly;
	}

	/** Destroys the manager and cleans up resources */
	async destroy(): Promise<void> {
		// Acquire a lock to ensure no operations are in progress
		const lockKey = `MemoryTable.Destroy:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);

		try {
			// Disconnect any remaining connections
			for (const connection of this.connections.values()) {
				// Roll back any pending transaction
				if (connection.pendingTransactionLayer) {
					connection.rollback();
				}
			}

			// Clear connections map
			this.connections.clear();

			// Force collapse layers to base
			this.currentCommittedLayer = this.baseLayer;

			// Clear the base layer data
			this.baseLayer = new BaseLayer(
				this.tableSchema,
				this.tableSchema.columns.map(c => ({ name: c.name })),
				!this.pkIsRowid
			);

			// Use namespaced log
			log(`MemoryTable %s manager destroyed.`, this.tableName);
		} finally {
			release();
		}
	}

	// --- xUpdate / Mutation ---
	// This needs to delegate to the *connection's* pending layer

	/**
	 * Internal helper to find a MemoryTableRow tuple by its rowid, searching down the layer chain.
	 * Used by MemoryTableConnection.lookupRowByRowid for sorter population.
	 */
	async lookupRowByRowidInternal(rowidToFind: bigint, currentLayer: Layer | null): Promise<MemoryTableRow | null> {
		if (!currentLayer) {
			return null; // Reached end of chain
		}

		if (currentLayer instanceof TransactionLayer) {
			// 1. Check if this rowid was explicitly deleted in this layer
			if (currentLayer.getDeletedRowids().has(rowidToFind)) {
				return null; // Deleted in this layer
			}

			// 2. Check primary modifications in this layer.
			// We need to iterate primary mods to see if any of them correspond to the rowidToFind.
			const primaryModTree = currentLayer.getModificationTree('primary');
			if (primaryModTree) {
				// Iterate all modifications. This might not be super efficient for large transactions.
				// BTree values are ModificationValue (MemoryTableRow tuple or DeletionMarker)
				for (const path of primaryModTree.ascending(primaryModTree.first())) {
					const modValue = primaryModTree.at(path);
					if (modValue) {
						if (isDeletionMarker(modValue)) {
							if (modValue._rowid_ === rowidToFind) {
								return null; // Explicitly deleted by marker with this rowid
							}
						} else {
							// modValue is MemoryTableRow tuple: [rowid, data_array]
							const currentRowTuple = modValue as MemoryTableRow;
							if (currentRowTuple[0] === rowidToFind) {
								return currentRowTuple; // Found the row in this layer's modifications
							}
						}
					}
				}
			}
			// Not found or not affected by primary mods in this layer, recurse to parent
			return this.lookupRowByRowidInternal(rowidToFind, currentLayer.getParent());

		} else if (currentLayer instanceof BaseLayer) {
			// Reached the BaseLayer
			const baseLayer = currentLayer;
			const schema = baseLayer.getSchema();

			if (schema.primaryKeyDefinition.length === 0) { // Rowid is the primary key
				return baseLayer.primaryTree.get(rowidToFind) ?? null;
			} else {
				// Table has an explicit primary key, need to use rowidToKeyMap
				if (baseLayer.rowidToKeyMap) {
					const primaryKey = baseLayer.rowidToKeyMap.get(rowidToFind);
					if (primaryKey !== undefined) {
						return baseLayer.primaryTree.get(primaryKey) ?? null;
					} else {
						return null; // Rowid not in map
					}
				} else {
					// Should not happen if PK is not rowid, rowidToKeyMap should exist.
					warnLog(`BaseLayer has primary key but no rowidToKeyMap when looking up rowid ${rowidToFind}`);
					return null;
				}
			}
		} else {
			// Should not happen if layer chain is valid
			errorLog("lookupRowByRowidInternal: Encountered unknown layer type.");
			return null;
		}
	}

	async performMutation(connection: MemoryTableConnection, values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint; }> {
		if (this.readOnly) {
			throw new QuereusError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		}
		const onConflict = (values as any)._onConflict || ConflictResolution.ABORT;

		if (!connection.pendingTransactionLayer) {
			connection.begin();
		}
		const targetLayer = connection.pendingTransactionLayer;
		if (!targetLayer) {
			throw new QuereusError("Internal error: Pending transaction layer not found after begin.", StatusCode.INTERNAL);
		}

		try {
			if (values.length === 1 && typeof values[0] === 'bigint') {
				// --- DELETE ---
				const targetRowid = values[0];
				const primaryKey = this.findPrimaryKeyForRowid(targetRowid, targetLayer.getParent());
				if (primaryKey === null) return {};

				const oldEffectiveValue = this.lookupEffectiveValueInternal(primaryKey, 'primary', targetLayer.getParent());
				if (!oldEffectiveValue || isDeletionMarker(oldEffectiveValue)) return {};

				const oldRowTuple = oldEffectiveValue as MemoryTableRow; // It must be a MemoryTableRow here

				const indexKeys = new Map<string, [BTreeKey, bigint]>();
				const schema = targetLayer.getSchema();
				schema.indexes?.forEach(indexSchema => {
					const tempIndex = new MemoryIndex({ name: indexSchema.name, columns: indexSchema.columns }, schema.columns.map(c => ({ name: c.name })));
					const secKey = tempIndex.keyFromRow(oldRowTuple); // Pass tuple to keyFromRow
					indexKeys.set(indexSchema.name, [secKey, targetRowid]);
				});

				targetLayer.recordDelete(targetRowid, primaryKey, indexKeys);
				return {};

			} else if (values.length > 1) {
				const dataArray = values.slice(1);
				if (rowid === null) {
					// --- INSERT ---
					const newRowid = await this.getNextRowid();
					const newRowTuple: MemoryTableRow = [newRowid, dataArray];

					const primaryKey = this.primaryKeyFromRow(newRowTuple);
					const existingValue = this.lookupEffectiveValueInternal(primaryKey, 'primary', targetLayer);
					if (existingValue !== undefined && !isDeletionMarker(existingValue)) {
						if (onConflict === ConflictResolution.IGNORE) return {};
						const pkColNames = this.tableSchema.primaryKeyDefinition.map(def => this.tableSchema.columns[def.index].name).join(', ') || 'rowid';
						throw new ConstraintError(`UNIQUE constraint failed: ${this.tableName}.${pkColNames}`);
					}
					const affectedIndexes: (string | 'primary')[] = ['primary', ...(this.tableSchema.indexes?.map(idx => idx.name) ?? [])];
					targetLayer.recordUpsert(newRowTuple, affectedIndexes);
					return { rowid: newRowid };
				} else {
					// --- UPDATE ---
					const targetRowid = rowid;
					// For UPDATE, values[0] is the rowid to update, values[1..] are new column values.
					// We need the *old* row to preserve PK columns not being updated, and to update indexes.
					const oldRowTuple = await this.lookupRowByRowidInternal(targetRowid, targetLayer); // Find current state
					if (!oldRowTuple) return {}; // Row doesn't exist or already deleted effectively

					// dataArray here contains the values for *all* columns in table order, as per SQLite's xUpdate.
					const newRowTuple: MemoryTableRow = [targetRowid, dataArray];

					// PK conflict check if PK changed (only if NOT ROWID table and PK cols are part of update)
					const oldPrimaryKey = this.primaryKeyFromRow(oldRowTuple);
					const newPrimaryKey = this.primaryKeyFromRow(newRowTuple);
					let pkChanged = false;
					if (Array.isArray(oldPrimaryKey) && Array.isArray(newPrimaryKey)) {
						pkChanged = oldPrimaryKey.some((val, i) => compareSqlValues(val, newPrimaryKey[i]) !== 0) || oldPrimaryKey.length !== newPrimaryKey.length;
					} else {
						pkChanged = compareSqlValues(oldPrimaryKey as SqlValue, newPrimaryKey as SqlValue) !== 0;
					}

					if (pkChanged) {
						const existingValueForNewPk = this.lookupEffectiveValueInternal(newPrimaryKey, 'primary', targetLayer);
						if (existingValueForNewPk !== undefined && !isDeletionMarker(existingValueForNewPk)) {
							// If the existing value for the new PK is not the row we are currently updating, it's a conflict.
							const existingRowTuple = existingValueForNewPk as MemoryTableRow;
							if (existingRowTuple[0] !== targetRowid) {
								if (onConflict === ConflictResolution.IGNORE) return {};
								const pkColNames = this.tableSchema.primaryKeyDefinition.map(def => this.tableSchema.columns[def.index].name).join(', ') || 'rowid';
								throw new ConstraintError(`UNIQUE constraint failed: ${this.tableName}.${pkColNames} (during UPDATE)`);
							}
						}
					}

					const affectedIndexes: (string | 'primary')[] = ['primary', ...(this.tableSchema.indexes?.map(idx => idx.name) ?? [])];
					targetLayer.recordUpsert(newRowTuple, affectedIndexes, oldRowTuple);
					return {};
				}
			} else {
				throw new QuereusError("Unsupported arguments for mutation operation", StatusCode.ERROR);
			}
		} catch (e) {
			if (e instanceof ConstraintError && onConflict === ConflictResolution.IGNORE) {
				return {};
			}
			throw e;
		}
	}

	// Helper to check if a key satisfies plan bounds and equality, used by cursors/iterators
	public planAppliesToKeyForLayer(plan: ScanPlan, key: ModificationKey, comparator: (a:BTreeKey,b:BTreeKey)=>number, _schema: TableSchema): boolean {
		const keyForComparison = plan.indexName === 'primary' ? key as BTreeKey : (key as [BTreeKey, bigint])[0];
		if (plan.equalityKey !== undefined) {
			return comparator(keyForComparison, plan.equalityKey) === 0;
		}

		const firstColKey = ( () => {
			const bKey = plan.indexName === 'primary' ? key as BTreeKey : (key as [BTreeKey, bigint])[0];
			return Array.isArray(bKey) ? (bKey[0] as SqlValue) : bKey as SqlValue;
		})();

		if (firstColKey === null && (plan.lowerBound || plan.upperBound)) return false;

		if (plan.lowerBound && firstColKey !== null) {
			const cmp = compareSqlValues(firstColKey, plan.lowerBound.value);
			if (cmp < 0 || (cmp === 0 && plan.lowerBound.op === IndexConstraintOp.GT)) return false;
		}
		if (plan.upperBound && firstColKey !== null) {
			const cmp = compareSqlValues(firstColKey, plan.upperBound.value);
			if (cmp > 0 || (cmp === 0 && plan.upperBound.op === IndexConstraintOp.LT)) return false;
		}
		return true;
	}

}
