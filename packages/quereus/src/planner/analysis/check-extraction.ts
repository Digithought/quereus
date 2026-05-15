/**
 * Extract FDs, equivalence classes, constant bindings, and column-domain bounds
 * from declared CHECK constraints. The recognized AST shapes are syntactic and
 * decompose across `AND` conjunctions; disjunctions, NOT, subqueries, and any
 * call to a function the supplied `isDeterministic` predicate rejects are
 * conservatively skipped.
 *
 * See ticket `1-optimizer-check-derived-fds-and-domains` for the recognized
 * shape table; consumers wire the result into a TableReferenceNode's physical
 * properties via `fd-utils` helpers.
 */

import type { ConstantBinding, DomainConstraint, FunctionalDependency } from '../nodes/plan-node.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import type * as AST from '../../parser/ast.js';
import type { SqlValue } from '../../common/types.js';

export interface CheckExtraction {
	readonly fds: ReadonlyArray<FunctionalDependency>;
	readonly equivPairs: ReadonlyArray<readonly [number, number]>;
	readonly constantBindings: ReadonlyArray<ConstantBinding>;
	readonly domainConstraints: ReadonlyArray<DomainConstraint>;
}

/**
 * Walk each CHECK constraint and emit FD/EC/binding/domain contributions.
 * `columnIndexMap` is the table's name → index map (lowercase keys).
 * `isDeterministic` returns true when the named function with `argc` arguments
 * is registered as deterministic. Constraints invoking any non-deterministic
 * function are skipped wholesale.
 */
/**
 * Cached schema-keyed view: schema validation already rejects non-deterministic
 * functions in CHECK expressions, so we use `() => true` here. Replaced when
 * the schema manager swaps the schema instance (ALTER TABLE), since the cache
 * is keyed by reference.
 */
const cache = new WeakMap<TableSchema, CheckExtraction>();

const allDeterministic = (): boolean => true;

export function getCheckExtraction(tableSchema: TableSchema): CheckExtraction {
	let cached = cache.get(tableSchema);
	if (!cached) {
		cached = extractCheckConstraints(
			tableSchema.checkConstraints,
			tableSchema.columnIndexMap,
			allDeterministic,
		);
		cache.set(tableSchema, cached);
	}
	return cached;
}

export function extractCheckConstraints(
	checks: ReadonlyArray<RowConstraintSchema>,
	columnIndexMap: ReadonlyMap<string, number>,
	isDeterministic: (fnName: string, argc: number) => boolean,
): CheckExtraction {
	const fds: FunctionalDependency[] = [];
	const equivPairs: Array<readonly [number, number]> = [];
	const constantBindings: ConstantBinding[] = [];
	const domainConstraints: DomainConstraint[] = [];

	for (const check of checks) {
		if (!check.expr) continue;
		if (containsNonDeterministicCall(check.expr, isDeterministic)) continue;
		walkConjunction(check.expr, columnIndexMap, fds, equivPairs, constantBindings, domainConstraints);
	}

	return { fds, equivPairs, constantBindings, domainConstraints };
}

function walkConjunction(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	fds: FunctionalDependency[],
	equivPairs: Array<readonly [number, number]>,
	constantBindings: ConstantBinding[],
	domainConstraints: DomainConstraint[],
): void {
	const stack: AST.Expression[] = [expr];
	while (stack.length > 0) {
		const cur = stack.pop()!;
		if (cur.type === 'binary' && (cur as AST.BinaryExpr).operator === 'AND') {
			const b = cur as AST.BinaryExpr;
			stack.push(b.left, b.right);
			continue;
		}
		recognize(cur, columnIndexMap, fds, equivPairs, constantBindings, domainConstraints);
	}
}

