import type { PlanningContext, SchemaDependency } from '../planning-context.js';
import type { TableSchema } from '../../schema/table.js';
import type { FunctionSchema } from '../../schema/function.js';
import type { VirtualTableModule } from '../../vtab/module.js';
import type { CollationFunction } from '../../util/comparison.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:schema-resolution');

/**
 * Resolves a table schema at build time and records the dependency.
 */
export function resolveTableSchema(
	ctx: PlanningContext,
	tableName: string,
	schemaName?: string
): TableSchema {
	const resolvedSchemaName = schemaName || ctx.db.schemaManager.getCurrentSchemaName();
	const cacheKey = `table:${resolvedSchemaName}:${tableName}`;

	// Check cache first
	const cached = ctx.schemaCache.get(cacheKey);
	if (cached) {
		log('Using cached table schema: %s.%s', resolvedSchemaName, tableName);
		return cached as TableSchema;
	}

	// Resolve table schema
	const tableSchema = ctx.schemaManager.findTable(tableName, resolvedSchemaName);
	if (!tableSchema) {
		throw new QuereusError(
			`Table not found: ${resolvedSchemaName}.${tableName}`,
			StatusCode.ERROR
		);
	}

	// Record dependency
	const dependency: SchemaDependency = {
		type: 'table',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name
	};
	ctx.schemaDependencies.recordDependency(dependency, tableSchema);

	// Cache result
	ctx.schemaCache.set(cacheKey, tableSchema);

	log('Resolved table schema: %s.%s', tableSchema.schemaName, tableSchema.name);
	return tableSchema;
}

/**
 * Resolves a function schema at build time and records the dependency.
 */
export function resolveFunctionSchema(
	ctx: PlanningContext,
	funcName: string,
	numArgs: number
): FunctionSchema {
	const cacheKey = `function:${funcName}/${numArgs}`;

	// Check cache first
	const cached = ctx.schemaCache.get(cacheKey);
	if (cached) {
		log('Using cached function schema: %s/%d', funcName, numArgs);
		return cached as FunctionSchema;
	}

	// Resolve function schema - try exact match first
	let functionSchema = ctx.schemaManager.findFunction(funcName, numArgs);

	// If not found, try variable argument function
	if (!functionSchema) {
		functionSchema = ctx.schemaManager.findFunction(funcName, -1);
	}

	if (!functionSchema) {
		throw new QuereusError(
			`Function not found: ${funcName}/${numArgs}`,
			StatusCode.ERROR
		);
	}

	// Record dependency using the actual function's numArgs
	const dependency: SchemaDependency = {
		type: 'function',
		objectName: `${functionSchema.name}/${functionSchema.numArgs}`
	};
	ctx.schemaDependencies.recordDependency(dependency, functionSchema);

	// Cache result with the requested key for future lookups
	ctx.schemaCache.set(cacheKey, functionSchema);

	log('Resolved function schema: %s/%d', functionSchema.name, functionSchema.numArgs);
	return functionSchema;
}

/**
 * Resolves a virtual table module at build time and records the dependency.
 */
export function resolveVtabModule(
	ctx: PlanningContext,
	moduleName: string
): { module: VirtualTableModule<any, any>, auxData?: unknown } {
	const cacheKey = `vtab_module:${moduleName}`;

	// Check cache first
	const cached = ctx.schemaCache.get(cacheKey);
	if (cached) {
		log('Using cached vtab module: %s', moduleName);
		return cached;
	}

	// Resolve vtab module
	const moduleInfo = ctx.schemaManager.getModule(moduleName);
	if (!moduleInfo) {
		throw new QuereusError(
			`Virtual table module not found: ${moduleName}`,
			StatusCode.ERROR
		);
	}

	// Record dependency
	const dependency: SchemaDependency = {
		type: 'vtab_module',
		objectName: moduleName
	};
	ctx.schemaDependencies.recordDependency(dependency, moduleInfo);

	// Cache result
	ctx.schemaCache.set(cacheKey, moduleInfo);

	log('Resolved vtab module: %s', moduleName);
	return moduleInfo;
}

/**
 * Resolves a collation function at build time and records the dependency.
 */
export function resolveCollation(
	ctx: PlanningContext,
	collationName: string
): CollationFunction {
	const cacheKey = `collation:${collationName}`;

	// Check cache first
	const cached = ctx.schemaCache.get(cacheKey);
	if (cached) {
		log('Using cached collation: %s', collationName);
		return cached as CollationFunction;
	}

	// Resolve collation
	const collation = ctx.db._getCollation(collationName);
	if (!collation) {
		throw new QuereusError(
			`Collation not found: ${collationName}`,
			StatusCode.ERROR
		);
	}

	// Record dependency
	const dependency: SchemaDependency = {
		type: 'collation',
		objectName: collationName
	};
	ctx.schemaDependencies.recordDependency(dependency, collation);

	// Cache result
	ctx.schemaCache.set(cacheKey, collation);

	log('Resolved collation: %s', collationName);
	return collation;
}
