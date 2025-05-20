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
export type { SqlValue, SqlParameters, Row, RowIdRow } from './common/types.js';
export { ConflictResolution } from './common/constants.js';
export { SqliterError, MisuseError, ConstraintError } from './common/errors.js';

// Virtual Table API
export { VirtualTable } from './vtab/table.js';
export { MemoryTableModule } from './vtab/memory/module.js';
export type { IndexInfo, IndexConstraint, IndexConstraintUsage, IndexOrderBy, IndexScanFlags } from './vtab/index-info.js';
export type { FilterInfo } from './vtab/filter-info.js';

// SQL Parser and Compiler
export { Parser } from './parser/parser.js';
export { Lexer, TokenType } from './parser/lexer.js';
export { ParseError } from './parser/parser.js';

// Schema management
export { SchemaManager } from './schema/manager.js';
export type { TableSchema, IndexSchema as TableIndexSchema } from './schema/table.js';
export type { ColumnSchema } from './schema/column.js';
export type { FunctionSchema } from './schema/function.js';

// Function API
export { FunctionContext } from './func/context.js';

// Utility functions
export { Latches } from './util/latches.js';

// Initialize runtime emitters (this ensures they are registered)
import './runtime/index.js';