function recognize(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	fds: FunctionalDependency[],
	equivPairs: Array<readonly [number, number]>,
	constantBindings: ConstantBinding[],
	domainConstraints: DomainConstraint[],
): void {
	if (expr.type === 'binary') {
		const b = expr as AST.BinaryExpr;
		switch (b.operator) {
			case '=':
			case '==': {
				handleEquality(b.left, b.right, columnIndexMap, fds, equivPairs, constantBindings);
				return;
			}
			case '<':
			case '<=':
			case '>':
			case '>=': {
				handleInequality(b, columnIndexMap, domainConstraints);
				return;
			}
			default:
				return;
		}
	}
	if (expr.type === 'between') {
		const bt = expr as AST.BetweenExpr;
		if (bt.not) return;
		const colIdx = columnIndexFromExpr(bt.expr, columnIndexMap);
		if (colIdx === undefined) return;
		const lo = literalValue(bt.lower);
		const hi = literalValue(bt.upper);
		if (lo === undefined || hi === undefined) return;
		domainConstraints.push({
			kind: 'range',
			column: colIdx,
			min: lo,
			max: hi,
			minInclusive: true,
			maxInclusive: true,
		});
		return;
	}
	if (expr.type === 'in') {
		const inExpr = expr as AST.InExpr;
		if (!inExpr.values || inExpr.subquery) return;
		const colIdx = columnIndexFromExpr(inExpr.expr, columnIndexMap);
		if (colIdx === undefined) return;
		const values: SqlValue[] = [];
		for (const v of inExpr.values) {
			const lit = literalValue(v);
			if (lit === undefined) return;
			values.push(lit);
		}
		if (values.length === 0) return;
		domainConstraints.push({ kind: 'enum', column: colIdx, values });
		return;
	}
}

function handleEquality(
	left: AST.Expression,
	right: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
	fds: FunctionalDependency[],
	equivPairs: Array<readonly [number, number]>,
	constantBindings: ConstantBinding[],
): void {
	const lIdx = columnIndexFromExpr(left, columnIndexMap);
	const rIdx = columnIndexFromExpr(right, columnIndexMap);

	if (lIdx !== undefined && rIdx !== undefined) {
		if (lIdx === rIdx) return;
		fds.push({ determinants: [lIdx], dependents: [rIdx] });
		fds.push({ determinants: [rIdx], dependents: [lIdx] });
		equivPairs.push([lIdx, rIdx]);
		return;
	}

	if (lIdx !== undefined) {
		const lit = literalValue(right);
		if (lit !== undefined) {
			fds.push({ determinants: [], dependents: [lIdx] });
			constantBindings.push({ attrs: [lIdx], value: { kind: 'literal', value: lit } });
			return;
		}
		const cols = collectColumnNames(right, columnIndexMap);
		if (cols.size === 1) {
			const [singleCol] = cols;
			if (singleCol !== lIdx) {
				fds.push({ determinants: [singleCol], dependents: [lIdx] });
			}
		}
		return;
	}

	if (rIdx !== undefined) {
		const lit = literalValue(left);
		if (lit !== undefined) {
			fds.push({ determinants: [], dependents: [rIdx] });
			constantBindings.push({ attrs: [rIdx], value: { kind: 'literal', value: lit } });
			return;
		}
		const cols = collectColumnNames(left, columnIndexMap);
		if (cols.size === 1) {
			const [singleCol] = cols;
			if (singleCol !== rIdx) {
				fds.push({ determinants: [singleCol], dependents: [rIdx] });
			}
		}
	}
}

function handleInequality(
	b: AST.BinaryExpr,
	columnIndexMap: ReadonlyMap<string, number>,
	domainConstraints: DomainConstraint[],
): void {
	// Normalize so the column is on the left.
	const lIdx = columnIndexFromExpr(b.left, columnIndexMap);
	const rIdx = columnIndexFromExpr(b.right, columnIndexMap);

	let colIdx: number | undefined;
	let lit: SqlValue | undefined;
	let op: string;

	if (lIdx !== undefined) {
		lit = literalValue(b.right);
		colIdx = lIdx;
		op = b.operator;
	} else if (rIdx !== undefined) {
		lit = literalValue(b.left);
		colIdx = rIdx;
		op = flipComparison(b.operator);
	} else {
		return;
	}

	if (lit === undefined || colIdx === undefined) return;

	switch (op) {
		case '>=':
			domainConstraints.push({ kind: 'range', column: colIdx, min: lit, minInclusive: true, maxInclusive: false });
			return;
		case '>':
			domainConstraints.push({ kind: 'range', column: colIdx, min: lit, minInclusive: false, maxInclusive: false });
			return;
		case '<=':
			domainConstraints.push({ kind: 'range', column: colIdx, max: lit, minInclusive: false, maxInclusive: true });
			return;
		case '<':
			domainConstraints.push({ kind: 'range', column: colIdx, max: lit, minInclusive: false, maxInclusive: false });
			return;
	}
}

