/**
 * SQLiter - A TypeScript SQL Engine
 *
 * This module provides a TypeScript implementation of a SQL database engine
 * with support for virtual tables and the full SQL query language.
 */

// Core database functionality
export { Database } from './core/database';
export { Statement } from './core/statement';

// Common data types and constants
export { StatusCode, SqlDataType } from './common/types';
export type { SqlValue } from './common/types';
export { Opcode, ConflictResolution } from './common/constants';
export { SqliteError, MisuseError, ConstraintError } from './common/errors';

// Virtual Table API
export { VirtualTable } from './vtab/table';
export { VirtualTableCursor } from './vtab/cursor';
export { type VirtualTableModule } from './vtab/module';
export { MemoryTableModule } from './vtab/memory-module';

// SQL Parser and Compiler
export { Parser } from './parser/parser';
export { Lexer, TokenType } from './parser/lexer';
export { ParseError } from './parser/parser';
export { Compiler } from './compiler/compiler';

// Virtual Database Engine
export { Vdbe } from './vdbe/engine';
export type { VdbeProgram } from './vdbe/program';
export { createInstruction } from './vdbe/instruction';
export type { VdbeInstruction } from './vdbe/instruction';

// Schema management
export { SchemaManager } from './schema/manager';
export type { TableSchema } from './schema/table';
export type { FunctionSchema } from './schema/function';

// Function API
export { FunctionContext } from './func/context';

// Utility functions
export { Latches } from './util/latches';
