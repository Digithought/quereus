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
import { KEYWORDS } from '../parser/lexer.js';

// --- Identifier Quoting Logic ---

// Basic check for valid SQL identifiers (adjust regex as needed)
const isValidIdentifier = (name: string): boolean => {
	return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
};

/**
 * Quotes an identifier (table, column, etc.) with double quotes if necessary.
 * Quoting is needed if the identifier:
 * - Is a reserved keyword (case-insensitive).
 * - Does not match the valid identifier pattern (starts with letter/_, contains letters/numbers/_).
 */
function quoteIdentifierIfNeeded(name: string): string {
	if (Object.hasOwn(KEYWORDS, name.toLowerCase()) || !isValidIdentifier(name)) {
		return `"${name.replace(/"/g, '""')}"`; // Escape internal quotes
	}
	return name;
}

// Main function to convert any AST node to SQL string
export function astToString(node: AST.AstNode): string {
	switch (node.type) {
		// Expression types
		case 'literal':
		case 'identifier':
		case 'column':
		case 'binary':
		case 'unary':
		case 'function':
		case 'cast':
		case 'parameter':
		case 'subquery':
		case 'collate':
		case 'case':
		case 'windowFunction':
			return expressionToString(node as AST.Expression);

		// Statement types
		case 'select':
			return selectToString(node as AST.SelectStmt);
		case 'insert':
			return insertToString(node as AST.InsertStmt);
		case 'update':
			return updateToString(node as AST.UpdateStmt);
		case 'delete':
			return deleteToString(node as AST.DeleteStmt);
		case 'createTable':
			return createTableToString(node as AST.CreateTableStmt);
		case 'createIndex':
			return createIndexToString(node as AST.CreateIndexStmt);
		case 'createView':
			return createViewToString(node as AST.CreateViewStmt);
		case 'drop':
			return dropToString(node as AST.DropStmt);
		case 'begin':
			return beginToString(node as AST.BeginStmt);
		case 'commit':
			return 'commit';
		case 'rollback':
			return rollbackToString(node as AST.RollbackStmt);
		case 'savepoint':
			return savepointToString(node as AST.SavepointStmt);
		case 'release':
			return releaseToString(node as AST.ReleaseStmt);
		case 'pragma':
			return pragmaToString(node as AST.PragmaStmt);

		default:
			return `[${node.type}]`; // Fallback for unknown node types
	}
}

// Helper to stringify expressions (extended from original)
export function expressionToString(expr: AST.Expression): string {
	switch (expr.type) {
		case 'literal':
			// Prefer original lexeme for numbers if available and different
			if ((typeof expr.value === 'number' || typeof expr.value === 'bigint') && expr.lexeme && expr.lexeme !== String(expr.value)) {
				return expr.lexeme;
			}
			// Prefer original lexeme for NULL if available
			if (expr.value === null) return expr.lexeme || 'null';
			if (typeof expr.value === 'string') return `'${expr.value.replace(/'/g, "''")}'`; // Escape single quotes
			if (typeof expr.value === 'number') return expr.value.toString();
			if (expr.value instanceof Uint8Array) {
				const hex = Buffer.from(expr.value).toString('hex');
				return `x'${hex}'`;
			}
			return String(expr.value);

		case 'identifier':
			let identStr = quoteIdentifierIfNeeded(expr.name);
			if (expr.schema) {
				identStr = `${quoteIdentifierIfNeeded(expr.schema)}.${identStr}`;
			}
			return identStr;

		case 'column':
			let colStr = quoteIdentifierIfNeeded(expr.name);
			if (expr.table) {
				colStr = `${quoteIdentifierIfNeeded(expr.table)}.${colStr}`;
				if (expr.schema) {
					colStr = `${quoteIdentifierIfNeeded(expr.schema)}.${colStr}`;
				}
			}
			return colStr;

		case 'binary':
			const leftStr = needsParens(expr.left, expr.operator, 'left')
				? `(${expressionToString(expr.left)})`
				: expressionToString(expr.left);
			const rightStr = needsParens(expr.right, expr.operator, 'right')
				? `(${expressionToString(expr.right)})`
				: expressionToString(expr.right);
			return `${leftStr} ${expr.operator} ${rightStr}`;

		case 'unary':
			const exprStr = expr.expr.type === 'binary'
				? `(${expressionToString(expr.expr)})`
				: expressionToString(expr.expr);
			// Handle postfix operators like IS NULL, IS NOT NULL
			if (expr.operator === 'IS NULL' || expr.operator === 'IS NOT NULL') {
				return `${exprStr} ${expr.operator}`;
			}
			return `${expr.operator} ${exprStr}`;

		case 'function':
			if (expr.name.toLowerCase() === 'count' && expr.args.length === 0) {
				return 'count(*)';
			}
			const argsStr = expr.args.map(arg => expressionToString(arg)).join(', ');
			return `${expr.name}(${argsStr})`;

		case 'cast':
			return `cast(${expressionToString(expr.expr)} as ${expr.targetType})`;

		case 'parameter':
			if (expr.index !== undefined) {
				return '?';
			} else if (expr.name) {
				return expr.name.startsWith(':') || expr.name.startsWith('$')
					? expr.name
					: `:${expr.name}`;
			}
			return '?';

		case 'subquery':
			return `(${selectToString(expr.query)})`;

		case 'collate':
			return `${expressionToString(expr.expr)} collate ${expr.collation}`;

		case 'case':
			// TODO: preserve and emit with original case
			let caseStr = 'CASE';
			if (expr.baseExpr) {
				caseStr += ` ${expressionToString(expr.baseExpr)}`;
			}
			for (const clause of expr.whenThenClauses) {
				caseStr += ` WHEN ${expressionToString(clause.when)} THEN ${expressionToString(clause.then)}`;
			}
			if (expr.elseExpr) {
				caseStr += ` ELSE ${expressionToString(expr.elseExpr)}`;
			}
			caseStr += ' END';
			return caseStr;

		case 'windowFunction':
			let winStr = expressionToString(expr.function);
			if (expr.window) {
				winStr += ` over (${windowDefinitionToString(expr.window)})`;
			}
			return winStr;

		default:
			return '[unknown_expr]';
	}
}

