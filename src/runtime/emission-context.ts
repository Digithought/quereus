import type { Database } from '../core/database.js';
import type { SchemaManager } from '../schema/manager.js';
import type { TableSchema } from '../schema/table.js';
import type { FunctionSchema } from '../schema/function.js';
import type { VirtualTableModule } from '../vtab/module.js';
import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';

const log = createLogger('runtime:emission-context');

/**
 * Represents a dependency on a schema object that was resolved during emission.
 * Used for plan invalidation when schema changes.
 */
export interface SchemaDependency {
	readonly type: 'table' | 'function' | 'vtab_module' | 'collation';
	readonly schemaName?: string; // undefined for functions, collations, and vtab modules
	readonly objectName: string;
	readonly objectVersion?: number; // For future versioning support
}

/**
 * Tracks schema dependencies and provides a unique identifier for a set of dependencies.
 */
export class DependencyTracker {
	private dependencies = new Set<string>();
	private _fingerprint: string | null = null;

	/**
	 * Records a dependency on a schema object.
	 */
	addDependency(dep: SchemaDependency): void {
		const key = this.dependencyKey(dep);
		this.dependencies.add(key);
		this._fingerprint = null; // Invalidate cached fingerprint
	}

	/**
	 * Gets all tracked dependencies.
	 */
	getDependencies(): SchemaDependency[] {
		return Array.from(this.dependencies).map(key => this.parseDependencyKey(key));
	}

	/**
	 * Gets a fingerprint representing the current set of dependencies.
	 * This can be used to quickly check if dependencies have changed.
	 */
	getFingerprint(): string {
		if (this._fingerprint === null) {
			const sorted = Array.from(this.dependencies).sort();
			this._fingerprint = sorted.join('|');
		}
		return this._fingerprint;
	}

	/**
	 * Checks if this tracker has any dependencies that overlap with the given dependency.
	 */
	dependsOn(dep: SchemaDependency): boolean {
		const key = this.dependencyKey(dep);
		return this.dependencies.has(key);
	}

	/**
	 * Clears all tracked dependencies.
	 */
	clear(): void {
		this.dependencies.clear();
		this._fingerprint = null;
	}

	private dependencyKey(dep: SchemaDependency): string {
		const schema = dep.schemaName || '';
		const version = dep.objectVersion || 0;
		return `${dep.type}:${schema}:${dep.objectName}:${version}`;
	}

	private parseDependencyKey(key: string): SchemaDependency {
		const [type, schemaName, objectName, versionStr] = key.split(':');
		return {
			type: type as SchemaDependency['type'],
			schemaName: schemaName || undefined,
			objectName,
			objectVersion: parseInt(versionStr) || undefined
		};
	}
}

/**
 * Context provided to emitters during plan emission.
 * Allows schema lookups and tracks dependencies for plan invalidation.
 */
export class EmissionContext {
	private readonly schemaManager: SchemaManager;
	private readonly dependencyTracker = new DependencyTracker();

	constructor(public readonly db: Database) {
		this.db = db;
		this.schemaManager = db.schemaManager;
	}

	/**
	 * Looks up a table schema and records the dependency.
	 */
	findTable(tableName: string, schemaName?: string): TableSchema | undefined {
		const table = this.schemaManager.findTable(tableName, schemaName);
		if (table) {
			this.dependencyTracker.addDependency({
				type: 'table',
				schemaName: table.schemaName,
				objectName: table.name
			});
			log('Recorded table dependency: %s.%s', table.schemaName, table.name);
		}
		return table;
	}

	/**
	 * Looks up a function schema and records the dependency.
	 */
	findFunction(funcName: string, numArgs: number): FunctionSchema | undefined {
		const func = this.schemaManager.findFunction(funcName, numArgs);
		if (func) {
			this.dependencyTracker.addDependency({
				type: 'function',
				objectName: `${func.name}/${func.numArgs}`
			});
			log('Recorded function dependency: %s/%d', func.name, func.numArgs);
		}
		return func;
	}

	/**
	 * Looks up a virtual table module and records the dependency.
	 */
	getVtabModule(moduleName: string): { module: VirtualTableModule<any, any>, auxData?: unknown } | undefined {
		const moduleInfo = this.schemaManager.getModule(moduleName);
		if (moduleInfo) {
			this.dependencyTracker.addDependency({
				type: 'vtab_module',
				objectName: moduleName
			});
			log('Recorded vtab module dependency: %s', moduleName);
		}
		return moduleInfo;
	}

