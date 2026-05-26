/**
 * Rule: Async Gather ZIP BY KEY
 *
 * Recognizes a `Project` over a chain of binary full-outer `JoinNode`s that
 * all equate the **same** key column set across every participating relation,
 * and folds the whole shape into a single N-ary
 * `AsyncGatherNode({ kind: 'zipByKey', branchKeyAttrs, outputKeyAttrs })`.
 *
 * Generalizes `rule-async-gather-union-all` from the `unionAll` combinator to
 * `zipByKey`. The recognized SQL is the natural spelling of an N-way
 * full-outer merge on a shared key:
 *
 *   select coalesce(a.k, b.k, c.k) as k, a.av, b.bv, c.cv
 *     from a full outer join b on a.k = b.k
 *            full outer join c on a.k = c.k
 *
 * which the builder produces as:
 *
 *   Project[ coalesce(a.k,b.k,c.k) as k, a.av, b.bv, c.cv ]
 *     Join(full, on a.k = c.k)
 *       Join(full, on a.k = b.k)
 *         <a>  <b>
 *       <c>
 *
 * The binary full-outer chain is O(N²) null-padding and infers worse FDs than
 * the symmetric N-ary merge; the `zipByKey` gather drives the N branches
 * concurrently and hash-merges them by key. (Binary FULL JOIN has no runtime
 * lowering at all — this rewrite is the only execution path for it.)
 *
 * ## Recognized shape (v1, deliberately strict)
 *
 *   1. A `ProjectNode` whose `source` is a `JoinNode(joinType='full')`.
 *   2. The full-join chain flattens (any nesting) into ≥ `minBranches` leaf
 *      branches. Each join's `ON` condition is a pure conjunction of
 *      column-ref equalities (no residual / non-equi predicate — those block).
 *   3. Those equalities partition the branches' key columns into K equivalence
 *      classes ("key positions"), and **every branch contributes exactly one
 *      column to every class** (the shared-key precondition). A branch missing
 *      from any class would be a cross-product, not a zip — block.
 *   4. The projection list is exactly, in this canonical order:
 *        - K `coalesce(...)` calls, one per key position, whose argument set is
 *          exactly that class's per-branch key attrs (defines key order); then
 *        - bare column references to every non-key column of branch 0, then
 *          branch 1, … in branch + column order.
 *      This canonical order is what the `zipByKey` emitter produces
 *      (`[K key cells][branch0 non-key][branch1 non-key]…`), so the gather can
 *      replace the `Project` outright. Any other projection order/shape is not
 *      recognized in v1 (documented limitation — a reordering Project on top is
 *      future work).
 *
 * ## Gates (mirror `rule-async-gather-union-all`)
 *
 *   - **Concurrency safety.** Every branch must declare
 *     `physical.concurrencySafe === true`.
 *   - **Uncorrelated branches.** No branch may reference attributes outside its
 *     own subtree (lateral dependency) — the parallel driver forks independent
 *     contexts. `isCorrelatedSubquery` on each branch must be false.
 *   - **Latency win.** The slowest branch's `physical.expectedLatencyMs` must
 *     meet `tuning.parallel.gatherThresholdMs`. This is 0 on memory-vtab /
 *     in-process leaves, so the rule is inert by design on local-only plans
 *     (the golden-plan no-rewrite invariant).
 *   - **Key collation agreement.** Every key column at a given key position must
 *     declare the *same* collation across all branches (binary or not). The
 *     runtime comparator derives from branch 0 only, so a disagreement would
 *     compare keys under the wrong collation. Non-binary collations are allowed:
 *     the emitter composes the merged key deterministically from the
 *     lowest-indexed present branch (`composeMergedKeyCells`), matching
 *     `coalesce`'s left-to-right pick even when collation-equal keys are
 *     byte-distinct (e.g. NOCASE merging `'A'`/`'a'`). This mirrors the
 *     *agreement* invariant `AsyncGatherNode.validateZipByKey` enforces (which
 *     throws on a true mismatch); checking it here declines gracefully instead.
 *
 * ## Attribute provenance (Option A — per-branch refs + minted output keys)
 *
 *   - `branchKeyAttrs[b]` — branch b's K key attr ids, in key order (distinct
 *     per branch; each branch originates its own key id — provenance-clean).
 *   - `outputKeyAttrs` — the K ids the `Project` minted for its `coalesce`
 *     outputs (computed expressions → fresh ids, disjoint from all child ids).
 *     The gather *mints* these, so `preserveAttributeIds[0..K-1] ===
 *     outputKeyAttrs` and downstream references to the coalesced key resolve.
 *   - `preserveAttributeIds` — the `Project`'s full output attribute list,
 *     which (because we matched the canonical order) is exactly
 *     `[minted keys] ++ [each branch's non-key attrs]`.
 *
 * ## Idempotence
 *
 * After the rewrite the matched node is an `AsyncGatherNode`, not a
 * `ProjectNode`, so a second firing's matcher rejects immediately.
 */

