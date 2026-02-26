/**
 * SyncManager implementation.
 *
 * Coordinates CRDT metadata tracking and sync operations.
 * Delegates to focused sub-modules for snapshot, streaming, and change application.
 */

import type { KVStore, StoreEventEmitter, DataChangeEvent, SchemaChangeEvent } from '@quereus/store';
import type { SqlValue, Row } from '@quereus/quereus';
import type { GetTableSchemaCallback } from '../create-sync-module.js';
import { HLCManager, type HLC, compareHLC } from '../clock/hlc.js';
import {
	generateSiteId,
	type SiteId,
	SITE_ID_KEY,
	serializeSiteIdentity,
	deserializeSiteIdentity,
	siteIdEquals,
} from '../clock/site.js';
import { ColumnVersionStore, type ColumnVersion, deserializeColumnVersion } from '../metadata/column-version.js';
import { TombstoneStore, deserializeTombstone } from '../metadata/tombstones.js';
import { PeerStateStore } from '../metadata/peer-state.js';
import { SchemaMigrationStore, deserializeMigration } from '../metadata/schema-migration.js';
import { ChangeLogStore } from '../metadata/change-log.js';
import {
	SYNC_KEY_PREFIX,
	buildAllColumnVersionsScanBounds,
	buildAllTombstonesScanBounds,
	buildAllSchemaMigrationsScanBounds,
	parseColumnVersionKey,
	parseTombstoneKey,
	parseSchemaMigrationKey,
} from '../metadata/keys.js';
import type { SyncManager, SnapshotCheckpoint } from './manager.js';
import type {
	SyncConfig,
	ChangeSet,
	Change,
	ColumnChange,
	RowDeletion,
	ApplyResult,
	Snapshot,
	SchemaMigration,
	SchemaMigrationType,
	SnapshotChunk,
	SnapshotProgress,
	ApplyToStoreCallback,
} from './protocol.js';
import { SyncEventEmitterImpl } from './events.js';
import type { SyncContext } from './sync-context.js';
import { persistHLCState, persistHLCStateBatch, toError } from './sync-context.js';
import { applyChanges as applyChangesImpl } from './change-applicator.js';
import { getSnapshot as getSnapshotImpl, applySnapshot as applySnapshotImpl } from './snapshot.js';
import {
	getSnapshotStream as getSnapshotStreamImpl,
	applySnapshotStream as applySnapshotStreamImpl,
	getSnapshotCheckpoint as getSnapshotCheckpointImpl,
	resumeSnapshotStream as resumeSnapshotStreamImpl,
} from './snapshot-stream.js';

/**
 * Implementation of SyncManager.
 *
 * Acts as a coordinator/facade that delegates snapshot, streaming,
 * and change application to focused sub-modules.
 */
export class SyncManagerImpl implements SyncManager, SyncContext {
	readonly kv: KVStore;
	readonly config: SyncConfig;
	readonly hlcManager: HLCManager;
	readonly columnVersions: ColumnVersionStore;
	readonly tombstones: TombstoneStore;
	private readonly peerStates: PeerStateStore;
	readonly changeLog: ChangeLogStore;
	readonly schemaMigrations: SchemaMigrationStore;
	readonly syncEvents: SyncEventEmitterImpl;
	readonly applyToStore?: ApplyToStoreCallback;
	private readonly getTableSchema?: GetTableSchemaCallback;

	// Pending changes for the current transaction
	private pendingChanges: Change[] = [];
	private currentTransactionId: string | null = null;

	private constructor(
		kv: KVStore,
		config: SyncConfig,
		hlcManager: HLCManager,
		syncEvents: SyncEventEmitterImpl,
		applyToStore?: ApplyToStoreCallback,
		getTableSchema?: GetTableSchemaCallback
	) {
		this.kv = kv;
		this.config = config;
		this.hlcManager = hlcManager;
		this.syncEvents = syncEvents;
		this.applyToStore = applyToStore;
		this.getTableSchema = getTableSchema;
		this.columnVersions = new ColumnVersionStore(kv);
		this.tombstones = new TombstoneStore(kv, config.tombstoneTTL);
		this.peerStates = new PeerStateStore(kv);
		this.changeLog = new ChangeLogStore(kv);
		this.schemaMigrations = new SchemaMigrationStore(kv);
	}

