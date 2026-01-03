/**
 * React Native LevelDB plugin for Quereus.
 *
 * Registers a StoreModule backed by LevelDB for React Native mobile environments.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { StoreModule } from '@quereus/store';
import { ReactNativeLevelDBProvider } from './provider.js';
import type { LevelDBOpenFn } from './store.js';

/**
 * Plugin configuration options.
 */
export interface ReactNativeLevelDBPluginConfig {
	/**
	 * The LevelDB open function from react-native-leveldb.
	 * Obtain this from: import { LevelDB } from 'react-native-leveldb';
	 * Then pass: LevelDB.open
	 */
	openFn: LevelDBOpenFn;

	/**
	 * Base name prefix for all LevelDB databases.
	 * @default 'quereus'
	 */
	databaseName?: string;

	/**
	 * Create databases if they don't exist.
	 * @default true
	 */
	createIfMissing?: boolean;

	/**
	 * Module name to register. Tables are created with `USING <moduleName>`.
	 * @default 'store'
	 */
	moduleName?: string;
}

/**
 * Register the React Native LevelDB plugin with a database.
 *
 * @example
 * ```typescript
 * import { LevelDB } from 'react-native-leveldb';
 * import { Database, registerPlugin } from '@quereus/quereus';
 * import leveldbPlugin from '@quereus/plugin-react-native-leveldb/plugin';
 *
 * const db = new Database();
 * await registerPlugin(db, leveldbPlugin, { openFn: LevelDB.open });
 *
 * await db.exec(`
 *   create table users (id integer primary key, name text)
 *   using store
 * `);
 * ```
 */
export default function register(
	_db: Database,
	config: Record<string, SqlValue> = {}
) {
	// The LevelDB open function must be provided
	const openFn = config.openFn as unknown as LevelDBOpenFn;
	if (!openFn) {
		throw new Error(
			'@quereus/plugin-react-native-leveldb requires an "openFn" option with the LevelDB.open function. ' +
			'Import LevelDB from "react-native-leveldb" and pass LevelDB.open.'
		);
	}

	const databaseName = (config.databaseName as string) ?? 'quereus';
	const createIfMissing = config.createIfMissing !== false;
	const moduleName = (config.moduleName as string) ?? 'store';

	const provider = new ReactNativeLevelDBProvider({
		openFn,
		databaseName,
		createIfMissing,
	});

	const storeModule = new StoreModule(provider);

	return {
		vtables: [
			{
				name: moduleName,
				module: storeModule,
			},
		],
	};
}

