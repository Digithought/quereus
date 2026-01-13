/**
 * Convenience utilities for creating isolated store modules.
 *
 * The store module by itself does not provide transaction isolation.
 * This module provides utilities to wrap store modules with an
 * isolation layer for full ACID semantics including:
 *
 * - Read-your-own-writes within transactions
 * - Snapshot isolation (reads see consistent state)
 * - Savepoint support
 */

import { IsolationModule } from '@quereus/isolation';
import { MemoryTableModule, type VTableEventEmitter } from '@quereus/quereus';
import type { KVStoreProvider } from './kv-store.js';
import type { StoreEventEmitter } from './events.js';
import { StoreModule } from './store-module.js';

/**
 * Configuration options for creating an isolated store module.
 */
export interface IsolatedStoreModuleConfig {
	/**
	 * The KVStoreProvider for persistent storage.
	 */
	provider: KVStoreProvider;

	/**
	 * Optional event emitter for store events (data changes, schema changes).
	 */
	eventEmitter?: StoreEventEmitter;

	/**
	 * Optional overlay event emitter (typically not needed).
	 * If provided, will be passed to the overlay MemoryTableModule.
	 */
	overlayEventEmitter?: VTableEventEmitter;

	/**
	 * Optional name for the tombstone column in the overlay.
	 * Defaults to '_tombstone'.
	 */
	tombstoneColumn?: string;
}

/**
 * Creates a store module wrapped with an isolation layer for full ACID semantics.
 *
 * This provides:
 * - Read-your-own-writes within transactions
 * - Snapshot isolation (reads see consistent state)
 * - Savepoint support via overlay module
 *
 * @example
 * ```typescript
 * import { createIsolatedStoreModule } from '@quereus/store';
 * import { createLevelDBProvider } from '@quereus/plugin-leveldb';
 *
 * const provider = createLevelDBProvider({ basePath: './data' });
 * const module = createIsolatedStoreModule({ provider });
 * db.registerModule('store', module);
 *
 * // Now transactions have full isolation
 * await db.exec('BEGIN');
 * await db.exec(`INSERT INTO users VALUES (1, 'Alice')`);
 * // This SELECT sees the uncommitted insert
 * const user = await db.get('SELECT * FROM users WHERE id = 1');
 * await db.exec('COMMIT');
 * ```
 */
export function createIsolatedStoreModule(config: IsolatedStoreModuleConfig): IsolationModule {
	// Create the underlying store module
	const storeModule = new StoreModule(config.provider, config.eventEmitter);

	// Create the overlay module (memory tables for uncommitted changes)
	const overlayModule = new MemoryTableModule(config.overlayEventEmitter);

	// Wrap with isolation layer
	return new IsolationModule({
		underlying: storeModule,
		overlay: overlayModule,
		tombstoneColumn: config.tombstoneColumn,
	});
}

/**
 * Type guard to check if a module has isolation capability.
 */
export function hasIsolation(module: { getCapabilities?: () => { isolation?: boolean } }): boolean {
	return module.getCapabilities?.().isolation === true;
}
