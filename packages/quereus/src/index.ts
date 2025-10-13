/**
 * Quereus - A TypeScript SQL Engine
 *
 * This module provides a TypeScript implementation of a SQL database engine
 * with support for virtual tables and the full SQL query language.
 */

// Core database functionality
export { Database } from './core/database.js';
export { Statement } from './core/statement.js';

// Common data types and constants
export { StatusCode, SqlDataType } from './common/types.js';
export type { SqlValue, SqlParameters, Row, MaybePromise, RowOp } from './common/types.js';
export { ConflictResolution, IndexConstraintOp, VTabConfig, FunctionFlags } from './common/constants.js';
export { QuereusError, MisuseError, ConstraintError, unwrapError, formatErrorChain, getPrimaryError } from './common/errors.js';
export type { ErrorInfo } from './common/errors.js';

// Virtual Table API
export { VirtualTable } from './vtab/table.js';
export type { VirtualTableConnection } from './vtab/connection.js';
export { MemoryTableModule } from './vtab/memory/module.js';
export type { IndexInfo, IndexConstraint, IndexConstraintUsage, IndexOrderBy } from './vtab/index-info.js';
export { IndexScanFlags } from './vtab/index-info.js';
export type { FilterInfo } from './vtab/filter-info.js';
export type { BaseModuleConfig, SchemaChangeInfo } from './vtab/module.js';

// Best Access Plan API (modern vtable planning interface)
export type {
	BestAccessPlanRequest,
	BestAccessPlanResult,
	ConstraintOp,
	ColumnMeta,
	PredicateConstraint,
	OrderingSpec
} from './vtab/best-access-plan.js';
export { AccessPlanBuilder, validateAccessPlan } from './vtab/best-access-plan.js';

// Collation functions
export type { CollationFunction } from './util/comparison.js';
export {
	BINARY_COLLATION,
	NOCASE_COLLATION,
	RTRIM_COLLATION,
	registerCollation,
	getCollation,
	resolveCollation
} from './util/comparison.js';

// SQL Parser and Compiler
export { Parser } from './parser/parser.js';
export { Lexer, TokenType, KEYWORDS } from './parser/lexer.js';
export { ParseError } from './parser/parser.js';

// Schema management
export { SchemaManager } from './schema/manager.js';
export type { TableSchema, IndexSchema as TableIndexSchema } from './schema/table.js';
export type { ColumnSchema } from './schema/column.js';
export type { FunctionSchema } from './schema/function.js';

// Runtime utilities
export { isAsyncIterable, asyncIterableToArray } from './runtime/utils.js';

// Function registration utilities
export {
	createScalarFunction,
	createTableValuedFunction,
	createAggregateFunction
} from './func/registration.js';

export type {
	ScalarFunc,
	TableValuedFunc,
	AggregateReducer,
	AggregateFinalizer
} from './schema/function.js';

// Utility functions
export { Latches } from './util/latches.js';

// Initialize runtime emitters (this ensures they are registered)
import './runtime/register.js';

// Re-export plugin system
export { dynamicLoadModule, validatePluginUrl, loadPlugin } from './util/plugin-loader.js';
export type {
	PluginManifest,
	PluginRecord,
	PluginSetting,
	VTablePluginInfo,
	FunctionPluginInfo,
	CollationPluginInfo,
	PluginRegistrations
} from './vtab/manifest.js';

// Re-export virtual table framework
export type { VirtualTableModule } from './vtab/module.js';

// Debug and development utilities
export { serializePlanTree, formatPlanTree, formatPlanSummary, serializePlanTreeWithOptions } from './planner/debug.js';
export type { PlanDisplayOptions } from './planner/debug.js';