	/**
	 * Create a new SyncManager, initializing or loading site identity.
	 *
	 * @param kv - KV store for sync metadata
	 * @param storeEvents - Store event emitter to subscribe to local changes
	 * @param config - Sync configuration
	 * @param syncEvents - Sync event emitter for UI integration
	 * @param applyToStore - Optional callback for applying remote changes to the store
	 * @param getTableSchema - Optional callback for getting table schema by name
	 */
	static async create(
		kv: KVStore,
		storeEvents: StoreEventEmitter,
		config: SyncConfig,
		syncEvents: SyncEventEmitterImpl,
		applyToStore?: ApplyToStoreCallback,
		getTableSchema?: GetTableSchemaCallback
	): Promise<SyncManagerImpl> {
		// Load or create site identity
		const siteIdKey = new TextEncoder().encode(SITE_ID_KEY);
		let siteId: SiteId;

		const existingIdentity = await kv.get(siteIdKey);
		if (existingIdentity) {
			const identity = deserializeSiteIdentity(existingIdentity);
			siteId = identity.siteId;
		} else if (config.siteId) {
			siteId = config.siteId;
			await kv.put(siteIdKey, serializeSiteIdentity({ siteId, createdAt: Date.now() }));
		} else {
			siteId = generateSiteId();
			await kv.put(siteIdKey, serializeSiteIdentity({ siteId, createdAt: Date.now() }));
		}

		// Load HLC state
		const hlcKey = SYNC_KEY_PREFIX.HLC_STATE;
		const hlcData = await kv.get(hlcKey);
		let hlcState: { wallTime: bigint; counter: number } | undefined;
		if (hlcData) {
			const view = new DataView(hlcData.buffer, hlcData.byteOffset, hlcData.byteLength);
			hlcState = {
				wallTime: view.getBigUint64(0, false),
				counter: view.getUint16(8, false),
			};
		}

		const hlcManager = new HLCManager(siteId, hlcState);
		const manager = new SyncManagerImpl(kv, config, hlcManager, syncEvents, applyToStore, getTableSchema);

		// Subscribe to store events
		storeEvents.onDataChange((event) => manager.handleDataChange(event));
		storeEvents.onSchemaChange((event) => manager.handleSchemaChange(event));

		return manager;
	}

	// ============================================================================
	// Accessors
	// ============================================================================

	getSiteId(): SiteId {
		return this.hlcManager.getSiteId();
	}

	getCurrentHLC(): HLC {
		return this.hlcManager.now();
	}

	// ============================================================================
	// Event Handlers (local store changes)
	// ============================================================================

	/**
	 * Handle a data change event from the store.
	 * Records CRDT metadata for the change.
	 */
	private async handleDataChange(event: DataChangeEvent): Promise<void> {
		try {
			if (event.remote) return;

			const hlc = this.hlcManager.tick();
			const { schemaName, tableName, type, oldRow, newRow } = event;
			const pk = event.key ?? event.pk;
			if (!pk) {
				console.warn(`[Sync] Missing primary key for ${schemaName}.${tableName} ${type} event — change not tracked`);
				return;
			}

			const batch = this.kv.batch();

			if (type === 'delete') {
				this.tombstones.setTombstoneBatch(batch, schemaName, tableName, pk, hlc);
				this.changeLog.recordDeletionBatch(batch, hlc, schemaName, tableName, pk);
				await this.columnVersions.deleteRowVersions(schemaName, tableName, pk);

				const change: RowDeletion = {
					type: 'delete',
					schema: schemaName,
					table: tableName,
					pk,
					hlc,
				};
				this.pendingChanges.push(change);
			} else {
				if (newRow) {
					await this.recordColumnVersions(batch, schemaName, tableName, pk, oldRow, newRow, hlc);
				}
			}

			// Persist HLC state in batch (DRY: uses shared helper)
			persistHLCStateBatch(this, batch);

			await batch.write();

			const changesToEmit = [...this.pendingChanges];
			this.pendingChanges = [];

			this.syncEvents.emitLocalChange({
				transactionId: this.currentTransactionId || crypto.randomUUID(),
				changes: changesToEmit,
				pendingSync: true,
			});
		} catch (error) {
			console.error('[Sync] Error handling data change:', error);
			this.syncEvents.emitSyncStateChange({
				status: 'error',
				error: toError(error),
			});
		}
	}

	/**
	 * Handle a schema change event from the store.
	 * Records schema migrations for sync.
	 */
	private async handleSchemaChange(event: SchemaChangeEvent): Promise<void> {
		try {
			if (event.remote) return;

			const hlc = this.hlcManager.tick();
			const { type, objectType, schemaName, objectName, ddl } = event;

			let migrationType: SchemaMigrationType;
			if (objectType === 'table') {
				switch (type) {
					case 'create': migrationType = 'create_table'; break;
					case 'drop': migrationType = 'drop_table'; break;
					case 'alter': migrationType = 'alter_column'; break;
					default: return;
				}
			} else if (objectType === 'index') {
				switch (type) {
					case 'create': migrationType = 'add_index'; break;
					case 'drop': migrationType = 'drop_index'; break;
					default: return;
				}
			} else {
				return;
			}

			const currentVersion = await this.schemaMigrations.getCurrentVersion(schemaName, objectName);
			const newVersion = currentVersion + 1;

			await this.schemaMigrations.recordMigration(schemaName, objectName, {
				type: migrationType,
				ddl: ddl || '',
				hlc,
				schemaVersion: newVersion,
			});

			// Persist HLC state (DRY: uses shared helper)
			await persistHLCState(this);

			this.syncEvents.emitLocalChange({
				transactionId: crypto.randomUUID(),
				changes: [],
				pendingSync: true,
			});
		} catch (error) {
			console.error('[Sync] Error handling schema change:', error);
			this.syncEvents.emitSyncStateChange({
				status: 'error',
				error: toError(error),
			});
		}
	}

