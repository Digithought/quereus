/**
 * Functions to convert DDL AST nodes back into SQL strings.
 *
 * Formatting Notes:
 * - Emits lowercase SQL keywords.
 * - Quotes identifiers (table/column names) using double quotes.
 * - String literals are escaped.
 * - Omits clauses that represent the default SQLite behavior:
 *   - `ON CONFLICT ABORT`
 *   - `ASC` direction for primary keys
 *   - `VIRTUAL` storage for generated columns
 *   - (TODO: `FOREIGN KEY` default actions and deferrability)
 */
import type * as AST from '../parser/ast';
import { ConflictResolution } from '../common/constants';

// --- Identifier Quoting Logic ---

// Basic check for valid SQL identifiers (adjust regex as needed)
const isValidIdentifier = (name: string): boolean => {
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
};

// List of SQLite reserved keywords (might need updates for specific versions)
const sqliteReservedKeywords = new Set([
	'ABORT', 'ACTION', 'ADD', 'AFTER', 'ALL', 'ALTER', 'ANALYZE', 'AND', 'AS', 'ASC', 'ATTACH', 'AUTOINCREMENT',
	'BEFORE', 'BEGIN', 'BETWEEN', 'BY', 'CASCADE', 'CASE', 'CAST', 'CHECK', 'COLLATE', 'COLUMN', 'COMMIT', 'CONFLICT',
	'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP', 'DATABASE', 'DEFAULT',
	'DEFERRABLE', 'DEFERRED', 'DELETE', 'DESC', 'DETACH', 'DISTINCT', 'DROP', 'EACH', 'ELSE', 'END', 'ESCAPE', 'EXCEPT',
	'EXCLUSIVE', 'EXISTS', 'EXPLAIN', 'FAIL', 'FOR', 'FOREIGN', 'FROM', 'FULL', 'GLOB', 'GROUP', 'HAVING', 'IF',
	'IGNORE', 'IMMEDIATE', 'IN', 'INDEX', 'INDEXED', 'INITIALLY', 'INNER', 'INSERT', 'INSTEAD', 'INTERSECT', 'INTO',
	'IS', 'ISNULL', 'JOIN', 'KEY', 'LEFT', 'LIKE', 'LIMIT', 'MATCH', 'NATURAL', 'NO', 'NOT', 'NOTNULL', 'NULL',
	'OF', 'OFFSET', 'ON', 'OR', 'ORDER', 'OUTER', 'PLAN', 'PRAGMA', 'PRIMARY', 'QUERY', 'RAISE', 'RECURSIVE', 'REFERENCES',
	'REGEXP', 'REINDEX', 'RELEASE', 'RENAME', 'REPLACE', 'RESTRICT', 'RIGHT', 'ROLLBACK', 'ROW', 'SAVEPOINT', 'SELECT',
	'SET', 'TABLE', 'TEMP', 'TEMPORARY', 'THEN', 'TO', 'TRANSACTION', 'TRIGGER', 'UNION', 'UNIQUE', 'UPDATE', 'USING',
	'VACUUM', 'VALUES', 'VIEW', 'VIRTUAL', 'WHEN', 'WHERE', 'WITH', 'WITHOUT'
].map(k => k.toUpperCase())); // Store uppercase for case-insensitive check

/**
 * Quotes an identifier (table, column, etc.) with double quotes if necessary.
 * Quoting is needed if the identifier:
 * - Is a reserved keyword (case-insensitive).
 * - Does not match the valid identifier pattern (starts with letter/_, contains letters/numbers/_).
 */
function quoteIdentifierIfNeeded(name: string): string {
	if (sqliteReservedKeywords.has(name.toUpperCase()) || !isValidIdentifier(name)) {
		return `"${name.replace(/"/g, '""')}"`; // Escape internal quotes
	}
	return name;
}

// Helper to stringify expressions (very basic for defaults/checks)
function stringifyExpression(expr: AST.Expression): string {
	switch (expr.type) {
		case 'literal':
			if (expr.value === null) return 'null';
			if (typeof expr.value === 'string') return `'${expr.value.replace(/'/g, "''")}'`; // Basic quoting for strings
			return String(expr.value);
		case 'identifier': // General identifiers (e.g., in expressions, could be functions etc.)
			// Assuming these usually don't need quoting unless they are keywords/invalid
			return quoteIdentifierIfNeeded(expr.name);
		case 'column': // Column references
			let colStr = quoteIdentifierIfNeeded(expr.name);
			if (expr.table) {
				colStr = `${quoteIdentifierIfNeeded(expr.table)}.${colStr}`;
				if (expr.schema) {
					colStr = `${quoteIdentifierIfNeeded(expr.schema)}.${colStr}`;
				}
			}
			return colStr;
		case 'binary':
			return `(${stringifyExpression(expr.left)} ${expr.operator} ${stringifyExpression(expr.right)})`;
		case 'unary':
			return `${expr.operator} (${stringifyExpression(expr.expr)})`;
		// Add other expression types if needed (function, cast, etc.)
		default:
			return '?'; // Placeholder for complex expressions
	}
}

