/**
 * Functional dependency (FD) and equivalence-class (EC) helpers used by
 * `computePhysical` on relational plan nodes. See `docs/optimizer.md`
 * section "Functional Dependency Tracking" for the propagation table and
 * design rationale.
 */

import { createLogger } from '../../common/logger.js';
import type { FunctionalDependency, ScalarPlanNode } from '../nodes/plan-node.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../nodes/reference.js';
import { BinaryOpNode, LiteralNode } from '../nodes/scalar.js';

const log = createLogger('planner:fd');

/**
 * Per-node cap on the number of FDs we materialize. The propagation rules
 * are conservative enough that hitting this in practice is rare; the cap
 * is a safety valve for pathological plans.
 */
export const MAX_FDS_PER_NODE = 64;

/**
 * Closure of `attrs` under `fds`. Iterative fixed-point.
 *
 * O(|fds| × growth) — terminates when no new attribute is added in a pass.
 */
export function computeClosure(
	attrs: ReadonlySet<number>,
	fds: ReadonlyArray<FunctionalDependency>,
): Set<number> {
	const closure = new Set<number>(attrs);
	let changed = true;
	while (changed) {
		changed = false;
		for (const fd of fds) {
			if (fd.determinants.every(d => closure.has(d))) {
				for (const dep of fd.dependents) {
					if (!closure.has(dep)) {
						closure.add(dep);
						changed = true;
					}
				}
			}
		}
	}
	return closure;
}

/** True iff `attrs` determines every attribute in `target` under `fds`. */
export function determines(
	attrs: ReadonlySet<number>,
	target: ReadonlySet<number>,
	fds: ReadonlyArray<FunctionalDependency>,
): boolean {
	if (target.size === 0) return true;
	const closure = computeClosure(attrs, fds);
	for (const t of target) {
		if (!closure.has(t)) return false;
	}
	return true;
}

/**
 * Smallest subset of `attrs` whose closure equals the closure of `attrs`.
 * Greedy minimization: try dropping each attribute; keep the drop iff the
 * resulting closure is unchanged. O(|attrs|² × |fds|).
 */
export function minimalCover(
	attrs: ReadonlySet<number>,
	fds: ReadonlyArray<FunctionalDependency>,
): Set<number> {
	const fullClosure = computeClosure(attrs, fds);
	const result = new Set<number>(attrs);
	for (const a of [...result]) {
		const trial = new Set<number>(result);
		trial.delete(a);
		const trialClosure = computeClosure(trial, fds);
		if (trialClosure.size === fullClosure.size) {
			let same = true;
			for (const x of fullClosure) {
				if (!trialClosure.has(x)) { same = false; break; }
			}
			if (same) result.delete(a);
		}
	}
	return result;
}

function fdsEqual(a: FunctionalDependency, b: FunctionalDependency): boolean {
	if (a.determinants.length !== b.determinants.length) return false;
	if (a.dependents.length !== b.dependents.length) return false;
	const aDet = new Set(a.determinants);
	for (const d of b.determinants) if (!aDet.has(d)) return false;
	const aDep = new Set(a.dependents);
	for (const d of b.dependents) if (!aDep.has(d)) return false;
	return true;
}

function determinantsEqual(a: readonly number[], b: readonly number[]): boolean {
	if (a.length !== b.length) return false;
	const aSet = new Set(a);
	for (const x of b) if (!aSet.has(x)) return false;
	return true;
}

function dependentsSubset(sub: readonly number[], sup: readonly number[]): boolean {
	const supSet = new Set(sup);
	for (const x of sub) if (!supSet.has(x)) return false;
	return true;
}

export interface AddFdOptions {
	uniqueKeys?: ReadonlyArray<ReadonlyArray<number>>;
	cap?: number;
}

/**
 * Add a single FD, dropping any existing entry with the same determinants
 * whose dependents are a subset of the new one (subsumption). When the
 * resulting list exceeds the cap, drop FDs whose determinants are not a
 * subset of any `uniqueKeys` entry on the same node.
 */
export function addFd(
	fds: ReadonlyArray<FunctionalDependency>,
	next: FunctionalDependency,
	opts: AddFdOptions = {},
): FunctionalDependency[] {
	if (next.dependents.length === 0) return fds.slice();

	const result: FunctionalDependency[] = [];
	let subsumedByExisting = false;
	for (const existing of fds) {
		if (fdsEqual(existing, next)) {
			subsumedByExisting = true;
			result.push(existing);
			continue;
		}
		if (determinantsEqual(existing.determinants, next.determinants)) {
			// Same determinants: keep whichever has the larger dependent set.
			if (dependentsSubset(existing.dependents, next.dependents)) {
				// existing ⊂ next, drop existing
				continue;
			}
			if (dependentsSubset(next.dependents, existing.dependents)) {
				subsumedByExisting = true;
			}
		}
		result.push(existing);
	}
	if (!subsumedByExisting) result.push(next);

	return enforceCap(result, opts);
}

