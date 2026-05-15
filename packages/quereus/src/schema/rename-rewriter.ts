import type * as AST from '../parser/ast.js';

/**
 * In-place AST rewriters used to propagate ALTER TABLE RENAME operations
 * into dependent objects (CHECK expressions, view SELECT bodies, etc.).
 *
 * Both walkers mutate the input AST and return whether any rewrite was
 * applied. Callers can use the returned flag to skip cloning when nothing
 * matched. Name comparisons are case-insensitive throughout to match the
 * Quereus catalog rules.
 */

interface ScopeFrame {
	/** Lowercase table names in scope without an alias (eligible for unqualified resolution). */
	unaliased: Set<string>;
	/** Lowercase alias → lowercase underlying table name. */
	aliasMap: Map<string, string>;
	/** Lowercase CTE names declared in this WITH that re-expose the renamed column. */
	ctesExposingRenamed: Set<string>;
}

const eq = (a: string | undefined, b: string | undefined): boolean =>
	(a ?? '').toLowerCase() === (b ?? '').toLowerCase();

const schemaMatches = (
	nodeSchema: string | undefined,
	defaultSchema: string,
): boolean => nodeSchema === undefined || eq(nodeSchema, defaultSchema);

// ──────────────────────────────────────────────────────────────────────
// Table rename
// ──────────────────────────────────────────────────────────────────────

export function renameTableInAst(
	node: AST.AstNode | undefined,
	oldName: string,
	newName: string,
	defaultSchemaName: string,
): boolean {
	if (!node) return false;
	const ctx = { changed: false };
	visitTableRename(node, oldName, newName, defaultSchemaName, ctx);
	return ctx.changed;
}

