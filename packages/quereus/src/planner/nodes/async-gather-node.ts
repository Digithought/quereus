import { isRelationalNode, PlanNode } from './plan-node.js';
import type {
	RelationalPlanNode,
	Attribute,
	PhysicalProperties,
	FunctionalDependency,
	ConstantBinding,
	DomainConstraint,
} from './plan-node.js';
import type { RelationType, ColRef } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import {
	closeConstantBindingsOverEcs,
	mergeConstantBindings,
	mergeDomainConstraints,
	mergeEquivClasses,
	mergeFds,
	shiftConstantBindings,
	shiftDomainConstraints,
	shiftEquivClasses,
	shiftFds,
} from '../util/fd-utils.js';

/**
 * How {@link AsyncGatherNode} combines rows from its N independent child relations.
 *
 * - `unionAll`: yield every row from every branch in arrival order — multiset
 *   union (no dedup). All children must have matching column counts.
 *
 * - `crossProduct`: drain every branch fully, then yield the full Cartesian
 *   product. The output attributes are the concatenation of all children's
 *   attributes. **Materialises every branch in memory before yielding the
 *   first row** — see emitter docs in `runtime/emit/async-gather.ts`.
 *
 * The discriminated-union shape is deliberate: future variants (e.g.
 * `zipByKey`, `mergeOrdered`) will attach per-combinator config without
 * breaking the constructor.
 */
export type AsyncGatherCombinator =
	| { readonly kind: 'unionAll' }
	| { readonly kind: 'crossProduct' };

/**
 * Physical N-ary relational node that drives ≥ 2 independent (uncorrelated)
 * child relations concurrently via {@link ParallelDriver.drive} and combines
 * their outputs with the configured {@link AsyncGatherCombinator}.
 *
 * Properties:
 *
 * - `unionAll`: ordering is dropped (arrival-order interleave is
 *   non-deterministic); FDs / ECs / constant bindings / domain constraints
 *   are dropped (same conservatism `SetOperationNode.computePhysical` already
 *   applies); attribute IDs mirror `children[0]` to preserve downstream
 *   `ORDER BY` references; `isSet` is `false` (duplicates allowed); per-column
 *   nullability is the OR across children.
 *
 * - `crossProduct`: ordering is dropped; FDs / ECs / bindings / domain
 *   constraints are the pairwise N-ary fold of the children (the same fold
 *   `JoinNode(cross)` does, repeated); attribute IDs are the verbatim
 *   concatenation of children; per-column nullability flows through
 *   unchanged. Cartesian product order is deterministic-but-unspecified
 *   (a function of the per-branch arrival order). **Buffers all branches
 *   before yielding** — not suitable for large branches.
 *
 * `concurrencySafe` and `expectedLatencyMs` are NOT propagated by this node:
 * those fields are not yet defined on {@link PhysicalProperties} (the parallel
 * track has not landed them). Once a successor ticket (5.5 or later) adds
 * them, the intended merge is `AND` across children for `concurrencySafe` and
 * `max` across children for `expectedLatencyMs`; update this node's
 * `computePhysical` at that time. The fields currently inherited from
 * `PlanNode.physical`'s default child-merge are `deterministic`,
 * `idempotent`, and `readonly` (AND across children).
 */
