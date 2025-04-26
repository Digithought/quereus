/**
 * SQLiter - A TypeScript SQL Engine
 *
 * This module provides a TypeScript implementation of a SQL database engine
 * with support for virtual tables and the full SQL query language.
 */

// Core database functionality
export { Database } from './core/database.js';
export { Statement } from './core/statement.js';

// Common data types and constants
export { StatusCode, SqlDataType } from './common/types.js';
export type { SqlValue } from './common/types.js';
export { ConflictResolution } from './common/constants.js';
export { Opcode } from './vdbe/opcodes.js';
export { SqliteError, MisuseError, ConstraintError } from './common/errors.js';

// Virtual Table API
export { VirtualTable } from './vtab/table.js';
export { VirtualTableCursor } from './vtab/cursor.js';
export { type VirtualTableModule } from './vtab/module.js';
export { MemoryTableModule } from './vtab/memory/module.js';

// SQL Parser and Compiler
export { Parser } from './parser/parser.js';
export { Lexer, TokenType } from './parser/lexer.js';
export { ParseError } from './parser/parser.js';
export { Compiler } from './compiler/compiler.js';

// Virtual Database Engine
export { VdbeRuntime } from './vdbe/runtime.js';
export type { VdbeProgram } from './vdbe/program.js';
export { createInstruction } from './vdbe/instruction.js';
export type { VdbeInstruction } from './vdbe/instruction.js';

// Schema management
export { SchemaManager } from './schema/manager.js';
export type { TableSchema } from './schema/table.js';
export type { FunctionSchema } from './schema/function.js';

// Function API
export { FunctionContext } from './func/context.js';

// Utility functions
export { Latches } from './util/latches.js';