	/**
	 * Looks up a collation and records the dependency.
	 */
	getCollation(collationName: string): import('../util/comparison.js').CollationFunction | undefined {
		const collation = this.db._getCollation(collationName);
		if (collation) {
			this.dependencyTracker.addDependency({
				type: 'collation',
				objectName: collationName
			});
			log('Recorded collation dependency: %s', collationName);
		}
		return collation;
	}

	/**
	 * Gets the dependency tracker for this emission context.
	 */
	getDependencyTracker(): DependencyTracker {
		return this.dependencyTracker;
	}

	/**
	 * Gets a snapshot of all dependencies recorded during emission.
	 */
	getDependencies(): SchemaDependency[] {
		return this.dependencyTracker.getDependencies();
	}

	/**
	 * Gets a fingerprint representing all dependencies.
	 */
	getDependencyFingerprint(): string {
		return this.dependencyTracker.getFingerprint();
	}

	/**
	 * Provides access to the database instance for cases where direct access is needed.
	 * Use sparingly - prefer the specific lookup methods above.
	 */
	getDatabase(): Database {
		return this.db;
	}

	/**
	 * Provides access to the schema manager for cases where direct access is needed.
	 * Use sparingly - prefer the specific lookup methods above.
	 */
	getSchemaManager(): SchemaManager {
		return this.schemaManager;
	}
}

/**
 * Manages plan caching and invalidation based on schema dependencies.
 */
export class PlanCache {
	private cache = new Map<string, CachedPlan>();
	private schemaVersion = 0;

	constructor() {
		log('Plan cache initialized');
	}

	/**
	 * Stores a plan in the cache with its dependencies.
	 */
	store(key: string, plan: any, dependencies: SchemaDependency[]): void {
		this.cache.set(key, {
			plan,
			dependencies,
			schemaVersion: this.schemaVersion,
			createdAt: Date.now()
		});
		log('Cached plan with key: %s, dependencies: %d', key, dependencies.length);
	}

	/**
	 * Retrieves a plan from the cache if it's still valid.
	 */
	get(key: string): any | undefined {
		const cached = this.cache.get(key);
		if (!cached) {
			return undefined;
		}

		// Check if the plan is still valid based on schema version
		if (cached.schemaVersion < this.schemaVersion) {
			this.cache.delete(key);
			log('Invalidated cached plan due to schema version mismatch: %s', key);
			return undefined;
		}

		log('Retrieved cached plan: %s', key);
		return cached.plan;
	}

	/**
	 * Invalidates plans that depend on the given schema object.
	 */
	invalidate(dependency: SchemaDependency): number {
		let invalidatedCount = 0;
		const dependencyTracker = new DependencyTracker();
		dependencyTracker.addDependency(dependency);

		for (const [key, cached] of this.cache.entries()) {
			// Check if any of the cached plan's dependencies match the invalidation dependency
			for (const cachedDep of cached.dependencies) {
				const cachedTracker = new DependencyTracker();
				cachedTracker.addDependency(cachedDep);
				if (cachedTracker.dependsOn(dependency)) {
					this.cache.delete(key);
					invalidatedCount++;
					log('Invalidated cached plan due to dependency change: %s', key);
					break;
				}
			}
		}

		return invalidatedCount;
	}

	/**
	 * Increments the global schema version, effectively invalidating all cached plans.
	 */
	invalidateAll(): void {
		this.schemaVersion++;
		this.cache.clear();
		log('Invalidated all cached plans (schema version: %d)', this.schemaVersion);
	}

	/**
	 * Gets cache statistics.
	 */
	getStats(): { size: number; schemaVersion: number } {
		return {
			size: this.cache.size,
			schemaVersion: this.schemaVersion
		};
	}

	/**
	 * Clears the entire cache.
	 */
	clear(): void {
		this.cache.clear();
		log('Plan cache cleared');
	}
}

interface CachedPlan {
	plan: any;
	dependencies: SchemaDependency[];
	schemaVersion: number;
	createdAt: number;
}
