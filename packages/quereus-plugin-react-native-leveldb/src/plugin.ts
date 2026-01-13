/**
 * React Native LevelDB plugin for Quereus.
 *
 * Registers a StoreModule backed by LevelDB for React Native mobile environments.
 * Uses rn-leveldb for native LevelDB bindings.
 */

import type { Database, SqlValue } from '@quereus/quereus';
import { StoreModule, createIsolatedStoreModule } from '@quereus/store';
import { ReactNativeLevelDBProvider } from './provider.js';
import type { LevelDBOpenFn, LevelDBWriteBatchConstructor } from './store.js';

/**
 * Plugin configuration options.
 */
export interface ReactNativeLevelDBPluginConfig {
	/**
	 * The LevelDB open function from rn-leveldb.
	 * Obtain this from: import { LevelDB } from 'rn-leveldb';
	 * Then pass: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists)
	 */
	openFn: LevelDBOpenFn;

	/**
	 * The LevelDBWriteBatch constructor from rn-leveldb.
	 * Obtain this from: import { LevelDBWriteBatch } from 'rn-leveldb';
	 */
	WriteBatch: LevelDBWriteBatchConstructor;

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

	/**
	 * Enable transaction isolation (read-your-own-writes, snapshot isolation).
	 * When true, wraps the store module with an isolation layer.
	 * @default true
	 */
	isolation?: boolean;
}

/**
 * Register the React Native LevelDB plugin with a database.
 *
 * @example
 * ```typescript
 * import { LevelDB, LevelDBWriteBatch } from 'rn-leveldb';
 * import { Database, registerPlugin } from '@quereus/quereus';
 * import leveldbPlugin from '@quereus/plugin-react-native-leveldb/plugin';
 *
 * const db = new Database();
 * await registerPlugin(db, leveldbPlugin, {
 *   openFn: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists),
 *   WriteBatch: LevelDBWriteBatch,
 * });
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
			'@quereus/plugin-react-native-leveldb requires an "openFn" option. ' +
			'Import LevelDB from "rn-leveldb" and pass: (name, createIfMissing, errorIfExists) => new LevelDB(name, createIfMissing, errorIfExists)'
		);
	}

	// The WriteBatch constructor must be provided
	const WriteBatch = config.WriteBatch as unknown as LevelDBWriteBatchConstructor;
	if (!WriteBatch) {
		throw new Error(
			'@quereus/plugin-react-native-leveldb requires a "WriteBatch" option. ' +
			'Import LevelDBWriteBatch from "rn-leveldb" and pass it as WriteBatch.'
		);
	}

	const databaseName = (config.databaseName as string) ?? 'quereus';
	const createIfMissing = config.createIfMissing !== false;
	const moduleName = (config.moduleName as string) ?? 'store';
	const isolation = (config.isolation as boolean) ?? true;

	const provider = new ReactNativeLevelDBProvider({
		openFn,
		WriteBatch,
		databaseName,
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


