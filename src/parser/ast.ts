import type { SqlValue } from '../common/types';
import type { ConflictResolution } from '../common/constants';

/**
 * SQL Abstract Syntax Tree (AST) definitions
 * These interfaces define the structure of parsed SQL statements
 */

// Base for all AST nodes
export interface AstNode {
	type: 'literal' | 'identifier' | 'column' | 'binary' | 'unary' | 'function' | 'cast' | 'parameter' | 'subquery' | 'select' | 'insert' | 'update' | 'delete' | 'createTable' | 'createVirtualTable' | 'createIndex' | 'createView' | 'alterTable' | 'drop' | 'begin' | 'commit' | 'rollback' | 'table' | 'join' | 'savepoint' | 'release';
}

// Expression types
export type Expression =
	| LiteralExpr
	| IdentifierExpr
	| BinaryExpr
	| UnaryExpr
	| FunctionExpr
	| CastExpr
	| ParameterExpr
	| SubqueryExpr
	| ColumnExpr;

// Literal value expression (number, string, null, etc.)
export interface LiteralExpr extends AstNode {
	type: 'literal';
	value: SqlValue;
	dataType?: string; // Optional type hint
}

// Identifier expression (table name, column name, etc.)
export interface IdentifierExpr extends AstNode {
	type: 'identifier';
	name: string;
	schema?: string; // Optional schema qualifier
	table?: string;  // Optional table qualifier
}

// Column reference expression
export interface ColumnExpr extends AstNode {
	type: 'column';
	name: string;
	table?: string;  // Optional table qualifier
	schema?: string; // Optional schema qualifier
	alias?: string;  // Optional column alias
}

// Binary operation expression
export interface BinaryExpr extends AstNode {
	type: 'binary';
	operator: string; // +, -, *, /, AND, OR, =, <, etc.
	left: Expression;
	right: Expression;
}

// Unary operation expression
export interface UnaryExpr extends AstNode {
	type: 'unary';
	operator: string; // NOT, -, +, etc.
	expr: Expression;
}

// Function call expression
export interface FunctionExpr extends AstNode {
	type: 'function';
	name: string;
	args: Expression[];
	isAggregate?: boolean;
}

// CAST expression
export interface CastExpr extends AstNode {
	type: 'cast';
	expr: Expression;
	targetType: string;
}

// Parameter expression (? or :name or $name)
export interface ParameterExpr extends AstNode {
	type: 'parameter';
	index?: number;  // For positional parameters (?)
	name?: string;   // For named parameters (:name or $name)
}

// Subquery expression
export interface SubqueryExpr extends AstNode {
	type: 'subquery';
	query: SelectStmt;
}

// --- Statement Types ---

// SELECT statement
export interface SelectStmt extends AstNode {
	type: 'select';
	columns: ResultColumn[];
	from?: FromClause[];
	where?: Expression;
	groupBy?: Expression[];
	having?: Expression;
	orderBy?: OrderByClause[];
	limit?: Expression;
	offset?: Expression;
	distinct?: boolean;
	all?: boolean;
	union?: SelectStmt;
	unionAll?: boolean;
}

// INSERT statement
export interface InsertStmt extends AstNode {
	type: 'insert';
	table: IdentifierExpr;
	columns?: string[];
	values?: Expression[][];  // For VALUES (...), (...), ...
	select?: SelectStmt;      // For INSERT ... SELECT
	onConflict?: ConflictResolution;
	returning?: ResultColumn[];
}

// UPDATE statement
export interface UpdateStmt extends AstNode {
	type: 'update';
	table: IdentifierExpr;
	assignments: { column: string; value: Expression }[];
	where?: Expression;
	onConflict?: ConflictResolution;
	returning?: ResultColumn[];
}

// DELETE statement
export interface DeleteStmt extends AstNode {
	type: 'delete';
	table: IdentifierExpr;
	where?: Expression;
	returning?: ResultColumn[];
}

// CREATE TABLE statement
export interface CreateTableStmt extends AstNode {
	type: 'createTable';
	table: IdentifierExpr;
	ifNotExists: boolean;
	columns: ColumnDef[];
	constraints: TableConstraint[];
	withoutRowid?: boolean;
	isTemporary?: boolean;
}

// CREATE VIRTUAL TABLE statement
export interface CreateVirtualTableStmt extends AstNode {
	type: 'createVirtualTable';
	table: IdentifierExpr;
	ifNotExists: boolean;
	moduleName: string;
	moduleArgs: string[];
}

