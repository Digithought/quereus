/**
 * Plugin registration helper for static plugin loading
 *
 * This module provides utilities for registering plugins without dynamic imports,
 * which is useful for React Native and other environments where dynamic imports
 * are not supported.
 */

import type { Database } from '../core/database.js';
import type { PluginRegistrations } from '../vtab/manifest.js';
import type { SqlValue } from '../common/types.js';

/**
 * Plugin function type - what a plugin exports as its default export
 */
export type PluginFunction = (
	db: Database,
	config?: Record<string, SqlValue>
) => Promise<PluginRegistrations> | PluginRegistrations;

/**
 * Register a plugin's components with the database.
 *
 * This is a helper function for static plugin loading that handles calling
 * the plugin function and registering all returned components (vtables,
 * functions, collations, types) with the database.
 *
 * @param db Database instance to register with
 * @param plugin Plugin function (the default export from a plugin module)
 * @param config Optional configuration object to pass to the plugin
 *
 * @example
 * ```typescript
 * import { Database } from '@quereus/quereus';
 * import { registerPlugin } from '@quereus/quereus';
 * import myPlugin from './plugins/my-plugin';
 *
 * const db = new Database();
 * await registerPlugin(db, myPlugin, { apiKey: 'secret' });
 * ```
 *
 * @example
 * ```typescript
 * // Register multiple plugins
 * await registerPlugin(db, stringFunctions);
 * await registerPlugin(db, customCollations);
 * await registerPlugin(db, jsonTable, { cacheSize: 100 });
 * ```
 */
export async function registerPlugin(
	db: Database,
	plugin: PluginFunction,
	config: Record<string, SqlValue> = {}
): Promise<void> {
	// Call the plugin function to get registrations
	const registrations = await plugin(db, config);

	// Register virtual table modules
	if (registrations.vtables) {
		for (const vtable of registrations.vtables) {
			try {
				db.registerModule(vtable.name, vtable.module, vtable.auxData);
			} catch (error) {
				throw new Error(
					`Failed to register vtable module '${vtable.name}': ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	}

	// Register functions
	if (registrations.functions) {
		for (const func of registrations.functions) {
			try {
				db.registerFunction(func.schema);
			} catch (error) {
				throw new Error(
					`Failed to register function '${func.schema.name}/${func.schema.numArgs}': ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	}

	// Register collations
	if (registrations.collations) {
		for (const collation of registrations.collations) {
			try {
				db.registerCollation(collation.name, collation.func);
			} catch (error) {
				throw new Error(
					`Failed to register collation '${collation.name}': ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	}

	// Register types
	if (registrations.types) {
		for (const type of registrations.types) {
			try {
				db.registerType(type.name, type.definition);
			} catch (error) {
				throw new Error(
					`Failed to register type '${type.name}': ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}
	}
}

