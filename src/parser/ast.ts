import type { SqlValue } from '../common/types.js';
import type { ConflictResolution } from '../common/constants.js';

/**
 * SQL Abstract Syntax Tree (AST) definitions
 * These interfaces define the structure of parsed SQL statements
 */

// Base for all AST nodes
export interface AstNode {
	type: 'literal' | 'identifier' | 'column' | 'binary' | 'unary' | 'function' | 'cast' | 'parameter' | 'subquery' | 'select'
		| 'insert' | 'update' | 'delete' | 'createTable' | 'createIndex' | 'createView' | 'alterTable' | 'drop' | 'begin' | 'commit'
		| 'rollback' | 'table' | 'join' | 'savepoint' | 'release' | 'functionSource' | 'withClause' | 'commonTableExpr' | 'pragma'
		| 'collate' | 'primaryKey' | 'notNull' | 'unique' | 'check' | 'default' | 'foreignKey' | 'generated' | 'windowFunction'
		| 'windowDefinition' | 'windowFrame' | 'currentRow' | 'unboundedPreceding' | 'unboundedFollowing' | 'preceding' | 'following'
		| 'subquerySource';
	loc?: {
		start: { line: number, column: number, offset: number };
		end: { line: number, column: number, offset: number };
	};
}

// Expression types
export type Expression = LiteralExpr | IdentifierExpr | BinaryExpr | UnaryExpr | FunctionExpr | CastExpr
	| ParameterExpr | SubqueryExpr | ColumnExpr | FunctionSource | CollateExpr | WindowFunctionExpr;

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

// Window function expression
export interface WindowFunctionExpr extends AstNode {
	type: 'windowFunction';
	function: FunctionExpr;
	window?: WindowDefinition;
	alias?: string;
}

// Window definition (OVER clause)
export interface WindowDefinition extends AstNode {
	type: 'windowDefinition';
	partitionBy?: Expression[];
	orderBy?: OrderByClause[];
	frame?: WindowFrame;
}

// Window frame clause
export interface WindowFrame {
	type: WindowFrameUnits; // Changed from 'windowFrame' to WindowFrameUnits
	start: WindowFrameBound;
	end: WindowFrameBound | null; // Can be just START bound
	exclusion?: WindowFrameExclusion;
}

// Window frame bound
export type WindowFrameBound =
	| { type: 'currentRow' }
	| { type: 'unboundedPreceding' }
	| { type: 'unboundedFollowing' }
	| { type: 'preceding', value: Expression }
	| { type: 'following', value: Expression };

// Window frame units
export type WindowFrameUnits = 'rows' | 'range';

// Window frame exclusion
export type WindowFrameExclusion = 'no others' | 'current row' | 'group' | 'ties';

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

// --- Add FunctionSource type ---
export interface FunctionSource extends AstNode {
	type: 'functionSource';
	name: IdentifierExpr; // Function name (potentially schema.name)
	args: Expression[];    // Arguments passed to the function
	alias?: string;        // Optional alias for the generated table
}

// SELECT statement
export interface SelectStmt extends AstNode {
	type: 'select';
	withClause?: WithClause;
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
	withClause?: WithClause;
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
	withClause?: WithClause;
	table: IdentifierExpr;
	assignments: { column: string; value: Expression }[];
	where?: Expression;
	onConflict?: ConflictResolution;
	returning?: ResultColumn[];
}

// DELETE statement
export interface DeleteStmt extends AstNode {
	type: 'delete';
	withClause?: WithClause;
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
	moduleName?: string;   // Optional module name from USING clause
	moduleArgs?: string[]; // Optional module arguments from USING clause
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

// FROM clause item (table, join, function call, or subquery)
export type FromClause = TableSource | JoinClause | FunctionSource | SubquerySource;

// Table source in FROM clause
export interface TableSource extends AstNode {
	type: 'table';
	table: IdentifierExpr;
	alias?: string;
}

// --- Add SubquerySource type --- Needed before FromClause use
export interface SubquerySource extends AstNode {
	type: 'subquerySource'; // Distinct type for FROM clause subqueries
	subquery: SelectStmt;
	alias: string; // Subqueries in FROM MUST have an alias
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
export interface ColumnConstraint extends AstNode {
	type: 'primaryKey' | 'notNull' | 'unique' | 'check' | 'default' | 'foreignKey' | 'collate' | 'generated';
	name?: string;
	expr?: Expression;          // For CHECK or DEFAULT
	collation?: string;         // For COLLATE
	autoincrement?: boolean;    // For PRIMARY KEY AUTOINCREMENT
	direction?: 'asc' | 'desc'; // ADDED: For PRIMARY KEY ASC/DESC
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
	columns?: { name: string; direction?: 'asc' | 'desc' }[];
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

// Add PragmaStmt interface
export interface PragmaStmt extends AstNode {
	type: 'pragma';
	name: string; // Name of the pragma
	value?: LiteralExpr | IdentifierExpr; // Value being assigned (optional for some pragmas)
}

export interface WithClause extends AstNode {
	type: 'withClause';
	recursive: boolean;
	ctes: CommonTableExpr[];
}

export interface CommonTableExpr extends AstNode {
	type: 'commonTableExpr';
	name: string;
	columns?: string[];
	query: SelectStmt | InsertStmt | UpdateStmt | DeleteStmt; // CTE body
}

export interface CollateExpr extends AstNode {
	type: 'collate';
	expr: Expression;
	collation: string;
}

// --- Utility Type for Top-Level Statements ---
export type Statement =
	| SelectStmt
	| InsertStmt
	| UpdateStmt
	| DeleteStmt
	| CreateTableStmt
	| CreateIndexStmt
	| CreateViewStmt
	| DropStmt
	| AlterTableStmt
	| BeginStmt
	| CommitStmt
	| RollbackStmt
	| SavepointStmt
	| ReleaseStmt
	| PragmaStmt;