// Helper to determine if parentheses are needed for binary operations
function needsParens(expr: AST.Expression, parentOp: string, side: 'left' | 'right'): boolean {
	if (expr.type !== 'binary') return false;

	const precedence: Record<string, number> = {
		'OR': 1, 'AND': 2, 'NOT': 3, '=': 4, '!=': 4, '<': 4, '<=': 4, '>': 4, '>=': 4,
		'LIKE': 4, 'IN': 4, 'IS': 4, '+': 5, '-': 5, '*': 6, '/': 6, '%': 6
	};

	const parentPrec = precedence[parentOp.toUpperCase()] || 0;
	const childPrec = precedence[expr.operator.toUpperCase()] || 0;

	if (childPrec < parentPrec) return true;
	if (childPrec === parentPrec && side === 'right' && !isAssociative(parentOp)) return true;

	return false;
}

function isAssociative(op: string): boolean {
	const associativeOps = ['AND', 'OR', '+', '*'];
	return associativeOps.includes(op.toUpperCase());
}

// Helper for window definitions
function windowDefinitionToString(win: AST.WindowDefinition): string {
	const parts: string[] = [];

	if (win.partitionBy && win.partitionBy.length > 0) {
		parts.push(`partition by ${win.partitionBy.map(expressionToString).join(', ')}`);
	}

	if (win.orderBy && win.orderBy.length > 0) {
		const orderParts = win.orderBy.map(clause => {
			let orderStr = expressionToString(clause.expr);
			if (clause.direction === 'desc') orderStr += ' desc';
			if (clause.nulls) orderStr += ` nulls ${clause.nulls}`;
			return orderStr;
		});
		parts.push(`order by ${orderParts.join(', ')}`);
	}

	if (win.frame) {
		parts.push(windowFrameToString(win.frame));
	}

	return parts.join(' ');
}

function windowFrameToString(frame: AST.WindowFrame): string {
	let frameStr = frame.type; // 'rows' or 'range'

	if (frame.end) {
		frameStr += ` between ${windowFrameBoundToString(frame.start)} and ${windowFrameBoundToString(frame.end)}`;
	} else {
		frameStr += ` ${windowFrameBoundToString(frame.start)}`;
	}

	if (frame.exclusion) {
		frameStr += ` exclude ${frame.exclusion}`;
	}

	return frameStr;
}

function windowFrameBoundToString(bound: AST.WindowFrameBound): string {
	switch (bound.type) {
		case 'currentRow': return 'current row';
		case 'unboundedPreceding': return 'unbounded preceding';
		case 'unboundedFollowing': return 'unbounded following';
		case 'preceding': return `${expressionToString(bound.value)} preceding`;
		case 'following': return `${expressionToString(bound.value)} following`;
		default: return '[unknown_bound]';
	}
}

