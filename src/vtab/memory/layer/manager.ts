import type { Database } from '../../../core/database.js';
import type { TableSchema, IndexSchema } from '../../../schema/table.js';
import type { MemoryTableRow, BTreeKey } from '../types.js';
import type { SqlValue } from '../../../common/types.js';
import { BaseLayer } from './base.js';
import { TransactionLayer } from './transaction.js';
import type { Layer, ModificationKey, ModificationValue, DeletionMarker } from './interface.js';
import { isDeletionMarker, DELETED } from '../types.js';
import { MemoryTableConnection } from './connection.js';
import { Latches } from '../../../util/latches.js'; // Simple async lock
import { SqliterError, ConstraintError } from '../../../common/errors.js';
import { StatusCode } from '../../../common/types.js';
import { ConflictResolution } from '../../../common/constants.js';
import { MemoryIndex, type IndexSpec } from '../index.js'; // Needed for index ops
import { getAffinity } from '../../../schema/column.js'; // Needed for schema ops
import type { ColumnDef } from '../../../parser/ast.js'; // Needed for schema ops
import type { SchemaChangeInfo } from '../../module.js'; // Needed for schema ops
import { buildColumnIndexMap, columnDefToSchema } from '../../../schema/table.js'; // Needed for schema ops
import { compareSqlValues } from '../../../util/comparison.js'; // Import for comparison functions
import { createLogger } from '../../../common/logger.js'; // Import logger
import { safeJsonStringify } from '../../../util/serialization.js';

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

		// Derive PK info from schema
		this.pkIndices = Object.freeze(this.tableSchema.primaryKeyDefinition.map(def => def.index));
		this.pkIsRowid = this.pkIndices.length === 0;

		const { keyExtractor, comparator } = this.getBTreeFuncsForIndex('primary', this.tableSchema);
		this.primaryKeyFromRow = keyExtractor as (row: MemoryTableRow) => BTreeKey; // Cast assumes PK extractor works on rows
		this.comparePrimaryKeys = comparator;

		const needsRowidMap = !this.pkIsRowid;

		// Initialize BaseLayer using the canonical schema
		this.baseLayer = new BaseLayer(
			this.tableSchema,
			this.primaryKeyFromRow,
			this.comparePrimaryKeys,
			this.tableSchema.columns.map(c => ({ name: c.name })), // Pass column names
			needsRowidMap
		);

		// Initialize secondary indexes in the BaseLayer
		this.tableSchema.indexes?.forEach(indexSchema => {
			try {
				// BaseLayer constructor already handles creating MemoryIndex instances
				// No need to add them here again, just ensure constructor did it.
				if (!this.baseLayer.secondaryIndexes.has(indexSchema.name)) {
					// This indicates an issue in BaseLayer construction
					throw new Error(`BaseLayer failed to initialize index '${indexSchema.name}'`);
				}
			} catch (e) {
				// Use namespaced error logger
				errorLog(`Failed to initialize secondary index '%s' in BaseLayer: %O`, indexSchema.name, e);
				throw e; // Fail fast if index setup fails
			}
		});

		this.currentCommittedLayer = this.baseLayer; // Initially, the base layer is the only committed layer
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
			throw new SqliterError(`Table ${this.tableName} is read-only`, StatusCode.READONLY);
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
				// TODO: Should this throw SQLITE_BUSY or similar? Standard behavior might depend on isolation level.
				// For now, treat as a failed commit leading to automatic rollback.
				throw new SqliterError(`Commit failed due to concurrent update (staleness check failed) on table ${this.tableName}`, StatusCode.BUSY); // Or StatusCode.ABORT?
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

		// Get the schema *as it was* when the layer to merge was created.
		// This is crucial for interpreting its modifications correctly, especially
		// for calculating old/new secondary keys if the schema changed later.
		const schemaAtMergeTime = layer.getSchema();

		// Get BTree functions based on the schema *at merge time*.
		const getFuncs = (indexName: string | 'primary') => this.getBTreeFuncsForIndex(indexName, schemaAtMergeTime);

		// Iterate through primary key modifications in the layer being merged
		const primaryModTree = layer.getModificationTree('primary');
		if (primaryModTree) {
			// Create BTree funcs using the schema *from the layer being merged*
			const { comparator: primaryKeyComparator } = getFuncs('primary');
			const primaryModKeyExtractor = layer.getKeyExtractor('primary'); // Use layer's extractor for its own tree

			for (const path of primaryModTree.ascending(primaryModTree.first())) {
				const modValue = primaryModTree.at(path);
				if (modValue === undefined) continue;

				const primaryKey = primaryModKeyExtractor(modValue); // Extract PK (ModificationKey)

				// Find the value *before* this modification was applied by looking up
				// the primary key starting from the *parent* layer.
				const oldEffectiveValue = this.lookupEffectiveValueInternal(primaryKey, 'primary', parentLayer);

				// Apply the change (modValue) to the base layer, using oldEffectiveValue for index updates.
				// The baseLayer's applyChange method needs the *current* baseLayer schema internally
				// to correctly interact with its own secondary index MemoryIndex instances.
				// However, the calculation of old/new secondary keys within applyChange *should* ideally
				// use the schema associated with the oldEffectiveValue and modValue respectively.
				// Let's simplify: BaseLayer.applyChange will use its *current* schema to update indices.
				// This assumes secondary key extraction logic is consistent enough across schema versions,
				// or that schema changes affecting index keys are handled carefully.
				try {
					// Here we need to safely handle the typing for oldEffectiveValue
					const oldRowValue = oldEffectiveValue !== undefined &&
						!isDeletionMarker(oldEffectiveValue)
						? oldEffectiveValue
						: null;

					this.baseLayer.applyChange(
						primaryKey as BTreeKey, // BaseLayer expects BTreeKey
						modValue, // Pass the actual modification value
						oldRowValue // Pass MemoryTableRow | null
					);
				} catch (applyError) {
					// This is critical. Log details and potentially halt collapse.
					// Use namespaced error logger
					errorLog(`[Collapse Apply] Failed to apply change for key %s from layer %d to base layer. Table %s may be inconsistent. Error: %O`, safeJsonStringify(primaryKey), layer.getLayerId(), this.tableName, applyError);
					// Re-throw to stop the collapse process?
					throw applyError;
				}
			}
		}

		// Handle rows explicitly deleted in this layer that might not have had a primary key mod entry
		// (e.g., insert + delete within the layer). We still need to ensure they are removed from base.
		for (const rowid of layer.getDeletedRowids()) {
			// Find the primary key for this rowid *before* this layer's changes
			const pk = this.findPrimaryKeyForRowid(rowid, parentLayer);
			if (pk !== null) {
				const oldEffectiveValue = this.lookupEffectiveValueInternal(pk, 'primary', parentLayer);
				// Apply a deletion to the base layer if it wasn't already handled via primary mods
				// Check if baseLayer already reflects deletion for this PK
				const currentBaseValue = this.baseLayer.primaryTree.get(pk);
				if (currentBaseValue !== undefined) { // If base still has the row
					// Use namespaced debug logger
					debugLog(`[Collapse Apply] Applying explicit delete for rowid %s (PK: %s) from layer %d to base.`, rowid, safeJsonStringify(pk), layer.getLayerId());
					try {
						// Create a properly typed DeletionMarker
						const deletionMarker: DeletionMarker = {
							_marker_: DELETED,
							_key_: pk,
							_rowid_: rowid
						};

						// Safely handle oldEffectiveValue typing
						const oldRowValue = oldEffectiveValue !== undefined &&
							!isDeletionMarker(oldEffectiveValue)
							? oldEffectiveValue
							: null;

						this.baseLayer.applyChange(
							pk,
							deletionMarker, // Use properly typed DeletionMarker
							oldRowValue
						);
					} catch (applyError) {
						// Use namespaced error logger
						errorLog(`[Collapse Apply] Failed to apply explicit delete for rowid %s (PK: %s) from layer %d to base. Error: %O`, rowid, safeJsonStringify(pk), layer.getLayerId(), applyError);
						throw applyError;
					}
				}
			} else {
				debugLog(`[Collapse Apply] Explicitly deleted rowid ${rowid} from layer ${layer.getLayerId()} had no primary key found in parent layers.`);
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
				const { comparator } = this.getBTreeFuncsForIndex(indexName, currentLayer.getSchema());
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
				// Check pending updates/inserts in this layer first
				// This requires iterating maps, potentially slow. Optimize if needed.
				let foundKey: BTreeKey | null = null;
				const primaryModTree = currentLayer.getModificationTree('primary');
				if (primaryModTree) {
					const pkExtractor = currentLayer.getKeyExtractor('primary');
					for (const path of primaryModTree.ascending(primaryModTree.first())) {
						const modValue = primaryModTree.at(path);
						if (modValue && !isDeletionMarker(modValue) && modValue._rowid_ === rowid) {
							foundKey = pkExtractor(modValue) as BTreeKey;
							break;
						}
						if(modValue && isDeletionMarker(modValue) && modValue._rowid_ === rowid) {
							// If we find a deletion marker for this rowid, it means the row *was*
							// present before this layer or inserted then deleted within it.
							// We should continue searching parent layers for the key *before* deletion.
							break; // Stop checking this layer's mods, go to parent
						}
					}
				}
				if (foundKey !== null) return foundKey;

				// Check if explicitly deleted in this layer - if so, continue searching parent
				if (currentLayer.getDeletedRowids().has(rowid)) {
					currentLayer = currentLayer.getParent();
					continue;
				}

			} else if (currentLayer instanceof BaseLayer) {
				// Check BaseLayer's map or assume rowid is key
				if (currentLayer.rowidToKeyMap) {
					return currentLayer.rowidToKeyMap.get(rowid) ?? null;
				} else if (this.pkIsRowid) {
					// Check if the rowid exists as a key in the primary tree
					return currentLayer.primaryTree.get(rowid) !== undefined ? rowid : null;
				} else {
					return null; // Keyed table without map, cannot find PK from rowid easily
				}
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
		keyExtractor: (value: MemoryTableRow | ModificationValue) => ModificationKey | BTreeKey; // Allow broader input for mods
		comparator: (a: BTreeKey, b: BTreeKey) => number;
	} {
		// This logic is similar to TransactionLayer.getBTreeFuncs, but adapted
		// to use the provided schema instead of `this.getSchema()`.

		const columnsMeta = schema.columns.map(c => ({ name: c.name }));

		if (indexName === 'primary') {
			const pkDef = schema.primaryKeyDefinition ?? [];
			if (pkDef.length === 0) { // Rowid key
				return {
					keyExtractor: (value: MemoryTableRow | ModificationValue) => isDeletionMarker(value) ? value._key_ as BTreeKey : (value as MemoryTableRow)._rowid_,
					comparator: (a, b) => compareSqlValues(a as bigint, b as bigint)
				};
			} else if (pkDef.length === 1) { // Single column PK
				const { index: pkIndex, desc: isDesc } = pkDef[0];
				const pkColName = columnsMeta[pkIndex]?.name;
				const pkCollation = schema.columns[pkIndex]?.collation ?? 'BINARY';
				if (!pkColName) throw new Error("Invalid PK schema");
				return {
					keyExtractor: (value: MemoryTableRow | ModificationValue) => isDeletionMarker(value) ? value._key_ as BTreeKey : (value as MemoryTableRow)[pkColName] as BTreeKey,
					comparator: (a, b) => {
						const cmp = compareSqlValues(a as SqlValue, b as SqlValue, pkCollation);
						return isDesc ? -cmp : cmp;
					}
				};
			} else { // Composite PK
				const pkCols = pkDef.map(def => ({
					name: columnsMeta[def.index]?.name,
					desc: def.desc,
					collation: schema.columns[def.index]?.collation || 'BINARY'
				}));
				if (pkCols.some(c => !c.name)) throw new Error("Invalid composite PK schema");
				const pkColNames = pkCols.map(c => c.name!);
				return {
					keyExtractor: (value: MemoryTableRow | ModificationValue) => isDeletionMarker(value) ? value._key_ as SqlValue[] : pkColNames.map(name => (value as MemoryTableRow)[name]),
					comparator: (a, b) => {
						const arrA = a as SqlValue[]; const arrB = b as SqlValue[];
						for (let i = 0; i < pkCols.length; i++) {
							if (i >= arrA.length || i >= arrB.length) return arrA.length - arrB.length;
							const dirMultiplier = pkCols[i].desc ? -1 : 1;
							const collation = pkCols[i].collation;
							const cmp = compareSqlValues(arrA[i], arrB[i], collation) * dirMultiplier;
							if (cmp !== 0) return cmp;
						}
						return arrA.length - arrB.length;
					}
				};
			}
		} else {
			// Secondary Index Key: BTreeKey (SqlValue | SqlValue[])
			const indexSchema = schema.indexes?.find(idx => idx.name === indexName);
			if (!indexSchema) throw new Error(`Secondary index ${indexName} not found in schema`);

			// Use MemoryIndex logic for extraction and comparison of the key part
			const tempIndex = new MemoryIndex({ name: indexSchema.name, columns: indexSchema.columns }, columnsMeta);

			return {
				// Note: This extractor returns the BTreeKey part, suitable for comparison,
				// but TransactionLayer's mod extractor returns ModificationKey ([Key, rowid]).
				// Keep this distinction in mind where used.
				keyExtractor: (value: MemoryTableRow | ModificationValue) => {
					if (isDeletionMarker(value)) {
						// If it's a marker, the key stored is already [IndexKey, rowid]. Extract IndexKey.
						return (value._key_ as [BTreeKey, bigint])[0];
					} else {
						// Otherwise, extract from the row data.
						return tempIndex.keyFromRow(value as MemoryTableRow);
					}
				},
				comparator: tempIndex.compareKeys // Use MemoryIndex's key comparator
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
		if (this.readOnly) throw new SqliterError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);
		try {
			// Check if safe to modify schema (ideally only base layer exists)
			await this.ensureSchemaChangeSafety();

			const newColNameLower = columnDef.name.toLowerCase();
			if (this.tableSchema.columns.some(c => c.name.toLowerCase() === newColNameLower)) {
				throw new SqliterError(`Duplicate column name: ${columnDef.name}`, StatusCode.ERROR);
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
		if (this.readOnly) throw new SqliterError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
        const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);
        try {
            await this.ensureSchemaChangeSafety();

			const colNameLower = columnName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === colNameLower);
			if (colIndex === -1) {
				throw new SqliterError(`Column not found: ${columnName}`, StatusCode.ERROR);
			}
			if (this.tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
				throw new SqliterError(`Cannot drop column '${columnName}' because it is part of the primary key`, StatusCode.CONSTRAINT);
			}
			// TODO: Check secondary indexes

			const oldTableSchema = this.tableSchema;

            // Update canonical schema
            const updatedColumnsSchema = oldTableSchema.columns.filter((_, idx) => idx !== colIndex);
            const updatedPkDefinition = oldTableSchema.primaryKeyDefinition
                .map(def => ({ ...def, index: def.index > colIndex ? def.index - 1 : def.index }))
                .filter(def => def.index !== colIndex); // Ensure dropped PK col is removed if somehow missed above check
            // TODO: Update IndexSchema definitions

			this.tableSchema = Object.freeze({
				...oldTableSchema,
				columns: updatedColumnsSchema,
				columnIndexMap: buildColumnIndexMap(updatedColumnsSchema),
				primaryKeyDefinition: updatedPkDefinition,
                // TODO: Update indexes array in schema
			});

            // Apply change to BaseLayer data
            this.baseLayer.dropColumnFromBase(columnName);

            // Use namespaced log
            log(`MemoryTable %s: Dropped column %s`, this.tableName, columnName);
        } finally {
            release();
        }
	}

	async renameColumn(oldName: string, newName: string): Promise<void> {
        if (this.readOnly) throw new SqliterError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
        const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);
        try {
             await this.ensureSchemaChangeSafety();

			const oldNameLower = oldName.toLowerCase();
			const newNameLower = newName.toLowerCase();
			const colIndex = this.tableSchema.columns.findIndex(c => c.name.toLowerCase() === oldNameLower);

			if (colIndex === -1) throw new SqliterError(`Column not found: ${oldName}`, StatusCode.ERROR);
			if (this.tableSchema.columns.some((c, i) => i !== colIndex && c.name.toLowerCase() === newNameLower)) {
				throw new SqliterError(`Duplicate column name: ${newName}`, StatusCode.ERROR);
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
                throw new SqliterError("Cannot rename: Module context or table registry is invalid.", StatusCode.INTERNAL);
            }
            if (this.module.tables.has(newTableKey)) {
                throw new SqliterError(`Cannot rename memory table: target name '${newName}' already exists in schema '${this.schemaName}'`);
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
		if (this.readOnly) throw new SqliterError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);
		try {
			await this.ensureSchemaChangeSafety();

			const indexName = indexSchema.name;
			if (this.tableSchema.indexes?.some(idx => idx.name === indexName)) {
				throw new SqliterError(`Index '${indexName}' already exists on table '${this.tableName}'.`, StatusCode.ERROR);
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
		if (this.readOnly) throw new SqliterError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		const lockKey = `MemoryTable.SchemaChange:${this.schemaName}.${this.tableName}`;
		const release = await Latches.acquire(lockKey);
		try {
			await this.ensureSchemaChangeSafety();

			if (!this.tableSchema.indexes?.some(idx => idx.name === indexName)) {
				throw new SqliterError(`Index not found: ${indexName}`);
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
				throw new SqliterError(`Cannot perform schema change on table ${this.tableName} while older transaction versions exist. Commit/rollback active transactions.`, StatusCode.BUSY);
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
                this.primaryKeyFromRow,
                this.comparePrimaryKeys,
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

	async performMutation(connection: MemoryTableConnection, values: SqlValue[], rowid: bigint | null): Promise<{ rowid?: bigint; }> {
		if (this.readOnly) {
			throw new SqliterError(`Table '${this.tableName}' is read-only`, StatusCode.READONLY);
		}
		const onConflict = (values as any)._onConflict || ConflictResolution.ABORT; // Assuming hidden property like before

		// Ensure transaction is started on the connection
		if (!connection.pendingTransactionLayer) {
			connection.begin();
		}
		const targetLayer = connection.pendingTransactionLayer;
		if (!targetLayer) {
			// Should not happen after calling begin()
			throw new SqliterError("Internal error: Pending transaction layer not found after begin.", StatusCode.INTERNAL);
		}

		try {
			if (values.length === 1 && typeof values[0] === 'bigint') {
				// --- DELETE ---
				const targetRowid = values[0];
				// Find primary key and old row state *before* this delete
				const primaryKey = this.findPrimaryKeyForRowid(targetRowid, targetLayer.getParent());
				if (primaryKey === null) return {}; // Row doesn't exist effectively

				const oldEffectiveRow = this.lookupEffectiveValueInternal(primaryKey, 'primary', targetLayer.getParent());
				if (!oldEffectiveRow || isDeletionMarker(oldEffectiveRow)) return {}; // Row already deleted or never existed

				// Find secondary keys for the old row state
				const indexKeys = new Map<string, [BTreeKey, bigint]>();
				const schema = targetLayer.getSchema(); // Schema relevant for this layer's mods
				schema.indexes?.forEach(indexSchema => {
					const tempIndex = new MemoryIndex({ name: indexSchema.name, columns: indexSchema.columns }, schema.columns.map(c => ({ name: c.name })));
					const secKey = tempIndex.keyFromRow(oldEffectiveRow);
					indexKeys.set(indexSchema.name, [secKey, targetRowid]);
				});

				// Record deletion in the transaction layer
				targetLayer.recordDelete(targetRowid, primaryKey, indexKeys);
				return {}; // Success

			} else if (values.length > 1) {
				if (rowid === null) {
					// --- INSERT ---
					const data = Object.fromEntries(this.tableSchema.columns.map((col, idx) => [col.name, values[idx + 1]]));
					const newRowid = await this.getNextRowid();
					const newRow: MemoryTableRow = { ...data, _rowid_: newRowid };

					// Check constraints (PK, NOT NULL, CHECK) against newRow
					// Calculate primary key
					const primaryKey = this.primaryKeyFromRow(newRow);

					// Check for PK conflict by looking up key starting from parent layer
					const existingValue = this.lookupEffectiveValueInternal(primaryKey, 'primary', targetLayer); // Check current layer too!
					if (existingValue !== undefined && !isDeletionMarker(existingValue)) {
						// Conflict
						if (onConflict === ConflictResolution.IGNORE) return {};
						const pkColName = this.pkIndices.map(idx => this.tableSchema.columns[idx].name).join(', ') || 'rowid';
						throw new ConstraintError(`UNIQUE constraint failed: ${this.tableName}.${pkColName}`);
					}

					// Record insert in the transaction layer
					const affectedIndexes: (string | 'primary')[] = ['primary'];
					this.tableSchema.indexes?.forEach(idx => affectedIndexes.push(idx.name));
					targetLayer.recordUpsert(newRow, affectedIndexes);

					return { rowid: newRowid }; // Success
				} else {
					// --- UPDATE ---
					const targetRowid = rowid;
					const updateData = Object.fromEntries(this.tableSchema.columns.map((col, idx) => [col.name, values[idx + 1]]));

					// For UPDATE operation where we're given the rowid directly,
					// we should update ONLY the row with exactly that rowid.

					// Get the row directly by rowid
					let oldRow: MemoryTableRow | null = null;

					// If rowid is the primary key, do direct lookup
					if (this.pkIsRowid) {
						// Direct lookup of primary tree - baseLayer contains the canonical data
						oldRow = this.baseLayer.primaryTree.get(targetRowid) ?? null;
					} else {
						// For complex PKs, we need to find the PK mapped to this rowid
						const pk = this.findPrimaryKeyForRowid(targetRowid, targetLayer);
						if (pk) {
							oldRow = this.baseLayer.primaryTree.get(pk) ?? null;
						}
					}

					// If we can't find the row, nothing to update
					if (!oldRow) {
						log(`No row found with rowid ${targetRowid.toString()} to update`);
						return {}; // Nothing updated
					}

					// Create the updated row - preserve primary key fields and rowid
					const newRow: MemoryTableRow = { ...oldRow, ...updateData, _rowid_: targetRowid };

					// Record update in the transaction layer
					log(`Updating row with rowid ${targetRowid.toString()}`);
					const affectedIndexes: (string | 'primary')[] = ['primary'];
					this.tableSchema.indexes?.forEach(idx => affectedIndexes.push(idx.name));
					targetLayer.recordUpsert(newRow, affectedIndexes);

					return {}; // Success
				}
			} else {
				throw new SqliterError("Unsupported arguments for mutation operation", StatusCode.ERROR);
			}
		} catch (e) {
			// If ConstraintError and IGNORE, swallow error, otherwise rethrow
			if (e instanceof ConstraintError && onConflict === ConflictResolution.IGNORE) {
				return {};
			}
			throw e;
		}
	}

}