	private async recordColumnVersions(
		batch: import('@quereus/store').WriteBatch,
		schemaName: string,
		tableName: string,
		pk: SqlValue[],
		oldRow: Row | undefined,
		newRow: Row,
		hlc: HLC
	): Promise<void> {
		const tableSchema = this.getTableSchema?.(schemaName, tableName);
		const columnNames = tableSchema?.columns?.map(c => c.name);

		if (!tableSchema && this.getTableSchema) {
			console.warn(`[Sync] No table schema found for ${schemaName}.${tableName} - using fallback column names`);
		}

		for (let i = 0; i < newRow.length; i++) {
			const oldValue = oldRow?.[i];
			const newValue = newRow[i];

			if (!oldRow || oldValue !== newValue) {
				const column = columnNames?.[i] ?? `col_${i}`;

				const oldVersion = await this.columnVersions.getColumnVersion(
					schemaName, tableName, pk, column
				);

				if (oldVersion) {
					this.changeLog.deleteEntryBatch(
						batch,
						oldVersion.hlc,
						'column',
						schemaName,
						tableName,
						pk,
						column
					);
				}

				const version: ColumnVersion = { hlc, value: newValue };
				this.columnVersions.setColumnVersionBatch(batch, schemaName, tableName, pk, column, version);
				this.changeLog.recordColumnChangeBatch(batch, hlc, schemaName, tableName, pk, column);

				const change: ColumnChange = {
					type: 'column',
					schema: schemaName,
					table: tableName,
					pk,
					column,
					value: newValue,
					hlc,
				};
				this.pendingChanges.push(change);
			}
		}
	}

	// ============================================================================
	// Delta Sync API
	// ============================================================================