// Statement stringify functions
export function selectToString(stmt: AST.SelectStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	parts.push('select');

	if (stmt.distinct) parts.push('distinct');
	if (stmt.all) parts.push('all');

	const columns = stmt.columns.map(col => {
		if (col.type === 'all') {
			return col.table ? `${quoteIdentifierIfNeeded(col.table)}.*` : '*';
		} else {
			let colStr = expressionToString(col.expr);
			if (col.alias) colStr += ` as ${quoteIdentifierIfNeeded(col.alias)}`;
			return colStr;
		}
	});
	parts.push(columns.join(', '));

	if (stmt.from && stmt.from.length > 0) {
		parts.push('from', stmt.from.map(fromClauseToString).join(', '));
	}

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	if (stmt.groupBy && stmt.groupBy.length > 0) {
		parts.push('group by', stmt.groupBy.map(expressionToString).join(', '));
	}

	if (stmt.having) {
		parts.push('having', expressionToString(stmt.having));
	}

	if (stmt.orderBy && stmt.orderBy.length > 0) {
		const orderParts = stmt.orderBy.map(clause => {
			let orderStr = expressionToString(clause.expr);
			if (clause.direction === 'desc') orderStr += ' desc';
			if (clause.nulls) orderStr += ` nulls ${clause.nulls}`;
			return orderStr;
		});
		parts.push('order by', orderParts.join(', '));
	}

	if (stmt.limit) {
		parts.push('limit', expressionToString(stmt.limit));
	}

	if (stmt.offset) {
		parts.push('offset', expressionToString(stmt.offset));
	}

	let result = parts.join(' ');

	if (stmt.union) {
		result += stmt.unionAll ? ' union all ' : ' union ';
		result += selectToString(stmt.union);
	}

	return result;
}

function withClauseToString(withClause: AST.WithClause): string {
	let result = 'with';
	if (withClause.recursive) result += ' recursive';

	const ctes = withClause.ctes.map(cte => {
		let cteStr = quoteIdentifierIfNeeded(cte.name);
		if (cte.columns && cte.columns.length > 0) {
			cteStr += ` (${cte.columns.map(quoteIdentifierIfNeeded).join(', ')})`;
		}
		cteStr += ` as (${astToString(cte.query)})`;
		return cteStr;
	});

	result += ` ${ctes.join(', ')}`;
	return result;
}

function fromClauseToString(from: AST.FromClause): string {
	switch (from.type) {
		case 'table':
			let tableStr = quoteIdentifierIfNeeded(from.table.name);
			if (from.table.schema) {
				tableStr = `${quoteIdentifierIfNeeded(from.table.schema)}.${tableStr}`;
			}
			if (from.alias) tableStr += ` as ${quoteIdentifierIfNeeded(from.alias)}`;
			return tableStr;

		case 'subquerySource':
			return `(${selectToString(from.subquery)}) as ${quoteIdentifierIfNeeded(from.alias)}`;

		case 'functionSource':
			const args = from.args.map(expressionToString).join(', ');
			let funcStr = `${expressionToString(from.name)}(${args})`;
			if (from.alias) funcStr += ` as ${quoteIdentifierIfNeeded(from.alias)}`;
			return funcStr;

		case 'join':
			const leftStr = fromClauseToString(from.left);
			const rightStr = fromClauseToString(from.right);
			let joinStr = `${leftStr} ${from.joinType} join ${rightStr}`;
			if (from.condition) {
				joinStr += ` on ${expressionToString(from.condition)}`;
			} else if (from.columns) {
				joinStr += ` using (${from.columns.map(quoteIdentifierIfNeeded).join(', ')})`;
			}
			return joinStr;

		default:
			return '[unknown_from]';
	}
}

