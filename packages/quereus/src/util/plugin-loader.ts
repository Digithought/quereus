import type { Database } from '../core/database.js';
import type { PluginManifest, PluginRegistrations } from '../vtab/manifest.js';
import { StatusCode, type SqlValue } from '../common/types.js';
import { quereusError } from '../common/errors.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('util:plugin-loader');

/**
 * Plugin module interface - what we expect from a plugin module
 */
export interface PluginModule {
	/** Plugin manifest with metadata */
	manifest?: PluginManifest;
	
	/** Default export - the plugin registration function */
	default: (db: Database, config: Record<string, SqlValue>) => Promise<PluginRegistrations> | PluginRegistrations;
}

/**
 * Dynamically loads and registers a plugin module
 *
 * @param url The URL to the ES module (can be https:// or file:// URL)
 * @param db The Database instance to register the module with
 * @param config Configuration values to pass to the module
 * @returns The plugin's manifest if available
 */
export async function dynamicLoadModule(
	url: string,
	db: Database,
	config: Record<string, SqlValue> = {}
): Promise<PluginManifest | undefined> {
	try {
		// Add cache-busting timestamp for development
		const moduleUrl = new URL(url);
		if (moduleUrl.protocol === 'file:' || moduleUrl.hostname === 'localhost') {
			moduleUrl.searchParams.set('t', Date.now().toString());
		}

		// Dynamic import with Vite ignore comment for bundler compatibility
		const mod = await import(/* @vite-ignore */ moduleUrl.toString()) as PluginModule;

		// Validate module structure
		if (typeof mod.default !== 'function') {
			quereusError(`Module at ${url} has no default export function`, StatusCode.FORMAT);
		}

		// Call the module's register function with the database and config
		const registrations = await mod.default(db, config);

		// Register all the items the plugin provides
		await registerPluginItems(db, registrations);

		log('Successfully loaded plugin from %s', url);
		if (registrations.vtables?.length) {
			log('  Registered %d vtable module(s): %s', registrations.vtables.length, 
				registrations.vtables.map(v => v.name).join(', '));
		}
		if (registrations.functions?.length) {
			log('  Registered %d function(s): %s', registrations.functions.length,
				registrations.functions.map(f => `${f.schema.name}/${f.schema.numArgs}`).join(', '));
		}
		if (registrations.collations?.length) {
			log('  Registered %d collation(s): %s', registrations.collations.length,
				registrations.collations.map(c => c.name).join(', '));
		}

		// Return the manifest if available
		return mod.manifest;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		quereusError(`Failed to load plugin from ${url}: ${message}`);
	}
}

/**
 * Registers all items provided by a plugin
 * 
 * @param db Database instance to register with
 * @param registrations The items to register
 */
async function registerPluginItems(db: Database, registrations: PluginRegistrations): Promise<void> {
	// Register virtual table modules
	if (registrations.vtables) {
		for (const vtable of registrations.vtables) {
			try {
				db.registerVtabModule(vtable.name, vtable.module, vtable.auxData);
			} catch (error) {
				quereusError(`Failed to register vtable module '${vtable.name}': ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// Register functions
	if (registrations.functions) {
		for (const func of registrations.functions) {
			try {
				db.registerFunction(func.schema);
			} catch (error) {
				quereusError(`Failed to register function '${func.schema.name}/${func.schema.numArgs}': ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// Register collations
	if (registrations.collations) {
		for (const collation of registrations.collations) {
			try {
				db.registerCollation(collation.name, collation.func);
			} catch (error) {
				quereusError(`Failed to register collation '${collation.name}': ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}

/**
 * Validates that a URL is likely to be a valid plugin module
 *
 * @param url The URL to validate
 * @returns true if the URL appears valid
 */
export function validatePluginUrl(url: string): boolean {
	try {
		const parsed = new URL(url);

		// Allow https:// and file:// protocols
		if (!['https:', 'file:'].includes(parsed.protocol)) {
			return false;
		}

		// Must end with .js or .mjs
		if (!/\.(m?js)$/i.test(parsed.pathname)) {
			return false;
		}

		return true;
	} catch {
		return false;
	}
}

/**
 * Legacy plugin support - for backward compatibility with old-style plugins
 * that register vtables directly in their default export function
 */
export async function loadLegacyPlugin(
	url: string,
	db: Database,
	config: Record<string, SqlValue> = {}
): Promise<PluginManifest | undefined> {
	try {
		const moduleUrl = new URL(url);
		if (moduleUrl.protocol === 'file:' || moduleUrl.hostname === 'localhost') {
			moduleUrl.searchParams.set('t', Date.now().toString());
		}

		const mod = await import(/* @vite-ignore */ moduleUrl.toString());

		if (typeof mod.default !== 'function') {
			quereusError(`Module at ${url} has no default export function`, StatusCode.FORMAT);
		}

		// Call the legacy plugin function - it registers directly with the database
		await mod.default(db, config);

		log('Successfully loaded legacy plugin from %s', url);
		return mod.manifest as PluginManifest | undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		quereusError(`Failed to load legacy plugin from ${url}: ${message}`);
	}
}