function enforceCap(
	fds: FunctionalDependency[],
	opts: AddFdOptions,
): FunctionalDependency[] {
	const cap = opts.cap ?? MAX_FDS_PER_NODE;
	if (fds.length <= cap) return fds;

	const uniqueKeys = opts.uniqueKeys ?? [];
	const keySet = uniqueKeys.map(k => new Set(k));

	const isSubsetOfAnyKey = (det: readonly number[]): boolean => {
		if (keySet.length === 0) return false;
		return keySet.some(ks => det.every(d => ks.has(d)));
	};

	const preferred = fds.filter(fd => isSubsetOfAnyKey(fd.determinants));
	const other = fds.filter(fd => !isSubsetOfAnyKey(fd.determinants));

	let kept: FunctionalDependency[];
	if (preferred.length >= cap) {
		kept = preferred.slice(0, cap);
	} else {
		kept = preferred.concat(other.slice(0, cap - preferred.length));
	}

	log('FD cap reached: dropped %d FD(s) from %d', fds.length - kept.length, fds.length);
	return kept;
}

/** Merge two FD lists, applying subsumption via `addFd`. */
export function mergeFds(
	a: ReadonlyArray<FunctionalDependency>,
	b: ReadonlyArray<FunctionalDependency>,
	opts: AddFdOptions = {},
): FunctionalDependency[] {
	let result: FunctionalDependency[] = a.slice();
	for (const fd of b) {
		result = addFd(result, fd, opts);
	}
	return result;
}

/**
 * Project FDs through a column mapping (oldCol → newCol). FDs whose
 * determinants OR dependents lose any column are dropped.
 */
export function projectFds(
	fds: ReadonlyArray<FunctionalDependency>,
	mapping: ReadonlyMap<number, number>,
): FunctionalDependency[] {
	const result: FunctionalDependency[] = [];
	for (const fd of fds) {
		const newDet: number[] = [];
		let miss = false;
		for (const d of fd.determinants) {
			const m = mapping.get(d);
			if (m === undefined) { miss = true; break; }
			newDet.push(m);
		}
		if (miss) continue;

		const newDep: number[] = [];
		for (const d of fd.dependents) {
			const m = mapping.get(d);
			if (m === undefined) { miss = true; break; }
			newDep.push(m);
		}
		if (miss) continue;

		if (newDep.length === 0) continue;
		result.push({ determinants: newDet, dependents: newDep });
	}
	return result;
}

/** Shift all column indices in `fds` by `offset`. */
export function shiftFds(
	fds: ReadonlyArray<FunctionalDependency>,
	offset: number,
): FunctionalDependency[] {
	if (offset === 0) return fds.slice();
	return fds.map(fd => ({
		determinants: fd.determinants.map(d => d + offset),
		dependents: fd.dependents.map(d => d + offset),
	}));
}

/** Shift all column indices in `classes` by `offset`. */
export function shiftEquivClasses(
	classes: ReadonlyArray<ReadonlyArray<number>>,
	offset: number,
): number[][] {
	if (offset === 0) return classes.map(c => c.slice());
	return classes.map(c => c.map(x => x + offset));
}

function normalizeClass(cls: ReadonlyArray<number>): number[] {
	const dedup = Array.from(new Set(cls));
	dedup.sort((a, b) => a - b);
	return dedup;
}

/**
 * Merge two equivalence-class sets, taking the transitive closure of
 * overlapping classes (union-find style).
 */
export function mergeEquivClasses(
	a: ReadonlyArray<ReadonlyArray<number>>,
	b: ReadonlyArray<ReadonlyArray<number>>,
): number[][] {
	const classes: number[][] = [...a, ...b].map(c => normalizeClass(c));

	let merged = true;
	while (merged) {
		merged = false;
		outer:
		for (let i = 0; i < classes.length; i++) {
			const ci = classes[i];
			const ciSet = new Set(ci);
			for (let j = i + 1; j < classes.length; j++) {
				const cj = classes[j];
				let overlap = false;
				for (const x of cj) {
					if (ciSet.has(x)) { overlap = true; break; }
				}
				if (overlap) {
					classes[i] = normalizeClass([...ci, ...cj]);
					classes.splice(j, 1);
					merged = true;
					break outer;
				}
			}
		}
	}

	return classes.filter(c => c.length >= 2);
}