export class AsyncGatherNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.AsyncGather;
	private attributesCache: Cached<readonly Attribute[]>;

	constructor(
		scope: Scope,
		public readonly children: readonly RelationalPlanNode[],
		public readonly combinator: AsyncGatherCombinator,
		public readonly concurrencyCap: number,
		public readonly preserveAttributeIds?: readonly Attribute[],
	) {
		AsyncGatherNode.validateConstruction(children, combinator, concurrencyCap);
		super(scope, children.reduce((acc, c) => acc + c.getTotalCost(), 0));
		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	private static validateConstruction(
		children: readonly RelationalPlanNode[],
		combinator: AsyncGatherCombinator,
		concurrencyCap: number,
	): void {
		if (children.length < 2) {
			quereusError(
				`AsyncGatherNode requires >= 2 children, got ${children.length}`,
				StatusCode.INTERNAL,
			);
		}
		if (!Number.isInteger(concurrencyCap) || concurrencyCap < 1) {
			quereusError(
				`AsyncGatherNode concurrencyCap must be a positive integer, got ${concurrencyCap}`,
				StatusCode.INTERNAL,
			);
		}
		if (combinator.kind === 'unionAll') {
			const firstColCount = children[0].getType().columns.length;
			for (let i = 1; i < children.length; i++) {
				const colCount = children[i].getType().columns.length;
				if (colCount !== firstColCount) {
					quereusError(
						`AsyncGatherNode(unionAll) column count mismatch: child 0 has ${firstColCount}, child ${i} has ${colCount}`,
						StatusCode.ERROR,
					);
				}
			}
		}
	}

	private buildAttributes(): readonly Attribute[] {
		if (this.preserveAttributeIds) {
			return this.preserveAttributeIds.slice();
		}
		if (this.combinator.kind === 'unionAll') {
			// Mirror SetOperationNode.buildAttributes: keep left (children[0])
			// attribute IDs verbatim so ORDER BY references continue to resolve.
			return this.children[0].getAttributes();
		}
		// crossProduct: concatenate children's attributes verbatim.
		const out: Attribute[] = [];
		for (const child of this.children) {
			for (const attr of child.getAttributes()) {
				out.push(attr);
			}
		}
		return out;
	}

	getAttributes(): readonly Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		if (this.combinator.kind === 'unionAll') {
			// Per-column nullability is the OR across all children; isSet is
			// false (unionAll allows duplicates). Other fields fall through
			// from children[0].
			const types = this.children.map(c => c.getType());
			const baseType = types[0];
			const columns = baseType.columns.map((baseCol, i) => {
				let nullable = baseCol.type.nullable;
				for (let j = 1; j < types.length; j++) {
					nullable = nullable || types[j].columns[i].type.nullable;
				}
				return nullable === baseCol.type.nullable
					? baseCol
					: { ...baseCol, type: { ...baseCol.type, nullable: true } };
			});
			return {
				typeClass: 'relation',
				columns,
				isSet: false,
				isReadOnly: types.every(t => t.isReadOnly),
				keys: [],
				rowConstraints: [],
			} as RelationType;
		}

		// crossProduct: concatenate columns; keys are the N-ary Cartesian product
		// of per-child keys (each child contributes one key; offsets accumulate).
		const types = this.children.map(c => c.getType());
		const columns = types.flatMap(t => t.columns.map(col => col));
		const isReadOnly = types.every(t => t.isReadOnly);
		const rowConstraints = types.flatMap(t => t.rowConstraints.map(rc => rc));

		// Fold keys pairwise: at each step, combine accumulated keys with the
		// next child's keys, shifting the next child's column indices by the
		// running column count.
		let keys: ColRef[][] = types[0].keys.map(k => k.map(c => ({ index: c.index, desc: c.desc })));
		let runningCols = types[0].columns.length;
		for (let i = 1; i < types.length; i++) {
			const next = types[i];
			const shiftedNextKeys: ColRef[][] = next.keys.map(k =>
				k.map(c => ({ index: c.index + runningCols, desc: c.desc })),
			);
			const combined: ColRef[][] = [];
			if (keys.length === 0) {
				// Accumulated side has no key; result has no key either (we cannot
				// build a Cartesian key without one from every side).
				keys = [];
			} else if (shiftedNextKeys.length === 0) {
				keys = [];
			} else {
				for (const k1 of keys) {
					for (const k2 of shiftedNextKeys) {
						combined.push([...k1, ...k2]);
					}
				}
				keys = combined;
			}
			runningCols += next.columns.length;
		}

		const isSet = types.every(t => t.isSet);
		return {
			typeClass: 'relation',
			columns,
			isSet,
			isReadOnly,
			keys,
			rowConstraints,
		} as RelationType;
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		if (this.combinator.kind === 'unionAll') {
			// Same conservatism as SetOperationNode: drop relational invariants
			// that can't be guaranteed across a UNION ALL. Ordering is dropped
			// (arrival-order interleave is non-deterministic).
			return {
				ordering: undefined,
				monotonicOn: undefined,
				fds: undefined,
				equivClasses: undefined,
				constantBindings: undefined,
				domainConstraints: undefined,
			};
		}

		// crossProduct: fold pairwise — identical to N applications of
		// JoinNode(cross). Each child's FDs hold on its slice of the output row;
		// concatenation preserves them after shifting column indices.
		let fds: ReadonlyArray<FunctionalDependency> = childrenPhysical[0].fds ?? [];
		let equiv: ReadonlyArray<ReadonlyArray<number>> = childrenPhysical[0].equivClasses ?? [];
		let bindings: ReadonlyArray<ConstantBinding> = childrenPhysical[0].constantBindings ?? [];
		let domains: ReadonlyArray<DomainConstraint> = childrenPhysical[0].domainConstraints ?? [];
		let runningCols = this.children[0].getType().columns.length;

		for (let i = 1; i < this.children.length; i++) {
			const rightPhys = childrenPhysical[i];
			const rightFds = rightPhys.fds ?? [];
			const rightEC = rightPhys.equivClasses ?? [];
			const rightBindings = rightPhys.constantBindings ?? [];
			const rightDomains = rightPhys.domainConstraints ?? [];

			fds = mergeFds(fds, shiftFds(rightFds, runningCols));
			equiv = mergeEquivClasses(equiv, shiftEquivClasses(rightEC, runningCols));
			const mergedBindings = mergeConstantBindings(
				bindings,
				shiftConstantBindings(rightBindings, runningCols),
			);
			bindings = closeConstantBindingsOverEcs(mergedBindings, equiv);
			domains = mergeDomainConstraints(domains, shiftDomainConstraints(rightDomains, runningCols));

			runningCols += this.children[i].getType().columns.length;
		}

		return {
			ordering: undefined,
			monotonicOn: undefined,
			fds: fds.length > 0 ? fds : undefined,
			equivClasses: equiv.length > 0 ? equiv : undefined,
			constantBindings: bindings.length > 0 ? bindings : undefined,
			domainConstraints: domains.length > 0 ? domains : undefined,
		};
	}

	getChildren(): readonly PlanNode[] {
		return this.children;
	}

	getRelations(): readonly RelationalPlanNode[] {
		return this.children;
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== this.children.length) {
			quereusError(
				`AsyncGatherNode expects ${this.children.length} children, got ${newChildren.length}`,
				StatusCode.INTERNAL,
			);
		}

		let changed = false;
		const typed: RelationalPlanNode[] = [];
		for (let i = 0; i < newChildren.length; i++) {
			const child = newChildren[i];
			if (!isRelationalNode(child)) {
				quereusError(
					`AsyncGatherNode: child ${i} must be a RelationalPlanNode`,
					StatusCode.INTERNAL,
				);
			}
			if (child !== this.children[i]) changed = true;
			typed.push(child as RelationalPlanNode);
		}

		if (!changed) return this;

		return new AsyncGatherNode(
			this.scope,
			typed,
			this.combinator,
			this.concurrencyCap,
			this.preserveAttributeIds,
		);
	}

	get estimatedRows(): number | undefined {
		if (this.combinator.kind === 'unionAll') {
			let total = 0;
			for (const c of this.children) {
				if (c.estimatedRows === undefined) return undefined;
				total += c.estimatedRows;
			}
			return total;
		}
		// crossProduct
		let product = 1;
		for (const c of this.children) {
			if (c.estimatedRows === undefined) return undefined;
			product *= c.estimatedRows;
		}
		return product;
	}

	override toString(): string {
		return `ASYNC_GATHER(${this.combinator.kind}, N=${this.children.length}, cap=${this.concurrencyCap})`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			combinator: this.combinator.kind,
			branchCount: this.children.length,
			concurrencyCap: this.concurrencyCap,
		};
	}
}