import { createLogger } from '../../../common/logger.js';
import type { OptContext } from '../../framework/context.js';
import type { PlanNode, RelationalPlanNode, Attribute } from '../../nodes/plan-node.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { JoinNode } from '../../nodes/join-node.js';
import { BinaryOpNode } from '../../nodes/scalar.js';
import { ColumnReferenceNode } from '../../nodes/reference.js';
import { ScalarFunctionCallNode } from '../../nodes/function.js';
import { AsyncGatherNode } from '../../nodes/async-gather-node.js';
import { isCorrelatedSubquery } from '../../cache/correlation-detector.js';

const log = createLogger('optimizer:rule:async-gather-zip-by-key');

/** A resolved key position: the equated key attr id in each branch, by branch index. */
interface KeyGroup {
	/** `byBranch[b]` is branch b's key attr id for this position. Length === branchCount. */
	readonly byBranch: readonly number[];
	/** Set form of `byBranch`, for matching a coalesce's argument set. */
	readonly idSet: ReadonlySet<number>;
}

export function ruleAsyncGatherZipByKey(node: PlanNode, context: OptContext): PlanNode | null {
	if (!(node instanceof ProjectNode)) return null;
	if (!(node.source instanceof JoinNode) || node.source.joinType !== 'full') return null;

	const tuning = context.tuning.parallel;
	if (tuning.minBranches < 2) return null;

	// (1) Flatten the full-outer chain into leaf branches + ON conditions.
	const branches: RelationalPlanNode[] = [];
	const conditions: PlanNode[] = [];
	if (!collectFullJoinChain(node.source, branches, conditions)) return null;
	if (branches.length < tuning.minBranches) return null;

	// (2) Each ON condition must be a pure AND-of-column-equalities. Collect the
	// (attrId, attrId) pairs; a residual / non-equi conjunct blocks the rewrite.
	const equalities: Array<[number, number]> = [];
	for (const cond of conditions) {
		if (!extractKeyEqualities(cond, equalities)) {
			log('Aborting: join condition has a residual / non-equi predicate');
			return null;
		}
	}
	if (equalities.length === 0) return null;

	// (3) Partition the equated columns into key groups (equivalence classes),
	// requiring every branch to contribute exactly one column to every group.
	const branchOfAttr = buildBranchOfAttr(branches);
	const groups = buildKeyGroups(equalities, branchOfAttr, branches.length);
	if (!groups) return null;
	const k = groups.length;

	// (4) Match the projection list against the canonical zipByKey layout.
	const matched = matchCanonicalProjections(node, branches, groups, branchOfAttr);
	if (!matched) return null;
	const { branchKeyAttrs, outputKeyAttrs } = matched;

	// Gates.
	for (const branch of branches) {
		if (branch.physical.concurrencySafe !== true) {
			log('Aborting: branch %s is not concurrencySafe', branch.id);
			return null;
		}
		if (isCorrelatedSubquery(branch)) {
			log('Aborting: branch %s is correlated (lateral dependency)', branch.id);
			return null;
		}
	}

	let maxLatency = 0;
	for (const branch of branches) {
		const l = branch.physical.expectedLatencyMs ?? 0;
		if (l > maxLatency) maxLatency = l;
	}
	if (maxLatency < tuning.gatherThresholdMs) return null;

	// Collation agreement per key position (the runtime comparator uses branch
	// 0's collation only). validateZipByKey also enforces this and *throws* on a
	// mismatch, but checking here lets the rule decline the rewrite gracefully —
	// the chain simply stays a JoinNode (which then errors at emit as an
	// unsupported FULL JOIN, the pre-rule baseline) rather than aborting planning.
	//
	// Non-binary collations are permitted as long as every branch agrees on the
	// collation per key position. The emitter's merged key value is deterministic
	// (lowest-indexed present branch supplies the key cells — see
	// `composeMergedKeyCells`), matching `coalesce`'s left-to-right pick even when
	// collation-equal keys are byte-distinct (e.g. NOCASE merging 'A'/'a'). The
	// branch-0-derived comparator is correct because the collations agree.
	if (!keyCollationsAgree(branches, branchKeyAttrs, k)) {
		log('Aborting: key columns disagree on collation across branches');
		return null;
	}

	// Each branch must be key-unique on its equated key columns. The zipByKey
	// emitter assumes one row per key per branch (a duplicate silently
	// overwrites); a true FULL JOIN on a non-unique key would multiply rows, so
	// folding a non-unique branch would change results. Require the zip key to
	// cover a declared unique key of every branch.
	if (!branchesKeyUnique(branches, branchKeyAttrs)) {
		log('Aborting: a branch is not provably unique on the equated key columns');
		return null;
	}

	const concurrencyCap = Math.max(1, Math.min(tuning.concurrency, branches.length));

	log(
		'Folding full-outer zip chain of %d branches (K=%d) into AsyncGather(zipByKey) (cap=%d, maxLatency=%d ms)',
		branches.length, k, concurrencyCap, maxLatency,
	);

	return new AsyncGatherNode(
		node.scope,
		branches,
		{ kind: 'zipByKey', branchKeyAttrs, outputKeyAttrs },
		concurrencyCap,
		node.getAttributes(),
	);
}

