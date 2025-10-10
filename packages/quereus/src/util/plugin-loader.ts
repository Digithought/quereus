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


/** Loader options for loadPlugin */
export interface LoadPluginOptions {
    /**
     * Environment hint. Defaults to auto-detection.
     * 'browser' enables optional CDN resolution when allowCdn is true.
     */
    env?: 'auto' | 'browser' | 'node';
    /**
     * Allow resolving npm: specs to a public CDN in browser contexts.
     * Disabled by default (opt-in).
     */
    allowCdn?: boolean;
    /** Which CDN to use when allowCdn is true. Defaults to 'jsdelivr'. */
    cdn?: 'jsdelivr' | 'unpkg' | 'esm.sh';
}

/**
 * High-level plugin loader that accepts npm specs or direct URLs.
 *
 * Examples:
 * - npm:@scope/quereus-plugin-foo@^1
 * - @scope/quereus-plugin-foo (npm package name)
 * - https://raw.githubusercontent.com/user/repo/main/plugin.js
 * - file:///path/to/plugin.js (Node only)
 */
export async function loadPlugin(
    spec: string,
    db: Database,
    config: Record<string, SqlValue> = {},
    options: LoadPluginOptions = {}
): Promise<PluginManifest | undefined> {
    const env = options.env && options.env !== 'auto' ? options.env : (isBrowserEnv() ? 'browser' : 'node');

    // Direct URL or file path via dynamicLoadModule
    if (isUrlLike(spec)) {
        return await dynamicLoadModule(spec, db, config);
    }

    // Interpret as npm spec or bare package name
    const npm = parseNpmSpec(spec);
    if (!npm) {
        quereusError(`Invalid plugin spec: ${spec}. Use a URL, file://, or npm package (e.g., npm:@scope/name@version).`, StatusCode.FORMAT);
    }

    if (env === 'node') {
        // Resolve using Node ESM resolution. Prefer exported subpath './plugin'.
        const subpathImport = `${npm.name}/plugin${npm.subpath ?? ''}`;
        const candidates = [subpathImport, `${npm.name}${npm.subpath ?? ''}`];

        let mod: PluginModule | undefined;
        let lastErr: unknown = undefined;
        for (const target of candidates) {
            try {
                mod = await import(/* @vite-ignore */ target) as PluginModule;
                break;
            } catch (e) {
                lastErr = e;
            }
        }

        if (!mod) {
            quereusError(
                `Failed to resolve plugin package '${npm.name}'. Ensure it exports './plugin' or a default module. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
            );
        }

        if (typeof mod.default !== 'function') {
            quereusError(`Resolved module for '${npm.name}' has no default export function`, StatusCode.FORMAT);
        }

        const registrations = await mod.default(db, config);
        await registerPluginItems(db, registrations);
        log('Successfully loaded plugin from package %s', npm.name);
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
        return mod.manifest;
    }

    // Browser path: npm spec requires CDN; only if explicitly allowed
    if (!options.allowCdn) {
        quereusError(
            `Loading npm packages in the browser requires allowCdn=true. Received spec '${spec}'. ` +
            `Either provide a direct https:// URL to the ESM plugin or enable CDN resolution.`,
            StatusCode.MISUSE
        );
    }

    const cdnUrl = toCdnUrl(npm, options.cdn ?? 'jsdelivr');
    return await dynamicLoadModule(cdnUrl, db, config);
}

function isBrowserEnv(): boolean {
    // Heuristic: presence of document on globalThis implies browser
    return typeof globalThis !== 'undefined' && typeof (globalThis as unknown as { document?: unknown }).document !== 'undefined';
}

function isUrlLike(s: string): boolean {
    try {
        const u = new URL(s);
        return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'file:';
    } catch {
        return false;
    }
}

interface NpmSpec {
    name: string; // @scope/pkg or pkg
    version?: string; // optional semver or tag
    subpath?: string; // optional subpath after package root (rarely used)
}

function parseNpmSpec(input: string): NpmSpec | null {
    // Remove optional npm: prefix
    const raw = input.startsWith('npm:') ? input.slice(4) : input;

    // Quick reject if contains spaces or empty
    if (!raw || /\s/.test(raw)) return null;

    // Support patterns like:
    // @scope/name@1.2.3/path   name@^1  name  name/path
    // Split off subpath (first '/' that is not part of scope)
    let nameAndVersion = raw;
    let subpath: string | undefined;
    if (raw.startsWith('@')) {
        // Scoped: look for second '/'
        const secondSlash = raw.indexOf('/', raw.indexOf('/') + 1);
        if (secondSlash !== -1) {
            nameAndVersion = raw.slice(0, secondSlash);
            subpath = raw.slice(secondSlash);
        }
    } else {
        const firstSlash = raw.indexOf('/');
        if (firstSlash !== -1) {
            nameAndVersion = raw.slice(0, firstSlash);
            subpath = raw.slice(firstSlash);
        }
    }

    // Now split name@version
    const atIndex = nameAndVersion.lastIndexOf('@');
    if (nameAndVersion.startsWith('@')) {
        // Scoped: the first '@' is part of the scope
        if (atIndex > 0) {
            const name = nameAndVersion.slice(0, atIndex);
            const version = nameAndVersion.slice(atIndex + 1) || undefined;
            return { name, version, subpath };
        }
        return { name: nameAndVersion, subpath };
    } else {
        if (atIndex > 0) {
            const name = nameAndVersion.slice(0, atIndex);
            const version = nameAndVersion.slice(atIndex + 1) || undefined;
            return { name, version, subpath };
        }
        return { name: nameAndVersion, subpath };
    }
}

function toCdnUrl(spec: NpmSpec, cdn: 'jsdelivr' | 'unpkg' | 'esm.sh'): string {
    const versionSegment = spec.version ? `@${spec.version}` : '';
    const subpath = spec.subpath ? spec.subpath.replace(/^\//, '') : 'plugin';
    switch (cdn) {
        case 'unpkg':
            return `https://unpkg.com/${spec.name}${versionSegment}/${subpath}`;
        case 'esm.sh':
            // esm.sh expects ?path=/subpath or direct subpath after package
            // Use direct subpath; esm.sh will transform to ESM
            return `https://esm.sh/${spec.name}${versionSegment}/${subpath}`;
        case 'jsdelivr':
        default:
            return `https://cdn.jsdelivr.net/npm/${spec.name}${versionSegment}/${subpath}`;
    }
}

