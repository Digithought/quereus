/**
 * Shared context for sync operations.
 *
 * Extracted modules (snapshot-stream, change-applicator, snapshot) receive
 * this context instead of accessing SyncManagerImpl internals directly.
 */

import type { KVStore } from '@quereus/store';
import type { HLCManager, HLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import type { ColumnVersionStore } from '../metadata/column-version.js';
import type { TombstoneStore } from '../metadata/tombstones.js';
import type { ChangeLogStore } from '../metadata/change-log.js';
import type { SchemaMigrationStore } from '../metadata/schema-migration.js';
import type { SyncConfig, ApplyToStoreCallback } from './protocol.js';
import type { SyncEventEmitterImpl } from './events.js';
import { SYNC_KEY_PREFIX } from '../metadata/keys.js';

/**
 * Context shared across sync sub-modules.
 *
 * SyncManagerImpl implements this interface; extracted functions
 * accept it as their first parameter.
 */
export interface SyncContext {
	readonly kv: KVStore;
	readonly config: SyncConfig;
	readonly hlcManager: HLCManager;
	readonly columnVersions: ColumnVersionStore;
	readonly tombstones: TombstoneStore;
	readonly changeLog: ChangeLogStore;
	readonly schemaMigrations: SchemaMigrationStore;
	readonly syncEvents: SyncEventEmitterImpl;
	readonly applyToStore?: ApplyToStoreCallback;

	getSiteId(): SiteId;
	getCurrentHLC(): HLC;
}

/**
 * Persist HLC state to the KV store (standalone put).
 */
export async function persistHLCState(ctx: SyncContext): Promise<void> {
	const state = ctx.hlcManager.getState();
	const buffer = new Uint8Array(10);
	const view = new DataView(buffer.buffer);
	view.setBigUint64(0, state.wallTime, false);
	view.setUint16(8, state.counter, false);
	await ctx.kv.put(SYNC_KEY_PREFIX.HLC_STATE, buffer);
}

/**
 * Write HLC state into an existing WriteBatch.
 */
export function persistHLCStateBatch(
	ctx: SyncContext,
	batch: import('@quereus/store').WriteBatch,
): void {
	const state = ctx.hlcManager.getState();
	const buffer = new Uint8Array(10);
	const view = new DataView(buffer.buffer);
	view.setBigUint64(0, state.wallTime, false);
	view.setUint16(8, state.counter, false);
	batch.put(SYNC_KEY_PREFIX.HLC_STATE, buffer);
}