export function insertToString(stmt: AST.InsertStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	parts.push('insert into', expressionToString(stmt.table));

	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifierIfNeeded).join(', ')})`);
	}

	if (stmt.values) {
		const valueRows = stmt.values.map(row =>
			`(${row.map(expressionToString).join(', ')})`
		);
		parts.push('values', valueRows.join(', '));
	} else if (stmt.select) {
		parts.push(selectToString(stmt.select));
	}

	if (stmt.onConflict && stmt.onConflict !== ConflictResolution.ABORT) {
		parts.push(`on conflict ${ConflictResolution[stmt.onConflict].toLowerCase()}`);
	}

	if (stmt.returning && stmt.returning.length > 0) {
		const returning = stmt.returning.map(col => {
			if (col.type === 'all') {
				return col.table ? `${quoteIdentifierIfNeeded(col.table)}.*` : '*';
			} else {
				let colStr = expressionToString(col.expr);
				if (col.alias) colStr += ` as ${quoteIdentifierIfNeeded(col.alias)}`;
				return colStr;
			}
		});
		parts.push('returning', returning.join(', '));
	}

	return parts.join(' ');
}

export function updateToString(stmt: AST.UpdateStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	parts.push('update', expressionToString(stmt.table), 'set');

	const assignments = stmt.assignments.map(assign =>
		`${quoteIdentifierIfNeeded(assign.column)} = ${expressionToString(assign.value)}`
	);
	parts.push(assignments.join(', '));

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	if (stmt.onConflict && stmt.onConflict !== ConflictResolution.ABORT) {
		parts.push(`on conflict ${ConflictResolution[stmt.onConflict].toLowerCase()}`);
	}

	if (stmt.returning && stmt.returning.length > 0) {
		const returning = stmt.returning.map(col => {
			if (col.type === 'all') {
				return col.table ? `${quoteIdentifierIfNeeded(col.table)}.*` : '*';
			} else {
				let colStr = expressionToString(col.expr);
				if (col.alias) colStr += ` as ${quoteIdentifierIfNeeded(col.alias)}`;
				return colStr;
			}
		});
		parts.push('returning', returning.join(', '));
	}

	return parts.join(' ');
}

export function deleteToString(stmt: AST.DeleteStmt): string {
	const parts: string[] = [];

	if (stmt.withClause) {
		parts.push(withClauseToString(stmt.withClause));
	}

	parts.push('delete from', expressionToString(stmt.table));

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	if (stmt.returning && stmt.returning.length > 0) {
		const returning = stmt.returning.map(col => {
			if (col.type === 'all') {
				return col.table ? `${quoteIdentifierIfNeeded(col.table)}.*` : '*';
			} else {
				let colStr = expressionToString(col.expr);
				if (col.alias) colStr += ` as ${quoteIdentifierIfNeeded(col.alias)}`;
				return colStr;
			}
		});
		parts.push('returning', returning.join(', '));
	}

	return parts.join(' ');
}

function createIndexToString(stmt: AST.CreateIndexStmt): string {
	const parts: string[] = ['create'];
	if (stmt.isUnique) parts.push('unique');
	parts.push('index');
	if (stmt.ifNotExists) parts.push('if not exists');

	parts.push(expressionToString(stmt.index), 'on', expressionToString(stmt.table));

	const columns = stmt.columns.map(col => {
		if (col.name) {
			let colStr = quoteIdentifierIfNeeded(col.name);
			if (col.collation) colStr += ` collate ${col.collation}`;
			if (col.direction === 'desc') colStr += ' desc';
			return colStr;
		} else if (col.expr) {
			return expressionToString(col.expr);
		}
		return '';
	}).filter(s => s);

	parts.push(`(${columns.join(', ')})`);

	if (stmt.where) {
		parts.push('where', expressionToString(stmt.where));
	}

	return parts.join(' ');
}

function createViewToString(stmt: AST.CreateViewStmt): string {
	const parts: string[] = ['create'];
	if (stmt.isTemporary) parts.push('temp');
	parts.push('view');
	if (stmt.ifNotExists) parts.push('if not exists');

	parts.push(expressionToString(stmt.view));

	if (stmt.columns && stmt.columns.length > 0) {
		parts.push(`(${stmt.columns.map(quoteIdentifierIfNeeded).join(', ')})`);
	}

	parts.push('as', selectToString(stmt.select));

	return parts.join(' ');
}

function dropToString(stmt: AST.DropStmt): string {
	const parts: string[] = ['drop', stmt.objectType];
	if (stmt.ifExists) parts.push('if exists');
	parts.push(expressionToString(stmt.name));
	return parts.join(' ');
}

function beginToString(stmt: AST.BeginStmt): string {
	let result = 'begin';
	if (stmt.mode && stmt.mode !== 'deferred') {
		result += ` ${stmt.mode}`;
	}
	result += ' transaction';
	return result;
}

function rollbackToString(stmt: AST.RollbackStmt): string {
	let result = 'rollback';
	if (stmt.savepoint) {
		result += ` to ${stmt.savepoint}`;
	}
	return result;
}

function savepointToString(stmt: AST.SavepointStmt): string {
	return `savepoint ${stmt.name}`;
}

function releaseToString(stmt: AST.ReleaseStmt): string {
	let result = 'release';
	if (stmt.savepoint) {
		result += ` ${stmt.savepoint}`;
	}
	return result;
}

function pragmaToString(stmt: AST.PragmaStmt): string {
	let result = `pragma ${stmt.name}`;
	if (stmt.value) {
		result += ` = ${expressionToString(stmt.value)}`;
	}
	return result;
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

	if (stmt.moduleName) {
		parts.push('using', stmt.moduleName);
		if (stmt.moduleArgs && Object.keys(stmt.moduleArgs).length > 0) {
			const args = Object.entries(stmt.moduleArgs).map(([key, value]) =>
				`${quoteIdentifierIfNeeded(key)} = ${JSON.stringify(value)}`
			).join(', ');
			parts.push(`(${args})`);
		}
	}

	return parts.join(' ');
}