/**
 * Flatten a left-deep (or arbitrarily nested) chain of full-outer `JoinNode`s
 * into leaf branches and ON conditions. Branch order mirrors the join's
 * attribute concatenation (left subtree before right), so it lines up with the
 * canonical projection layout. Returns false if a full join is missing its ON
 * condition (cross-shaped full join — not recognizable).
 */
function collectFullJoinChain(
	node: RelationalPlanNode,
	branches: RelationalPlanNode[],
	conditions: PlanNode[],
): boolean {
	if (node instanceof JoinNode && node.joinType === 'full') {
		if (!node.condition) return false;
		conditions.push(node.condition);
		return collectFullJoinChain(node.left, branches, conditions)
			&& collectFullJoinChain(node.right, branches, conditions);
	}
	branches.push(node);
	return true;
}

/**
 * Walk a join condition collecting `=`-of-two-column-refs pairs as
 * (attrId, attrId). Returns false if any conjunct is not an `AND` or a
 * column=column equality (i.e. a residual predicate the zip can't absorb).
 */
function extractKeyEqualities(cond: PlanNode, out: Array<[number, number]>): boolean {
	const stack: PlanNode[] = [cond];
	while (stack.length) {
		const n = stack.pop()!;
		if (!(n instanceof BinaryOpNode)) return false;
		const op = n.expression.operator;
		if (op === 'AND') {
			stack.push(n.left, n.right);
			continue;
		}
		if (op !== '=') return false;
		if (!(n.left instanceof ColumnReferenceNode) || !(n.right instanceof ColumnReferenceNode)) return false;
		out.push([n.left.attributeId, n.right.attributeId]);
	}
	return true;
}