function visitTableRename(
	node: AST.AstNode | undefined,
	oldName: string,
	newName: string,
	defaultSchemaName: string,
	ctx: { changed: boolean },
): void {
	if (!node) return;

	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			stmt.withClause?.ctes.forEach(cte => visitTableRename(cte.query, oldName, newName, defaultSchemaName, ctx));
			(stmt.columns ?? []).forEach(c => {
				if (c.type === 'column') visitTableRename(c.expr, oldName, newName, defaultSchemaName, ctx);
			});
			(stmt.from ?? []).forEach(f => visitTableRename(f, oldName, newName, defaultSchemaName, ctx));
			visitTableRename(stmt.where, oldName, newName, defaultSchemaName, ctx);
			(stmt.groupBy ?? []).forEach(g => visitTableRename(g, oldName, newName, defaultSchemaName, ctx));
			visitTableRename(stmt.having, oldName, newName, defaultSchemaName, ctx);
			(stmt.orderBy ?? []).forEach(o => visitTableRename(o.expr, oldName, newName, defaultSchemaName, ctx));
			visitTableRename(stmt.limit, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(stmt.offset, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(stmt.union, oldName, newName, defaultSchemaName, ctx);
			if (stmt.compound) visitTableRename(stmt.compound.select, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'insert': {
			const stmt = node as AST.InsertStmt;
			stmt.withClause?.ctes.forEach(cte => visitTableRename(cte.query, oldName, newName, defaultSchemaName, ctx));
			rewriteIdentifierIfTable(stmt.table, oldName, newName, defaultSchemaName, ctx);
			(stmt.values ?? []).forEach(row => row.forEach(v => visitTableRename(v, oldName, newName, defaultSchemaName, ctx)));
			visitTableRename(stmt.select, oldName, newName, defaultSchemaName, ctx);
			(stmt.upsertClauses ?? []).forEach(uc => {
				(uc.assignments ?? []).forEach(a => visitTableRename(a.value, oldName, newName, defaultSchemaName, ctx));
				visitTableRename(uc.where, oldName, newName, defaultSchemaName, ctx);
			});
			(stmt.returning ?? []).forEach(r => {
				if (r.type === 'column') visitTableRename(r.expr, oldName, newName, defaultSchemaName, ctx);
			});
			(stmt.contextValues ?? []).forEach(cv => visitTableRename(cv.value, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'update': {
			const stmt = node as AST.UpdateStmt;
			stmt.withClause?.ctes.forEach(cte => visitTableRename(cte.query, oldName, newName, defaultSchemaName, ctx));
			rewriteIdentifierIfTable(stmt.table, oldName, newName, defaultSchemaName, ctx);
			stmt.assignments.forEach(a => visitTableRename(a.value, oldName, newName, defaultSchemaName, ctx));
			visitTableRename(stmt.where, oldName, newName, defaultSchemaName, ctx);
			(stmt.returning ?? []).forEach(r => {
				if (r.type === 'column') visitTableRename(r.expr, oldName, newName, defaultSchemaName, ctx);
			});
			(stmt.contextValues ?? []).forEach(cv => visitTableRename(cv.value, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'delete': {
			const stmt = node as AST.DeleteStmt;
			stmt.withClause?.ctes.forEach(cte => visitTableRename(cte.query, oldName, newName, defaultSchemaName, ctx));
			rewriteIdentifierIfTable(stmt.table, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(stmt.where, oldName, newName, defaultSchemaName, ctx);
			(stmt.returning ?? []).forEach(r => {
				if (r.type === 'column') visitTableRename(r.expr, oldName, newName, defaultSchemaName, ctx);
			});
			(stmt.contextValues ?? []).forEach(cv => visitTableRename(cv.value, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'values': {
			const stmt = node as AST.ValuesStmt;
			stmt.values.forEach(row => row.forEach(v => visitTableRename(v, oldName, newName, defaultSchemaName, ctx)));
			break;
		}
		case 'table': {
			const ts = node as AST.TableSource;
			if (eq(ts.table.name, oldName) && schemaMatches(ts.table.schema, defaultSchemaName)) {
				ts.table.name = newName;
				ctx.changed = true;
			}
			break;
		}
		case 'join': {
			const join = node as AST.JoinClause;
			visitTableRename(join.left, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(join.right, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(join.condition, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'functionSource': {
			const fs = node as AST.FunctionSource;
			fs.args.forEach(a => visitTableRename(a, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'subquerySource': {
			const ss = node as AST.SubquerySource;
			visitTableRename(ss.subquery, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'mutatingSubquerySource': {
			const ms = node as AST.MutatingSubquerySource;
			visitTableRename(ms.stmt, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'binary': {
			const e = node as AST.BinaryExpr;
			visitTableRename(e.left, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(e.right, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate': {
			visitTableRename((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'function': {
			(node as AST.FunctionExpr).args.forEach(a => visitTableRename(a, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'subquery': {
			visitTableRename((node as AST.SubqueryExpr).query, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'windowFunction': {
			const wf = node as AST.WindowFunctionExpr;
			visitTableRename(wf.function, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(wf.window, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'windowDefinition': {
			const wd = node as AST.WindowDefinition;
			(wd.partitionBy ?? []).forEach(p => visitTableRename(p, oldName, newName, defaultSchemaName, ctx));
			(wd.orderBy ?? []).forEach(o => visitTableRename(o.expr, oldName, newName, defaultSchemaName, ctx));
			break;
		}
		case 'case': {
			const ce = node as AST.CaseExpr;
			visitTableRename(ce.baseExpr, oldName, newName, defaultSchemaName, ctx);
			ce.whenThenClauses.forEach(wt => {
				visitTableRename(wt.when, oldName, newName, defaultSchemaName, ctx);
				visitTableRename(wt.then, oldName, newName, defaultSchemaName, ctx);
			});
			visitTableRename(ce.elseExpr, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'in': {
			const ie = node as AST.InExpr;
			visitTableRename(ie.expr, oldName, newName, defaultSchemaName, ctx);
			(ie.values ?? []).forEach(v => visitTableRename(v, oldName, newName, defaultSchemaName, ctx));
			visitTableRename(ie.subquery, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'exists': {
			visitTableRename((node as AST.ExistsExpr).subquery, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'between': {
			const be = node as AST.BetweenExpr;
			visitTableRename(be.expr, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(be.lower, oldName, newName, defaultSchemaName, ctx);
			visitTableRename(be.upper, oldName, newName, defaultSchemaName, ctx);
			break;
		}
		case 'column': {
			const col = node as AST.ColumnExpr;
			if (col.table && eq(col.table, oldName) && schemaMatches(col.schema, defaultSchemaName)) {
				col.table = newName;
				ctx.changed = true;
			}
			break;
		}
		// Leaf nodes / DDL — nothing to recurse into for our purposes.
		default:
			break;
	}
}

function rewriteIdentifierIfTable(
	id: AST.IdentifierExpr | undefined,
	oldName: string,
	newName: string,
	defaultSchemaName: string,
	ctx: { changed: boolean },
): void {
	if (!id) return;
	if (eq(id.name, oldName) && schemaMatches(id.schema, defaultSchemaName)) {
		id.name = newName;
		ctx.changed = true;
	}
}

// ──────────────────────────────────────────────────────────────────────
// Column rename
// ──────────────────────────────────────────────────────────────────────

export function renameColumnInAst(
	node: AST.AstNode | undefined,
	tableName: string,
	oldColName: string,
	newColName: string,
	defaultSchemaName: string,
): boolean {
	if (!node) return false;
	const state: ColumnRewriteState = {
		tableName: tableName.toLowerCase(),
		oldCol: oldColName.toLowerCase(),
		newCol: newColName,
		defaultSchema: defaultSchemaName.toLowerCase(),
		scopeStack: [],
		changed: false,
	};
	visitColumnRename(node, state);
	return state.changed;
}

interface ColumnRewriteState {
	tableName: string;
	oldCol: string;
	newCol: string;
	defaultSchema: string;
	scopeStack: ScopeFrame[];
	changed: boolean;
}

function emptyFrame(): ScopeFrame {
	return { unaliased: new Set(), aliasMap: new Map(), ctesExposingRenamed: new Set() };
}

function buildScopeFrame(from: AST.FromClause[] | undefined, state: ColumnRewriteState): ScopeFrame {
	const frame = emptyFrame();
	if (!from) return frame;
	for (const item of from) {
		collectFromBindings(item, state, frame);
	}
	return frame;
}

function collectFromBindings(
	item: AST.FromClause,
	state: ColumnRewriteState,
	frame: ScopeFrame,
): void {
	switch (item.type) {
		case 'table': {
			const ts = item as AST.TableSource;
			const name = ts.table.name.toLowerCase();
			// Unqualified reference to an exposing CTE — bind as if it were the renamed table.
			if (ts.table.schema === undefined && isCteExposingInScope(state, name)) {
				if (ts.alias) {
					frame.aliasMap.set(ts.alias.toLowerCase(), state.tableName);
				} else {
					frame.unaliased.add(state.tableName);
					// The CTE name acts as an implicit qualifier for refs like "a.k".
					frame.aliasMap.set(name, state.tableName);
				}
				break;
			}
			const schemaLower = (ts.table.schema ?? state.defaultSchema).toLowerCase();
			if (ts.alias) {
				frame.aliasMap.set(ts.alias.toLowerCase(), name);
			} else if (schemaLower === state.defaultSchema || ts.table.schema === undefined) {
				frame.unaliased.add(name);
			}
			break;
		}
		case 'join': {
			const join = item as AST.JoinClause;
			collectFromBindings(join.left, state, frame);
			collectFromBindings(join.right, state, frame);
			break;
		}
		case 'subquerySource':
		case 'mutatingSubquerySource':
		case 'functionSource':
			// Aliased; these don't contribute the renamed underlying table for
			// unqualified resolution purposes.
			break;
	}
}

function isCteExposingInScope(state: ColumnRewriteState, name: string): boolean {
	for (const frame of state.scopeStack) {
		if (frame.ctesExposingRenamed.has(name)) return true;
	}
	return false;
}

function isTableInUnaliasedScope(state: ColumnRewriteState): boolean {
	for (const frame of state.scopeStack) {
		if (frame.unaliased.has(state.tableName)) return true;
	}
	return false;
}

function aliasResolvesToTable(state: ColumnRewriteState, alias: string): boolean {
	const aliasLower = alias.toLowerCase();
	for (const frame of state.scopeStack) {
		const target = frame.aliasMap.get(aliasLower);
		if (target !== undefined) return target === state.tableName;
	}
	return false;
}

function visitColumnRename(node: AST.AstNode | undefined, state: ColumnRewriteState): void {
	if (!node) return;

	switch (node.type) {
		case 'select': {
			const stmt = node as AST.SelectStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const frame = buildScopeFrame(stmt.from, state);
				state.scopeStack.push(frame);
				try {
					(stmt.columns ?? []).forEach(c => {
						if (c.type === 'column') visitColumnRename(c.expr, state);
					});
					(stmt.from ?? []).forEach(f => visitColumnRename(f, state));
					visitColumnRename(stmt.where, state);
					(stmt.groupBy ?? []).forEach(g => visitColumnRename(g, state));
					visitColumnRename(stmt.having, state);
					(stmt.orderBy ?? []).forEach(o => visitColumnRename(o.expr, state));
					visitColumnRename(stmt.limit, state);
					visitColumnRename(stmt.offset, state);
					visitColumnRename(stmt.union, state);
					if (stmt.compound) visitColumnRename(stmt.compound.select, state);
				} finally {
					state.scopeStack.pop();
				}
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'insert': {
			const stmt = node as AST.InsertStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const targetIsRenamed =
					eq(stmt.table.name, state.tableName) &&
					(stmt.table.schema === undefined || eq(stmt.table.schema, state.defaultSchema));
				if (targetIsRenamed && stmt.columns) {
					stmt.columns = stmt.columns.map(c => {
						if (c.toLowerCase() === state.oldCol) {
							state.changed = true;
							return state.newCol;
						}
						return c;
					});
				}
				if (targetIsRenamed) {
					(stmt.upsertClauses ?? []).forEach(uc => {
						if (uc.conflictTarget) {
							uc.conflictTarget = uc.conflictTarget.map(c => {
								if (c.toLowerCase() === state.oldCol) {
									state.changed = true;
									return state.newCol;
								}
								return c;
							});
						}
						if (uc.assignments) {
							for (const a of uc.assignments) {
								if (a.column.toLowerCase() === state.oldCol) {
									a.column = state.newCol;
									state.changed = true;
								}
							}
						}
					});
				}
				(stmt.values ?? []).forEach(row => row.forEach(v => visitColumnRename(v, state)));
				visitColumnRename(stmt.select, state);
				(stmt.upsertClauses ?? []).forEach(uc => {
					(uc.assignments ?? []).forEach(a => visitColumnRename(a.value, state));
					visitColumnRename(uc.where, state);
				});
				(stmt.returning ?? []).forEach(r => {
					if (r.type === 'column') visitColumnRename(r.expr, state);
				});
				(stmt.contextValues ?? []).forEach(cv => visitColumnRename(cv.value, state));
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'update': {
			const stmt = node as AST.UpdateStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const targetIsRenamed =
					eq(stmt.table.name, state.tableName) &&
					(stmt.table.schema === undefined || eq(stmt.table.schema, state.defaultSchema));
				if (targetIsRenamed) {
					for (const a of stmt.assignments) {
						if (a.column.toLowerCase() === state.oldCol) {
							a.column = state.newCol;
							state.changed = true;
						}
					}
				}
				// Push a scope frame so unqualified column refs in WHERE/RETURNING
				// resolve against the update target.
				const frame = emptyFrame();
				if (stmt.table.schema === undefined || eq(stmt.table.schema, state.defaultSchema)) {
					frame.unaliased.add(stmt.table.name.toLowerCase());
				}
				state.scopeStack.push(frame);
				try {
					stmt.assignments.forEach(a => visitColumnRename(a.value, state));
					visitColumnRename(stmt.where, state);
					(stmt.returning ?? []).forEach(r => {
						if (r.type === 'column') visitColumnRename(r.expr, state);
					});
					(stmt.contextValues ?? []).forEach(cv => visitColumnRename(cv.value, state));
				} finally {
					state.scopeStack.pop();
				}
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'delete': {
			const stmt = node as AST.DeleteStmt;
			pushWithFrame(stmt.withClause, state);
			try {
				const frame = emptyFrame();
				if (stmt.table.schema === undefined || eq(stmt.table.schema, state.defaultSchema)) {
					frame.unaliased.add(stmt.table.name.toLowerCase());
				}
				state.scopeStack.push(frame);
				try {
					visitColumnRename(stmt.where, state);
					(stmt.returning ?? []).forEach(r => {
						if (r.type === 'column') visitColumnRename(r.expr, state);
					});
					(stmt.contextValues ?? []).forEach(cv => visitColumnRename(cv.value, state));
				} finally {
					state.scopeStack.pop();
				}
			} finally {
				state.scopeStack.pop();
			}
			break;
		}
		case 'values': {
			const stmt = node as AST.ValuesStmt;
			stmt.values.forEach(row => row.forEach(v => visitColumnRename(v, state)));
			break;
		}
		case 'join': {
			const join = node as AST.JoinClause;
			visitColumnRename(join.left, state);
			visitColumnRename(join.right, state);
			visitColumnRename(join.condition, state);
			break;
		}
		case 'functionSource': {
			(node as AST.FunctionSource).args.forEach(a => visitColumnRename(a, state));
			break;
		}
		case 'subquerySource': {
			visitColumnRename((node as AST.SubquerySource).subquery, state);
			break;
		}
		case 'mutatingSubquerySource': {
			visitColumnRename((node as AST.MutatingSubquerySource).stmt, state);
			break;
		}
		case 'binary': {
			const e = node as AST.BinaryExpr;
			visitColumnRename(e.left, state);
			visitColumnRename(e.right, state);
			break;
		}
		case 'unary':
		case 'cast':
		case 'collate':
			visitColumnRename((node as AST.UnaryExpr | AST.CastExpr | AST.CollateExpr).expr, state);
			break;
		case 'function':
			(node as AST.FunctionExpr).args.forEach(a => visitColumnRename(a, state));
			break;
		case 'subquery':
			visitColumnRename((node as AST.SubqueryExpr).query, state);
			break;
		case 'windowFunction': {
			const wf = node as AST.WindowFunctionExpr;
			visitColumnRename(wf.function, state);
			visitColumnRename(wf.window, state);
			break;
		}
		case 'windowDefinition': {
			const wd = node as AST.WindowDefinition;
			(wd.partitionBy ?? []).forEach(p => visitColumnRename(p, state));
			(wd.orderBy ?? []).forEach(o => visitColumnRename(o.expr, state));
			break;
		}
		case 'case': {
			const ce = node as AST.CaseExpr;
			visitColumnRename(ce.baseExpr, state);
			ce.whenThenClauses.forEach(wt => {
				visitColumnRename(wt.when, state);
				visitColumnRename(wt.then, state);
			});
			visitColumnRename(ce.elseExpr, state);
			break;
		}
		case 'in': {
			const ie = node as AST.InExpr;
			visitColumnRename(ie.expr, state);
			(ie.values ?? []).forEach(v => visitColumnRename(v, state));
			visitColumnRename(ie.subquery, state);
			break;
		}
		case 'exists':
			visitColumnRename((node as AST.ExistsExpr).subquery, state);
			break;
		case 'between': {
			const be = node as AST.BetweenExpr;
			visitColumnRename(be.expr, state);
			visitColumnRename(be.lower, state);
			visitColumnRename(be.upper, state);
			break;
		}
		case 'column': {
			const col = node as AST.ColumnExpr;
			if (col.name.toLowerCase() !== state.oldCol) break;
			if (col.table) {
				const qualifierLower = col.table.toLowerCase();
				const directHit = qualifierLower === state.tableName &&
					(col.schema === undefined || eq(col.schema, state.defaultSchema));
				const viaAlias = aliasResolvesToTable(state, col.table);
				if (directHit || viaAlias) {
					col.name = state.newCol;
					state.changed = true;
				}
			} else {
				if (isTableInUnaliasedScope(state)) {
					col.name = state.newCol;
					state.changed = true;
				}
			}
			break;
		}
		case 'table':
			// Table sources don't contain column names.
			break;
		default:
			break;
	}
}

/**
 * Push a with-frame that registers any CTEs in the given WITH clause that
 * re-expose the renamed column. CTEs are visited in declaration order so
 * later CTEs see earlier ones in the same WITH.
 *
 * Caller is responsible for popping the frame via `state.scopeStack.pop()`.
 */
function pushWithFrame(
	withClause: AST.WithClause | undefined,
	state: ColumnRewriteState,
): ScopeFrame {
	const frame = emptyFrame();
	state.scopeStack.push(frame);
	if (withClause) {
		for (const cte of withClause.ctes) {
			visitColumnRename(cte.query, state);
			if (cteExposesRenamedColumn(cte, state)) {
				frame.ctesExposingRenamed.add(cte.name.toLowerCase());
			}
		}
	}
	return frame;
}

/**
 * Rebuild a with-frame's `ctesExposingRenamed` set for exposure analysis
 * without re-visiting CTE bodies (they were already visited).
 */
function analyzeWithFrame(
	withClause: AST.WithClause | undefined,
	state: ColumnRewriteState,
): ScopeFrame {
	const frame = emptyFrame();
	if (!withClause) return frame;
	state.scopeStack.push(frame);
	try {
		for (const cte of withClause.ctes) {
			if (cteExposesRenamedColumn(cte, state)) {
				frame.ctesExposingRenamed.add(cte.name.toLowerCase());
			}
		}
	} finally {
		state.scopeStack.pop();
	}
	return frame;
}

/**
 * Determine whether a CTE re-exposes the renamed column under name `state.newCol`
 * (the column has already been rewritten inside its body if the body referenced it).
 *
 * Returns false when:
 * - The CTE has an explicit column list (renaming the input to fixed names).
 * - The body is not a SELECT (INSERT/UPDATE/DELETE WITH RETURNING — out of scope).
 * - No passthrough result column references the renamed table's column.
 */
function cteExposesRenamedColumn(
	cte: AST.CommonTableExpr,
	state: ColumnRewriteState,
): boolean {
	if (cte.columns) return false;
	const query = cte.query;
	if (query.type !== 'select') return false;
	const select = query as AST.SelectStmt;

	// Recreate the body's own with-frame so nested CTE refs in `select.from`
	// resolve correctly during exposure analysis.
	const bodyWithFrame = analyzeWithFrame(select.withClause, state);
	state.scopeStack.push(bodyWithFrame);
	try {
		const bodyFrame = buildScopeFrame(select.from, state);
		for (const col of select.columns ?? []) {
			if (isResultColumnExposure(col, bodyFrame, state)) return true;
		}
		return false;
	} finally {
		state.scopeStack.pop();
	}
}

function isResultColumnExposure(
	col: AST.ResultColumn,
	bodyFrame: ScopeFrame,
	state: ColumnRewriteState,
): boolean {
	if (col.type === 'all') {
		if (col.table === undefined) {
			return bodyFrame.unaliased.has(state.tableName);
		}
		const qualLower = col.table.toLowerCase();
		if (qualLower === state.tableName && bodyFrame.unaliased.has(state.tableName)) return true;
		return bodyFrame.aliasMap.get(qualLower) === state.tableName;
	}
	if (col.alias !== undefined) return false;
	const expr = col.expr;
	if (expr.type !== 'column') return false;
	const colExpr = expr as AST.ColumnExpr;
	if (colExpr.name.toLowerCase() !== state.newCol.toLowerCase()) return false;
	if (colExpr.table === undefined) {
		return bodyFrame.unaliased.has(state.tableName);
	}
	const qualLower = colExpr.table.toLowerCase();
	if (
		qualLower === state.tableName &&
		(colExpr.schema === undefined || eq(colExpr.schema, state.defaultSchema))
	) {
		return true;
	}
	return bodyFrame.aliasMap.get(qualLower) === state.tableName;
}