/** Add a new equality `a ≡ b` to an existing class list. */
export function addEquivalence(
	classes: ReadonlyArray<ReadonlyArray<number>>,
	a: number,
	b: number,
): number[][] {
	if (a === b) return classes.map(c => c.slice());
	return mergeEquivClasses(classes, [[a, b]]);
}

/**
 * Build an FD `key → {0..columnCount-1} \ key` from a superkey. Useful
 * when consumers want a unified FD view that also includes the all-columns
 * implication of `uniqueKeys`.
 */
export function superkeyToFd(
	key: readonly number[],
	columnCount: number,
): FunctionalDependency {
	const keySet = new Set(key);
	const dependents: number[] = [];
	for (let i = 0; i < columnCount; i++) {
		if (!keySet.has(i)) dependents.push(i);
	}
	return { determinants: key.slice(), dependents };
}

/**
 * Extracted FD/EC contributions from an equality-shaped predicate.
 *
 * - `fds`: FDs of the form `∅ → col` (column constant under the predicate)
 *   or `col1 → col2` / `col2 → col1` (mutual determination from `col1 = col2`).
 * - `equivPairs`: `[col1, col2]` pairs to be merged into the EC list.
 */
export interface EqualityFds {
	readonly fds: ReadonlyArray<FunctionalDependency>;
	readonly equivPairs: ReadonlyArray<readonly [number, number]>;
}

/**
 * Walk `predicate` (assumed to be a normalized conjunction) and extract FDs
 * and equivalence-class contributions from equality conjuncts.
 *
 * `attrIdToIndex` maps an attribute ID to its column index in the predicate's
 * relation. Equality conjuncts referencing attributes outside this map
 * (correlated subqueries, etc.) are silently ignored.
 *
 * Recognized shapes (per AND-conjunct):
 *   - `col = const`  ⇒ FD `∅ → col`.
 *   - `col1 = col2`  ⇒ FDs `{col1} → {col2}` and `{col2} → {col1}` plus an
 *     equivalence pair `[col1, col2]`.
 *
 * Non-equality conjuncts contribute nothing.
 */
export function extractEqualityFds(
	predicate: ScalarPlanNode,
	attrIdToIndex: ReadonlyMap<number, number>,
): EqualityFds {
	const fds: FunctionalDependency[] = [];
	const equivPairs: Array<readonly [number, number]> = [];

	const stack: ScalarPlanNode[] = [predicate];
	while (stack.length > 0) {
		const n = stack.pop()!;
		if (!(n instanceof BinaryOpNode)) continue;
		const op = n.expression.operator;
		if (op === 'AND') {
			stack.push(n.left, n.right);
			continue;
		}
		if (op !== '=') continue;

		const lIsCol = n.left instanceof ColumnReferenceNode;
		const rIsCol = n.right instanceof ColumnReferenceNode;
		const lIsConst = isPredicateConstant(n.left);
		const rIsConst = isPredicateConstant(n.right);

		if (lIsCol && rIsCol) {
			const lIdx = attrIdToIndex.get((n.left as ColumnReferenceNode).attributeId);
			const rIdx = attrIdToIndex.get((n.right as ColumnReferenceNode).attributeId);
			if (lIdx !== undefined && rIdx !== undefined && lIdx !== rIdx) {
				fds.push({ determinants: [lIdx], dependents: [rIdx] });
				fds.push({ determinants: [rIdx], dependents: [lIdx] });
				equivPairs.push([lIdx, rIdx]);
			}
			continue;
		}

		if (lIsCol && rIsConst) {
			const lIdx = attrIdToIndex.get((n.left as ColumnReferenceNode).attributeId);
			if (lIdx !== undefined) {
				fds.push({ determinants: [], dependents: [lIdx] });
			}
			continue;
		}

		if (rIsCol && lIsConst) {
			const rIdx = attrIdToIndex.get((n.right as ColumnReferenceNode).attributeId);
			if (rIdx !== undefined) {
				fds.push({ determinants: [], dependents: [rIdx] });
			}
			continue;
		}
	}

	return { fds, equivPairs };
}

/**
 * A scalar expression treated as a "constant" relative to a filter's input
 * stream: a `LiteralNode`. Parameters are intentionally excluded because
 * `extractEqualityFds` is consumed by `computePhysical`, which describes
 * properties true for every row of a single execution — parameters are
 * fixed per execution but we do not model that here. This matches the
 * conservative rule in the ticket spec ("literal must be a constant
 * ScalarPlanNode, no parameters/subqueries").
 */
function isPredicateConstant(n: ScalarPlanNode): boolean {
	if (n instanceof LiteralNode) return true;
	// Parameters are excluded by design (see comment above). Listing the
	// negative case explicitly keeps the intent obvious to a reader.
	if (n instanceof ParameterReferenceNode) return false;
	return false;
}
