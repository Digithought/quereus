import type { Database, SqlValue } from '@quereus/quereus';
import { registerPlugin } from '@quereus/quereus';
import type { PluginManifest, PluginRegistrations } from './manifest.js';

/**
 * Plugin module interface - what we expect from a plugin module
 */
export interface PluginModule {
	/** Default export - the plugin registration function */
	default: (db: Database, config?: Record<string, SqlValue>) => Promise<PluginRegistrations> | PluginRegistrations;
}

/**
 * Extracts plugin manifest from package.json metadata
 * Looks for metadata in package.json root fields and quereus.provides/settings
 */
function extractManifestFromPackageJson(pkg: any): PluginManifest {
	const quereus = pkg.quereus || {};

	return {
		name: pkg.name || 'Unknown Plugin',
		version: pkg.version || '0.0.0',
		author: pkg.author,
		description: pkg.description,
		pragmaPrefix: quereus.pragmaPrefix,
		settings: quereus.settings,
		provides: quereus.provides,
		capabilities: quereus.capabilities
	};
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
			throw new Error(`Module at ${url} has no default export function`);
		}

		// Use the core registerPlugin function from @quereus/quereus
		// This reuses the same registration logic as static plugin loading
		await registerPlugin(db, mod.default, config);

		console.log(`Successfully loaded plugin from ${url}`);

		// Try to extract manifest from package.json
		let manifest: PluginManifest | undefined;
		try {
			const packageJsonUrl = new URL('package.json', moduleUrl);
			const packageJsonResponse = await fetch(packageJsonUrl.toString());
			if (packageJsonResponse.ok) {
				const pkg = await packageJsonResponse.json();
				manifest = extractManifestFromPackageJson(pkg);
			}
		} catch {
			// package.json not found or not accessible - that's okay
			console.log(`Could not load package.json for plugin at ${url}`);
		}

		return manifest;
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
        throw new Error(`Invalid plugin spec: ${spec}. Use a URL, file://, or npm package (e.g., npm:@scope/name@version).`);
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
            throw new Error(
                `Failed to resolve plugin package '${npm.name}'. Ensure it exports './plugin' or a default module. Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
            );
        }

        if (typeof mod.default !== 'function') {
            throw new Error(`Resolved module for '${npm.name}' has no default export function`);
        }

        // Use the core registerPlugin function from @quereus/quereus
        await registerPlugin(db, mod.default, config);
        console.log(`Successfully loaded plugin from package ${npm.name}`);

        // Try to extract manifest from package.json
        let manifest: PluginManifest | undefined;
        try {
            // Try to import package.json directly
            // @vite-ignore - intentional dynamic import for runtime plugin loading
            const pkg = await import(/* @vite-ignore */ `${npm.name}/package.json`, { assert: { type: 'json' } });
            manifest = extractManifestFromPackageJson(pkg.default);
        } catch {
            // package.json not found - that's okay
            console.log(`Could not load package.json for plugin ${npm.name}`);
        }

        return manifest;
    }

    // Browser path: npm spec requires CDN; only if explicitly allowed
    if (!options.allowCdn) {
        throw new Error(
            `Loading npm packages in the browser requires allowCdn=true. Received spec '${spec}'. ` +
            `Either provide a direct https:// URL to the ESM plugin or enable CDN resolution.`
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

