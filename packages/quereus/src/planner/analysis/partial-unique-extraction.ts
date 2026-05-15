/**
 * Extract *guarded* FDs from partial UNIQUE constraints — those synthesized
 * from `CREATE UNIQUE INDEX (K) WHERE P`. Inside the partial scope `P`, the
 * columns `K` form a key, so `K → all_other_cols` holds; outside the scope
 * the FD does not hold. We encode this as a guarded FD whose guard is the
 * AND-conjunctive decomposition of `P` into clauses the FD-machinery can
 * activate (see `GuardClause` in plan-node.ts).
 *
 * `TableReferenceNode.computePhysical` calls this alongside CHECK-derived
 * FDs; Filter activation in `FilterNode` discharges the guard when a
 * surrounding predicate entails every clause.
 *
 * Soundness rule: every conjunct of `P` must map to a recognized clause. A
 * predicate with any unrecognized conjunct produces *no* FD — discharging on
 * a weaker partial predicate would falsely activate the FD for rows the
 * unrecognized conjunct excludes.
 *
 * NOT-NULL gate: every UC column must be effectively non-NULL inside the
 * partial scope. A column qualifies if either (a) it is declared NOT NULL on
 * the table, or (b) the partial predicate has a matching `col IS NOT NULL`
 * conjunct. Case (b) is sound because the FD only activates when a
 * surrounding predicate entails every guard clause, including that
 * `IS NOT NULL` clause — so discharge cannot falsely activate the FD over
 * rows where the UC column could be NULL. A nullable UC column whose
 * `IS NOT NULL` is not in the predicate would allow multiple NULLs inside
 * scope, so `K → others` would not hold; those are rejected. Mirrors the
 * relation-level rule in `relationTypeFromTableSchema` (type-utils.ts),
 * relaxed for partial scopes that establish non-nullness themselves.
 *
 * Out-of-scope shapes (filed as backlog tickets in the implement ticket):
 *   - range subsumption (`age >= 21` discharges `age >= 18`)
 *   - OR / IN / NOT discharge
 */

import type { FunctionalDependency, GuardClause, GuardPredicate } from '../nodes/plan-node.js';
import type { TableSchema } from '../../schema/table.js';
import type * as AST from '../../parser/ast.js';
import { columnIndexFromExpr, literalValue } from './predicate-shape.js';

const cache = new WeakMap<TableSchema, ReadonlyArray<FunctionalDependency>>();

export function getPartialUniqueGuardedFds(
	tableSchema: TableSchema,
): ReadonlyArray<FunctionalDependency> {
	let cached = cache.get(tableSchema);
	if (!cached) {
		cached = extractPartialUniqueGuardedFds(tableSchema);
		cache.set(tableSchema, cached);
	}
	return cached;
}

export function extractPartialUniqueGuardedFds(
	tableSchema: TableSchema,
): FunctionalDependency[] {
	const out: FunctionalDependency[] = [];
	const ucs = tableSchema.uniqueConstraints;
	if (!ucs) return out;

	const colCount = tableSchema.columns.length;

	for (const uc of ucs) {
		if (uc.predicate === undefined) continue;

		const clauses = recognizeGuardClauses(uc.predicate, tableSchema.columnIndexMap);
		if (!clauses) continue;
		if (clauses.length === 0) continue;

		// NOT-NULL gate: each UC column must be effectively non-NULL inside the
		// partial scope — either declared NOT NULL, or forced so by an
		// `IS NOT NULL` conjunct of the partial predicate (which is one of the
		// guard clauses, so discharge will require it).
		const nonNullByPredicate = new Set<number>();
		for (const c of clauses) {
			if (c.kind === 'is-null' && c.negated === true) nonNullByPredicate.add(c.column);
		}
		const allUcColumnsNonNullable = uc.columns.every(idx =>
			tableSchema.columns[idx]?.notNull === true || nonNullByPredicate.has(idx),
		);
		if (!allUcColumnsNonNullable) continue;

		const det = Array.from(uc.columns);
		const detSet = new Set(det);
		const dep: number[] = [];
		for (let i = 0; i < colCount; i++) {
			if (!detSet.has(i)) dep.push(i);
		}
		if (dep.length === 0) continue;

		const guard: GuardPredicate = { clauses };
		out.push({ determinants: det, dependents: dep, guard });
	}

	return out;
}

/**
 * Decompose a partial-index predicate into AND-conjunctive guard clauses.
 *
 * Returns `undefined` (NOT `[]`) if any conjunct fails to map to a recognized
 * `GuardClause` — the entire FD must be skipped in that case. Returns `[]`
 * only for trivially empty inputs (which the caller treats as "no FD").
 */
function recognizeGuardClauses(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
): GuardClause[] | undefined {
	const conjuncts: AST.Expression[] = [];
	const stack: AST.Expression[] = [expr];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (cur.type === 'binary' && (cur as AST.BinaryExpr).operator === 'AND') {
			const b = cur as AST.BinaryExpr;
			// Preserve textual order: push right then left so left is processed first.
			stack.push(b.right, b.left);
			continue;
		}
		conjuncts.push(cur);
	}

	const clauses: GuardClause[] = [];
	for (const conjunct of conjuncts) {
		const clause = recognizeClause(conjunct, columnIndexMap);
		if (!clause) return undefined;
		clauses.push(clause);
	}
	return clauses;
}

/**
 * Recognize one conjunct as a guard clause.
 *
 * Accepted shapes:
 *   col = literal      ⇒ eq-literal { column, value }
 *   literal = col      ⇒ eq-literal { column, value }     (normalized)
 *   col1 = col2        ⇒ eq-column  { left, right }
 *   col IS NULL        ⇒ is-null    { column, negated:false }
 *   col IS NOT NULL    ⇒ is-null    { column, negated:true }
 *
 * `=` and `==` are interchangeable. Anything else (`>`, `<>`, `IN`, function
 * calls, OR sub-trees, etc.) returns undefined — the whole predicate is then
 * dropped on the floor by the caller.
 */
function recognizeClause(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
): GuardClause | undefined {
	if (expr.type === 'unary') {
		const u = expr as AST.UnaryExpr;
		if (u.operator !== 'IS NULL' && u.operator !== 'IS NOT NULL') return undefined;
		const col = columnIndexFromExpr(u.expr, columnIndexMap);
		if (col === undefined) return undefined;
		return { kind: 'is-null', column: col, negated: u.operator === 'IS NOT NULL' };
	}
	if (expr.type !== 'binary') return undefined;
	const b = expr as AST.BinaryExpr;
	if (b.operator !== '=' && b.operator !== '==') return undefined;

	const lIdx = columnIndexFromExpr(b.left, columnIndexMap);
	const rIdx = columnIndexFromExpr(b.right, columnIndexMap);

	if (lIdx !== undefined && rIdx !== undefined) {
		if (lIdx === rIdx) return undefined;
		return { kind: 'eq-column', left: lIdx, right: rIdx };
	}
	if (lIdx !== undefined) {
		const lit = literalValue(b.right);
		if (lit === undefined) return undefined;
		return { kind: 'eq-literal', column: lIdx, value: lit };
	}
	if (rIdx !== undefined) {
		const lit = literalValue(b.left);
		if (lit === undefined) return undefined;
		return { kind: 'eq-literal', column: rIdx, value: lit };
	}
	return undefined;
}