	async getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]> {
		const changes: Change[] = [];

		if (sinceHLC) {
			for await (const logEntry of this.changeLog.getChangesSince(sinceHLC)) {
				if (siteIdEquals(logEntry.hlc.siteId, peerSiteId)) continue;

				if (logEntry.entryType === 'column') {
					const cv = await this.columnVersions.getColumnVersion(
						logEntry.schema,
						logEntry.table,
						logEntry.pk,
						logEntry.column!
					);
					if (!cv) continue;

					const columnChange: ColumnChange = {
						type: 'column',
						schema: logEntry.schema,
						table: logEntry.table,
						pk: logEntry.pk,
						column: logEntry.column!,
						value: cv.value,
						hlc: cv.hlc,
					};
					changes.push(columnChange);
				} else {
					const tombstone = await this.tombstones.getTombstone(
						logEntry.schema,
						logEntry.table,
						logEntry.pk
					);
					if (!tombstone) continue;

					const deletion: RowDeletion = {
						type: 'delete',
						schema: logEntry.schema,
						table: logEntry.table,
						pk: logEntry.pk,
						hlc: tombstone.hlc,
					};
					changes.push(deletion);
				}
			}
		} else {
			await this.collectAllChanges(peerSiteId, changes);
		}

		// Collect schema migrations
		const schemaMigrations: SchemaMigration[] = [];
		const smBounds = buildAllSchemaMigrationsScanBounds();
		for await (const entry of this.kv.iterate(smBounds)) {
			const parsed = parseSchemaMigrationKey(entry.key);
			if (!parsed) continue;

			const migration = deserializeMigration(entry.value);

			if (sinceHLC && compareHLC(migration.hlc, sinceHLC) <= 0) continue;
			if (siteIdEquals(migration.hlc.siteId, peerSiteId)) continue;

			schemaMigrations.push({
				type: migration.type,
				schema: parsed.schema,
				table: parsed.table,
				ddl: migration.ddl,
				hlc: migration.hlc,
				schemaVersion: migration.schemaVersion,
			});
		}

		if (changes.length === 0 && schemaMigrations.length === 0) {
			return [];
		}

		schemaMigrations.sort((a, b) => compareHLC(a.hlc, b.hlc));

		const result: ChangeSet[] = [];
		for (let i = 0; i < changes.length; i += this.config.batchSize) {
			const batch = changes.slice(i, i + this.config.batchSize);
			const maxHLC = batch.reduce((max, c) => compareHLC(c.hlc, max) > 0 ? c.hlc : max, batch[0].hlc);

			result.push({
				siteId: this.getSiteId(),
				transactionId: crypto.randomUUID(),
				hlc: maxHLC,
				changes: batch,
				schemaMigrations: i === 0 ? schemaMigrations : [],
			});
		}

		if (result.length === 0 && schemaMigrations.length > 0) {
			const maxHLC = schemaMigrations.reduce(
				(max, m) => compareHLC(m.hlc, max) > 0 ? m.hlc : max,
				schemaMigrations[0].hlc
			);
			result.push({
				siteId: this.getSiteId(),
				transactionId: crypto.randomUUID(),
				hlc: maxHLC,
				changes: [],
				schemaMigrations,
			});
		}

		return result;
	}

	private async collectAllChanges(peerSiteId: SiteId, changes: Change[]): Promise<void> {
		const cvBounds = buildAllColumnVersionsScanBounds();
		for await (const entry of this.kv.iterate(cvBounds)) {
			const parsed = parseColumnVersionKey(entry.key);
			if (!parsed) continue;

			const cv = deserializeColumnVersion(entry.value);
			if (siteIdEquals(cv.hlc.siteId, peerSiteId)) continue;

			const columnChange: ColumnChange = {
				type: 'column',
				schema: parsed.schema,
				table: parsed.table,
				pk: parsed.pk,
				column: parsed.column,
				value: cv.value,
				hlc: cv.hlc,
			};
			changes.push(columnChange);
		}

		const tbBounds = buildAllTombstonesScanBounds();
		for await (const entry of this.kv.iterate(tbBounds)) {
			const parsed = parseTombstoneKey(entry.key);
			if (!parsed) continue;

			const tombstone = deserializeTombstone(entry.value);
			if (siteIdEquals(tombstone.hlc.siteId, peerSiteId)) continue;

			const deletion: RowDeletion = {
				type: 'delete',
				schema: parsed.schema,
				table: parsed.table,
				pk: parsed.pk,
				hlc: tombstone.hlc,
			};
			changes.push(deletion);
		}

		changes.sort((a, b) => compareHLC(a.hlc, b.hlc));
	}

	// ============================================================================
	// Delegated: Change Application
	// ============================================================================

	async applyChanges(changes: ChangeSet[]): Promise<ApplyResult> {
		return applyChangesImpl(this, changes);
	}

	async canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean> {
		const peerState = await this.peerStates.getPeerState(peerSiteId);
		if (!peerState) {
			return false;
		}

		// Check if tombstone TTL covers the requested time range
		const now = Date.now();
		const sinceTime = Number(sinceHLC.wallTime);
		if (now - sinceTime > this.config.tombstoneTTL) {
			return false;
		}

		return true;
	}

	// ============================================================================
	// Delegated: Non-Streaming Snapshots
	// ============================================================================

	async getSnapshot(): Promise<Snapshot> {
		return getSnapshotImpl(this);
	}

	async applySnapshot(snapshot: Snapshot): Promise<void> {
		return applySnapshotImpl(this, snapshot);
	}

	// ============================================================================
	// Peer State & Maintenance
	// ============================================================================

	async updatePeerSyncState(peerSiteId: SiteId, hlc: HLC): Promise<void> {
		await this.peerStates.setPeerState(peerSiteId, hlc);
	}

	async getPeerSyncState(peerSiteId: SiteId): Promise<HLC | undefined> {
		const state = await this.peerStates.getPeerState(peerSiteId);
		return state?.lastSyncHLC;
	}

	async pruneTombstones(): Promise<number> {
		const now = Date.now();
		let count = 0;
		const batch = this.kv.batch();

		const tbBounds = buildAllTombstonesScanBounds();
		for await (const entry of this.kv.iterate(tbBounds)) {
			const tombstone = deserializeTombstone(entry.value);

			if (now - tombstone.createdAt > this.config.tombstoneTTL) {
				batch.delete(entry.key);
				count++;
			}
		}

		await batch.write();
		return count;
	}

	getEventEmitter(): SyncEventEmitterImpl {
		return this.syncEvents;
	}

	// ============================================================================
	// Delegated: Streaming Snapshot API
	// ============================================================================

	async *getSnapshotStream(chunkSize?: number): AsyncIterable<SnapshotChunk> {
		yield* getSnapshotStreamImpl(this, chunkSize);
	}

	async applySnapshotStream(
		chunks: AsyncIterable<SnapshotChunk>,
		onProgress?: (progress: SnapshotProgress) => void
	): Promise<void> {
		return applySnapshotStreamImpl(this, chunks, onProgress);
	}

	async getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined> {
		return getSnapshotCheckpointImpl(this, snapshotId);
	}

	async *resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk> {
		yield* resumeSnapshotStreamImpl(this, checkpoint);
	}
}