function flipComparison(op: string): string {
	switch (op) {
		case '<': return '>';
		case '<=': return '>=';
		case '>': return '<';
		case '>=': return '<=';
		default: return op;
	}
}

function columnIndexFromExpr(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
): number | undefined {
	if (expr.type === 'column') {
		const ref = expr as AST.ColumnExpr;
		return columnIndexMap.get(ref.name.toLowerCase());
	}
	if (expr.type === 'identifier') {
		const ref = expr as AST.IdentifierExpr;
		if (ref.schema) return undefined;
		return columnIndexMap.get(ref.name.toLowerCase());
	}
	return undefined;
}

/**
 * Return the literal `SqlValue` for an `AST.LiteralExpr`, or undefined for any
 * other expression shape (functions, casts, casts-of-literals, etc.). Only
 * compile-time literals count for binding/domain purposes.
 */
function literalValue(expr: AST.Expression): SqlValue | undefined {
	if (expr.type !== 'literal') return undefined;
	const lit = expr as AST.LiteralExpr;
	const v = lit.value;
	if (v instanceof Promise) return undefined;
	return v;
}

/**
 * Collect the set of column indices referenced by `expr`. Only column /
 * identifier nodes naming columns in `columnIndexMap` count. Returns an empty
 * set when the expression references zero recognized columns; the caller can
 * distinguish "no columns" (constant expression) from "exactly one column"
 * by inspecting the size.
 */
function collectColumnNames(
	expr: AST.Expression,
	columnIndexMap: ReadonlyMap<string, number>,
): Set<number> {
	const out = new Set<number>();
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		const idx = node.type === 'column' || node.type === 'identifier'
			? columnIndexFromExpr(node as AST.Expression, columnIndexMap)
			: undefined;
		if (idx !== undefined) out.add(idx);
		// Walk all sub-expression-shaped properties.
		for (const key of Object.keys(node)) {
			const v = (node as unknown as Record<string, unknown>)[key];
			if (!v) continue;
			if (Array.isArray(v)) {
				for (const item of v) {
					if (item && typeof item === 'object' && 'type' in item) {
						stack.push(item as AST.AstNode);
					}
				}
			} else if (typeof v === 'object' && 'type' in (v as object)) {
				stack.push(v as AST.AstNode);
			}
		}
	}
	return out;
}

/**
 * True when `expr` calls any function for which `isDeterministic(name, argc)`
 * returns false, or contains a subquery. Used to skip whole CHECK expressions
 * that we cannot reason about safely.
 */
function containsNonDeterministicCall(
	expr: AST.Expression,
	isDeterministic: (fnName: string, argc: number) => boolean,
): boolean {
	const stack: AST.AstNode[] = [expr as AST.AstNode];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === 'subquery' || node.type === 'exists') return true;
		if (node.type === 'function') {
			const fn = node as AST.FunctionExpr;
			const argc = fn.args?.length ?? 0;
			if (!isDeterministic(fn.name, argc)) return true;
		}
		for (const key of Object.keys(node)) {
			const v = (node as unknown as Record<string, unknown>)[key];
			if (!v) continue;
			if (Array.isArray(v)) {
				for (const item of v) {
					if (item && typeof item === 'object' && 'type' in item) {
						stack.push(item as AST.AstNode);
					}
				}
			} else if (typeof v === 'object' && 'type' in (v as object)) {
				stack.push(v as AST.AstNode);
			}
		}
	}
	return false;
}