/** Map each branch attribute id to its branch index (for key-group membership). */
function buildBranchOfAttr(branches: readonly RelationalPlanNode[]): Map<number, number> {
	const map = new Map<number, number>();
	branches.forEach((branch, b) => {
		for (const attr of branch.getAttributes()) map.set(attr.id, b);
	});
	return map;
}

/**
 * Union-find the equality pairs into key groups, then validate that each group
 * holds exactly one attr from every branch. Returns null (block) on any
 * cross-branch shape that isn't a clean shared key.
 */
function buildKeyGroups(
	equalities: ReadonlyArray<readonly [number, number]>,
	branchOfAttr: ReadonlyMap<number, number>,
	branchCount: number,
): KeyGroup[] | null {
	const parent = new Map<number, number>();
	const find = (x: number): number => {
		let root = x;
		while (parent.get(root) !== root) root = parent.get(root)!;
		let cur = x;
		while (parent.get(cur) !== root) { const next = parent.get(cur)!; parent.set(cur, root); cur = next; }
		return root;
	};
	const ensure = (x: number): void => { if (!parent.has(x)) parent.set(x, x); };
	for (const [a, b] of equalities) {
		// Every equated column must belong to one of the flattened branches.
		if (!branchOfAttr.has(a) || !branchOfAttr.has(b)) return null;
		ensure(a); ensure(b);
		parent.set(find(a), find(b));
	}

	const byRoot = new Map<number, number[]>();
	for (const id of parent.keys()) {
		const root = find(id);
		let members = byRoot.get(root);
		if (!members) { members = []; byRoot.set(root, members); }
		members.push(id);
	}

	const groups: KeyGroup[] = [];
	for (const members of byRoot.values()) {
		const byBranch = new Array<number>(branchCount).fill(-1);
		for (const id of members) {
			const b = branchOfAttr.get(id)!;
			if (byBranch[b] !== -1) return null; // two key columns from one branch in one group
			byBranch[b] = id;
		}
		if (byBranch.some(v => v === -1)) return null; // a branch is missing from this key group
		groups.push({ byBranch, idSet: new Set(members) });
	}
	return groups;
}

interface MatchedProjections {
	/** `branchKeyAttrs[b]` — branch b's K key attr ids, in matched key-position order. */
	readonly branchKeyAttrs: number[][];
	/** The K minted output key attr ids (the Project's coalesce outputs), in key order. */
	readonly outputKeyAttrs: number[];
}

/**
 * Verify the projection list is exactly the canonical zipByKey layout:
 *   [ K coalesce(group) calls ] ++ [ branch0 non-key refs, branch1 non-key refs, … ]
 * and, if so, derive `branchKeyAttrs` (ordered to match the coalesce order) and
 * `outputKeyAttrs` (the coalesce output attr ids). Returns null on any mismatch.
 */