// Helper to stringify conflict clauses
function stringifyConflict(res: ConflictResolution | undefined): string {
	// ABORT is the default, so don't emit it
	if (!res || res === ConflictResolution.ABORT) return '';
	// Assuming ConflictResolution enum values are uppercase, convert them to lowercase
	return ` on conflict ${ConflictResolution[res].toLowerCase()}`;
}

// Helper to stringify column constraints
function stringifyColumnConstraints(constraints: AST.ColumnConstraint[]): string {
	return constraints.map(c => {
		let s = '';
		if (c.name) s += `constraint ${quoteIdentifierIfNeeded(c.name)} `;
		switch (c.type) {
			case 'primaryKey':
				s += 'primary key';
				// ASC is default, only specify DESC
				if (c.direction === 'desc') s += ` desc`;
				s += stringifyConflict(c.onConflict);
				if (c.autoincrement) s += ' autoincrement';
				break;
			case 'notNull':
				s += 'not null';
				s += stringifyConflict(c.onConflict);
				break;
			case 'unique':
				s += 'unique';
				s += stringifyConflict(c.onConflict);
				break;
			case 'check':
				s += `check (${stringifyExpression(c.expr!)})`;
				break;
			case 'default':
				s += `default ${stringifyExpression(c.expr!)}`;
				break;
			case 'collate':
				s += `collate ${c.collation}`;
				break;
			case 'foreignKey': // References clause needs more detail
				s += 'references ?'; // Placeholder
				break;
			case 'generated':
				s += `generated always as (${stringifyExpression(c.generated!.expr)})`;
				// VIRTUAL is default, only specify STORED
				if (c.generated!.stored) s += ' stored';
				break;
		}
		return s;
	}).filter(s => s.length > 0).join(' ');
}

// Helper to stringify table constraints
function stringifyTableConstraints(constraints: AST.TableConstraint[]): string {
	return constraints.map(c => {
		let s = '';
		if (c.name) s += `constraint ${quoteIdentifierIfNeeded(c.name)} `;
		switch (c.type) {
			case 'primaryKey':
				// ASC is default, only specify DESC
				s += `primary key (${c.columns!.map(col => `${quoteIdentifierIfNeeded(col.name)}${col.direction === 'desc' ? ' desc' : ''}`).join(', ')})`;
				s += stringifyConflict(c.onConflict);
				break;
			case 'unique':
				s += `unique (${c.columns!.map(col => quoteIdentifierIfNeeded(col.name)).join(', ')})`;
				s += stringifyConflict(c.onConflict);
				break;
			case 'check':
				s += `check (${stringifyExpression(c.expr!)})`;
				break;
			case 'foreignKey':
				s += `foreign key (${c.columns!.map(col => quoteIdentifierIfNeeded(col.name)).join(', ')}) references ?`; // Placeholder
				break;
		}
		return s;
	}).filter(s => s.length > 0).join(', ');
}

export function stringifyCreateTable(stmt: AST.CreateTableStmt): string {
	const parts: string[] = ['create'];
	if (stmt.isTemporary) parts.push('temp');
	parts.push('table');
	if (stmt.ifNotExists) parts.push('if not exists');
	// Handle schema.table quoting
	const tableName = quoteIdentifierIfNeeded(stmt.table.name);
	const schemaName = stmt.table.schema ? quoteIdentifierIfNeeded(stmt.table.schema) : undefined;
	parts.push(schemaName ? `${schemaName}.${tableName}` : tableName);

	const definitions: string[] = [];
	stmt.columns.forEach(col => {
		let colDef = quoteIdentifierIfNeeded(col.name);
		if (col.dataType) colDef += ` ${col.dataType}`; // Keep data type casing as is
		const constraints = stringifyColumnConstraints(col.constraints);
		if (constraints) colDef += ` ${constraints}`;
		definitions.push(colDef);
	});

	const tableConstraints = stringifyTableConstraints(stmt.constraints);
	if (tableConstraints) definitions.push(tableConstraints);

	parts.push(`(${definitions.join(', ')})`);

	if (stmt.withoutRowid) parts.push('without rowid');

	return parts.join(' ');
}
