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
import type * as AST from '../parser/ast.js';
import { ConflictResolution } from '../common/constants.js';

// --- Identifier Quoting Logic ---

// Basic check for valid SQL identifiers (adjust regex as needed)
const isValidIdentifier = (name: string): boolean => {
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
};

// List of reserved keywords (might need updates for specific versions)
const reservedKeywords = new Set([
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
	if (reservedKeywords.has(name.toUpperCase()) || !isValidIdentifier(name)) {
		return `"${name.replace(/"/g, '""')}"`; // Escape internal quotes
	}
	return name;
}

// Helper to stringify expressions (very basic for defaults/checks)
export function expressionToString(expr: AST.Expression): string {
	switch (expr.type) {
		case 'literal':
			// Prefer original lexeme for numbers if available and different
			if ((typeof expr.value === 'number' || typeof expr.value === 'bigint') && expr.lexeme && expr.lexeme !== String(expr.value)) {
				return expr.lexeme;
			}
			// Otherwise, format based on type
			if (expr.value === null) return 'null';
			if (typeof expr.value === 'string') return `'${expr.value}'`; // Restore single quotes, no escaping
			if (typeof expr.value === 'number') return expr.value.toString();
			if (expr.value instanceof Uint8Array) {
				const hex = Buffer.from(expr.value).toString('hex');
				return `x'${hex}'`;
			}
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
			// Conditionally add parentheses for nested binary expressions
			let leftStr = expressionToString(expr.left);
			if (expr.left.type === 'binary') {
				leftStr = `(${leftStr})`;
			}
			let rightStr = expressionToString(expr.right);
			if (expr.right.type === 'binary') {
				rightStr = `(${rightStr})`;
			}
			return `${leftStr} ${expr.operator} ${rightStr}`;
		case 'unary':
			// Keep parentheses for unary operators
			return `${expr.operator} (${expressionToString(expr.expr)})`;
		case 'function':
			if (expr.name.toLowerCase() === 'count' && expr.args.length === 0) {
				return 'count(*)';
			}
			const argsStr = expr.args.map(arg => expressionToString(arg)).join(', ');
			return `${expr.name}(${argsStr})`;
		case 'cast':
			return `cast(${expressionToString(expr.expr)} as ${expr.targetType})`;
		// Add other expression types if needed (function, cast, etc.)
		default:
			return '?'; // Placeholder for complex expressions
	}
}

// Helper to stringify conflict clauses
function conflictToString(res: ConflictResolution | undefined): string {
	// ABORT is the default, so don't emit it
	if (!res || res === ConflictResolution.ABORT) return '';
	// Assuming ConflictResolution enum values are uppercase, convert them to lowercase
	return ` on conflict ${ConflictResolution[res].toLowerCase()}`;
}

// Helper to stringify column constraints
function columnConstraintsToString(constraints: AST.ColumnConstraint[]): string {
	return constraints.map(c => {
		let s = '';
		if (c.name) s += `constraint ${quoteIdentifierIfNeeded(c.name)} `;
		switch (c.type) {
			case 'primaryKey':
				s += 'primary key';
				// ASC is default, only specify DESC
				if (c.direction === 'desc') s += ` desc`;
				s += conflictToString(c.onConflict);
				if (c.autoincrement) s += ' autoincrement';
				break;
			case 'notNull':
				s += 'not null';
				s += conflictToString(c.onConflict);
				break;
			case 'unique':
				s += 'unique';
				s += conflictToString(c.onConflict);
				break;
			case 'check':
				s += `check (${expressionToString(c.expr!)})`;
				break;
			case 'default':
				s += `default ${expressionToString(c.expr!)}`;
				break;
			case 'collate':
				s += `collate ${c.collation}`;
				break;
			case 'foreignKey': // References clause needs more detail
				s += 'references ?'; // Placeholder
				break;
			case 'generated':
				s += `generated always as (${expressionToString(c.generated!.expr)})`;
				// VIRTUAL is default, only specify STORED
				if (c.generated!.stored) s += ' stored';
				break;
		}
		return s;
	}).filter(s => s.length > 0).join(' ');
}

// Helper to stringify table constraints
function tableConstraintsToString(constraints: AST.TableConstraint[]): string {
	return constraints.map(c => {
		let s = '';
		if (c.name) s += `constraint ${quoteIdentifierIfNeeded(c.name)} `;
		switch (c.type) {
			case 'primaryKey':
				// ASC is default, only specify DESC
				s += `primary key (${c.columns!.map(col => `${quoteIdentifierIfNeeded(col.name)}${col.direction === 'desc' ? ' desc' : ''}`).join(', ')})`;
				s += conflictToString(c.onConflict);
				break;
			case 'unique':
				s += `unique (${c.columns!.map(col => quoteIdentifierIfNeeded(col.name)).join(', ')})`;
				s += conflictToString(c.onConflict);
				break;
			case 'check':
				s += `check (${expressionToString(c.expr!)})`;
				break;
			case 'foreignKey':
				s += `foreign key (${c.columns!.map(col => quoteIdentifierIfNeeded(col.name)).join(', ')}) references ?`; // Placeholder
				break;
		}
		return s;
	}).filter(s => s.length > 0).join(', ');
}

export function createTableToString(stmt: AST.CreateTableStmt): string {
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
		const constraints = columnConstraintsToString(col.constraints);
		if (constraints) colDef += ` ${constraints}`;
		definitions.push(colDef);
	});

	const tableConstraints = tableConstraintsToString(stmt.constraints);
	if (tableConstraints) definitions.push(tableConstraints);

	parts.push(`(${definitions.join(', ')})`);

	if (stmt.withoutRowid) parts.push('without rowid');

	return parts.join(' ');
}
