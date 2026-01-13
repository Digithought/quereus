/**
 * IndexedDB plugin for Quereus.
 *
 * Registers a StoreModule backed by IndexedDB for browser environments.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { StoreModule, createIsolatedStoreModule } from '@quereus/store';
import { IndexedDBProvider } from './provider.js';

/**
 * Plugin configuration options.
 */
export interface IndexedDBPluginConfig {
	/**
	 * Name for the unified IndexedDB database.
	 * All tables share this single database with separate object stores.
	 * @default 'quereus'
	 */
	databaseName?: string;

	/**
	 * Module name to register. Tables are created with `USING <moduleName>`.
	 * @default 'store'
	 */
	moduleName?: string;

	/**
	 * Enable transaction isolation (read-your-own-writes, snapshot isolation).
	 * When true, wraps the store module with an isolation layer.
	 * @default true
	 */
	isolation?: boolean;
}

/**
 * Register the IndexedDB plugin with a database.
 */
export default function register(
	_db: Database,
	config: Record<string, SqlValue> = {}
) {
	const databaseName = (config.databaseName as string) ?? 'quereus';
	const moduleName = (config.moduleName as string) ?? 'store';
	const isolation = (config.isolation as boolean) ?? true;

	const provider = new IndexedDBProvider({
		databaseName,
	});

	const storeModule = isolation
		? createIsolatedStoreModule({ provider })
		: new StoreModule(provider);

	return {
		vtables: [
			{
				name: moduleName,
				module: storeModule,
			},
		],
	};
}


