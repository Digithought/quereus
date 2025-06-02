import type { Database } from '../core/database.js';
import type { PluginManifest } from '../vtab/manifest.js';
import type { SqlValue } from '../common/types.js';

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
		const mod = await import(/* @vite-ignore */ moduleUrl.toString());

		// Validate module structure
		if (typeof mod.default !== 'function') {
			throw new Error(`Module at ${url} has no default export function`);
		}

		// Call the module's register function with the database and config
		await mod.default(db, config);

		// Return the manifest if available
		return mod.manifest as PluginManifest | undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to load plugin from ${url}: ${message}`);
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
