/**
 * LevelDB plugin for Quereus.
 *
 * Registers a StoreModule backed by LevelDB for Node.js environments.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { StoreModule, createIsolatedStoreModule } from '@quereus/store';
import { LevelDBProvider } from './provider.js';

/**
 * Plugin configuration options.
 */
export interface LevelDBPluginConfig {
	/**
	 * Base path for all LevelDB stores.
	 * Each table gets a subdirectory under this path.
	 * @default './data'
	 */
	basePath?: string;

	/**
	 * Create directories if they don't exist.
	 * @default true
	 */
	createIfMissing?: boolean;

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
 * Register the LevelDB plugin with a database.
 */
export default function register(
	_db: Database,
	config: Record<string, SqlValue> = {}
) {
	const basePath = (config.basePath as string) ?? './data';
	const createIfMissing = config.createIfMissing !== false;
	const moduleName = (config.moduleName as string) ?? 'store';
	const isolation = (config.isolation as boolean) ?? true;

	const provider = new LevelDBProvider({
		basePath,
		createIfMissing,
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