// CREATE INDEX statement
export interface CreateIndexStmt extends AstNode {
	type: 'createIndex';
	index: IdentifierExpr;
	table: IdentifierExpr;
	ifNotExists: boolean;
	columns: IndexedColumn[];
	where?: Expression;
	isUnique?: boolean;
}

// CREATE VIEW statement
export interface CreateViewStmt extends AstNode {
	type: 'createView';
	view: IdentifierExpr;
	ifNotExists: boolean;
	columns?: string[];
	select: SelectStmt;
	isTemporary?: boolean;
}

// ALTER TABLE statement
export interface AlterTableStmt extends AstNode {
	type: 'alterTable';
	table: IdentifierExpr;
	action: AlterTableAction;
}

// DROP statement
export interface DropStmt extends AstNode {
	type: 'drop';
	objectType: 'table' | 'view' | 'index' | 'trigger';
	name: IdentifierExpr;
	ifExists: boolean;
}

// TRANSACTION statements
export interface BeginStmt extends AstNode {
	type: 'begin';
	mode?: 'deferred' | 'immediate' | 'exclusive';
}

export interface CommitStmt extends AstNode {
	type: 'commit';
}

export interface RollbackStmt extends AstNode {
	type: 'rollback';
	savepoint?: string;
}

// --- Add Savepoint/Release ---
export interface SavepointStmt extends AstNode {
    type: 'savepoint';
    name: string;
}

export interface ReleaseStmt extends AstNode {
    type: 'release';
    savepoint?: string; // Optional savepoint name
}

// --- Supporting Types ---

// Result column in SELECT
export type ResultColumn =
	| { type: 'all', table?: string }
	| { type: 'column', expr: Expression, alias?: string };

// FROM clause item (table or join)
export type FromClause = TableSource | JoinClause;

// Table source in FROM clause
export interface TableSource extends AstNode {
	type: 'table';
	table: IdentifierExpr;
	alias?: string;
}

// JOIN clause in FROM
export interface JoinClause extends AstNode {
	type: 'join';
	joinType: 'inner' | 'left' | 'right' | 'full' | 'cross';
	left: FromClause;
	right: FromClause;
	condition?: Expression; // For ON clause
	columns?: string[];     // For USING clause
}

// ORDER BY clause
export interface OrderByClause {
	expr: Expression;
	direction: 'asc' | 'desc';
	nulls?: 'first' | 'last';
}

// Column definition in CREATE TABLE
export interface ColumnDef {
	name: string;
	dataType?: string;
	constraints: ColumnConstraint[];
}

// Column constraint (PRIMARY KEY, NOT NULL, etc.)
export interface ColumnConstraint {
	type: 'primaryKey' | 'notNull' | 'unique' | 'check' | 'default' | 'foreignKey' | 'collate' | 'generated';
	name?: string;
	expr?: Expression;          // For CHECK or DEFAULT
	collation?: string;         // For COLLATE
	autoincrement?: boolean;    // For PRIMARY KEY AUTOINCREMENT
	onConflict?: ConflictResolution;
	foreignKey?: ForeignKeyClause;
	generated?: {
		expr: Expression;
		stored: boolean;          // STORED or VIRTUAL
	};
}

// Table constraint (PRIMARY KEY, UNIQUE, etc.)
export interface TableConstraint {
	type: 'primaryKey' | 'unique' | 'check' | 'foreignKey';
	name?: string;
	columns?: string[];         // For PRIMARY KEY and UNIQUE
	expr?: Expression;         // For CHECK
	onConflict?: ConflictResolution;
	foreignKey?: ForeignKeyClause;
}

// Foreign key clause
export interface ForeignKeyClause {
	table: string;
	columns?: string[];
	onDelete?: ForeignKeyAction;
	onUpdate?: ForeignKeyAction;
	deferrable?: boolean;
	initiallyDeferred?: boolean;
}

// Foreign key action
export type ForeignKeyAction = 'setNull' | 'setDefault' | 'cascade' | 'restrict' | 'noAction';

// Column in index definition
export interface IndexedColumn {
	name?: string;  // Column name
	expr?: Expression;  // Or expression
	collation?: string;
	direction?: 'asc' | 'desc';
}

// Alter table action
export type AlterTableAction =
	| { type: 'renameTable', newName: string }
	| { type: 'renameColumn', oldName: string, newName: string }
	| { type: 'addColumn', column: ColumnDef }
	| { type: 'dropColumn', name: string };