function matchCanonicalProjections(
	proj: ProjectNode,
	branches: readonly RelationalPlanNode[],
	groups: readonly KeyGroup[],
	branchOfAttr: ReadonlyMap<number, number>,
): MatchedProjections | null {
	const k = groups.length;
	const projections = proj.projections;
	const outAttrs = proj.getAttributes();

	// Expected non-key tail: each branch's non-key attrs, in branch + column order.
	const keyAttrIds = new Set<number>();
	for (const g of groups) for (const id of g.idSet) keyAttrIds.add(id);
	const nonKeyTail: number[] = [];
	for (const branch of branches) {
		for (const attr of branch.getAttributes()) {
			if (!keyAttrIds.has(attr.id)) nonKeyTail.push(attr.id);
		}
	}
	if (projections.length !== k + nonKeyTail.length) return null;

	// First K projections: each a coalesce over exactly one (still-unused) group.
	const orderedGroups: KeyGroup[] = [];
	const outputKeyAttrs: number[] = [];
	const usedGroup = new Set<KeyGroup>();
	for (let p = 0; p < k; p++) {
		const expr = projections[p].node;
		if (!(expr instanceof ScalarFunctionCallNode)) return null;
		if (expr.expression.name.toLowerCase() !== 'coalesce') return null;
		const argIds: number[] = [];
		for (const operand of expr.operands) {
			if (!(operand instanceof ColumnReferenceNode)) return null;
			argIds.push(operand.attributeId);
		}
		const group = groups.find(g =>
			!usedGroup.has(g)
			&& g.idSet.size === argIds.length
			&& argIds.every(id => g.idSet.has(id)),
		);
		if (!group) return null;
		usedGroup.add(group);
		orderedGroups.push(group);
		outputKeyAttrs.push(outAttrs[p].id);
	}

	// Remaining projections: bare column refs matching the non-key tail exactly.
	for (let i = 0; i < nonKeyTail.length; i++) {
		const expr = projections[k + i].node;
		if (!(expr instanceof ColumnReferenceNode)) return null;
		if (expr.attributeId !== nonKeyTail[i]) return null;
		// A non-key projection must forward its source id (ProjectNode does this
		// for bare column refs); confirm it actually belongs to a branch.
		if (!branchOfAttr.has(expr.attributeId)) return null;
	}

	const branchKeyAttrs = branches.map((_branch, b) => orderedGroups.map(g => g.byBranch[b]));
	return { branchKeyAttrs, outputKeyAttrs };
}

/**
 * Confirm every branch is provably unique on its equated key columns: some
 * declared unique key of the branch must be covered by (a subset of) the zip's
 * key-column indices. Branches without statistics-free uniqueness (no covering
 * key) block the rewrite — the zip's one-row-per-key merge would otherwise
 * differ from a true full join's per-key product.
 */
function branchesKeyUnique(
	branches: readonly RelationalPlanNode[],
	branchKeyAttrs: readonly (readonly number[])[],
): boolean {
	for (let b = 0; b < branches.length; b++) {
		const attrs = branches[b].getAttributes();
		const keyIndices = new Set<number>();
		for (const id of branchKeyAttrs[b]) {
			const ix = attrs.findIndex((a: Attribute) => a.id === id);
			if (ix < 0) return false;
			keyIndices.add(ix);
		}
		const declaredKeys = branches[b].getType().keys;
		const covered = declaredKeys.some(key => key.every(ref => keyIndices.has(ref.index)));
		if (!covered) return false;
	}
	return true;
}

/**
 * Confirm every branch's key column at every key position declares the **same**
 * collation as branch 0's (absent collation = binary). The runtime comparator
 * derives solely from branch 0's collations, so a disagreement would silently
 * compare (and merge) keys under the wrong collation. Agreement is sufficient:
 * the emitter's merged key value is deterministic (lowest-indexed present branch
 * wins — see `composeMergedKeyCells`), so any agreed collation, binary or not,
 * yields a well-defined merged key that matches `coalesce`.
 */
function keyCollationsAgree(
	branches: readonly RelationalPlanNode[],
	branchKeyAttrs: readonly (readonly number[])[],
	k: number,
): boolean {
	const norm = (c: string | undefined): string => (c && c.length > 0 ? c.toUpperCase() : 'BINARY');
	const collationOf = (branch: RelationalPlanNode, attrId: number): string => {
		const attrs = branch.getAttributes();
		const cols = branch.getType().columns;
		const ix = attrs.findIndex((a: Attribute) => a.id === attrId);
		return ix >= 0 ? norm(cols[ix].type.collationName) : 'BINARY';
	};
	for (let pos = 0; pos < k; pos++) {
		const base = collationOf(branches[0], branchKeyAttrs[0][pos]);
		for (let b = 1; b < branches.length; b++) {
			if (collationOf(branches[b], branchKeyAttrs[b][pos]) !== base) return false;
		}
	}
	return true;
}
