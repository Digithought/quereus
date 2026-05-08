import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type BinaryRelationalNode, type PhysicalProperties, type Attribute, type MonotonicOnInfo, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { StatusCode } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';
import { buildJoinAttributes, buildJoinRelationType } from './join-utils.js';

/**
 * Pair of attribute IDs identifying matching attributes on the left and right sides
 * of an asof scan (either the asof match attribute or a partition equi-pair).
 */
export interface AsofAttrPair {
	leftAttrId: number;
	rightAttrId: number;
}

/**
 * Physical plan node implementing a streaming asof scan.
 *
 * For each left row, emits the right row with the largest match value ≤ the
 * left's match value (or strictly < when `strict`), optionally bucketed by
 * partition keys. Requires the right input to advertise `MonotonicOn(matchAttr)`
 * and `accessCapabilities.asofRight`.
 *
 * Output attributes: left attributes followed by the projected right output
 * attributes (NULL-padded when `outer` and no match exists). The optional
 * `rightOutputAttrs` parameter lets the rule preserve attribute IDs from the
 * original logical JoinNode — without it, all of `right`'s attributes are
 * emitted unchanged.
 *
 * Cost: O(left.rows + right.rows) — the right is bucketed once and the left
 * streams through with a monotonic per-bucket cursor.
 */
export class AsofScanNode extends PlanNode implements BinaryRelationalNode {
	override readonly nodeType = PlanNodeType.AsofScan;
	private attributesCache: Cached<Attribute[]>;

	constructor(
		scope: Scope,
		/** Left (driving) input. */
		public readonly left: RelationalPlanNode,
		/** Right input. Must advertise MonotonicOn(matchAttr.right) and accessCapabilities.asofRight. */
		public readonly right: RelationalPlanNode,
		/** Asof match attribute pair (left.match >= right.match, or > when `strict`). */
		public readonly matchAttr: AsofAttrPair,
		/** Equi-partition keys (zero or more). Empty array = single bucket. */
		public readonly partitionAttrs: readonly AsofAttrPair[],
		/** Strict (<) vs non-strict (≤) on the asof comparison. */
		public readonly strict: boolean,
		/** LEFT JOIN semantics: emit unmatched left rows with NULL right columns. */
		public readonly outer: boolean,
		/**
		 * Column indices into `right`'s row to project for output. If undefined,
		 * all of `right`'s columns are emitted in order.
		 */
		public readonly rightOutputColumnIndices?: readonly number[],
		/**
		 * Attributes to expose for the right side of the output. When provided,
		 * these are used verbatim (preserving attribute IDs from the original
		 * logical JoinNode). Length must match `rightOutputColumnIndices` (or the
		 * full right attribute count when no projection is given).
		 */
		public readonly rightOutputAttrs?: readonly Attribute[],
	) {
		const leftRows = left.estimatedRows ?? 100;
		const rightRows = right.estimatedRows ?? 100;
		// O(L + R) per-row work plus the children's own costs.
		const cost = left.getTotalCost() + right.getTotalCost() + leftRows + rightRows;
		super(scope, cost);

		this.attributesCache = new Cached(() => this.buildAttributes());
	}

	/** Indices into the right row to emit, in output order. */
	getRightOutputColumnIndices(): readonly number[] {
		if (this.rightOutputColumnIndices) return this.rightOutputColumnIndices;
		return this.right.getAttributes().map((_, i) => i);
	}

	private buildAttributes(): Attribute[] {
		const leftAttrs = this.left.getAttributes();
		const rightAttrs = this.right.getAttributes();
		const rightCols = this.getRightOutputColumnIndices();

		// When `rightOutputAttrs` is supplied, use those verbatim alongside the left
		// attributes — they already encode the JoinNode's preserved IDs and any
		// nullability overrides for `outer`.
		if (this.rightOutputAttrs) {
			if (this.rightOutputAttrs.length !== rightCols.length) {
				quereusError(`AsofScanNode: rightOutputAttrs length ${this.rightOutputAttrs.length} != rightOutputColumnIndices length ${rightCols.length}`, StatusCode.INTERNAL);
			}
			return [...leftAttrs, ...this.rightOutputAttrs];
		}

		const projectedRightAttrs: Attribute[] = rightCols.map(idx => {
			if (idx < 0 || idx >= rightAttrs.length) {
				quereusError(`AsofScanNode: rightOutputColumnIndex ${idx} out of range [0,${rightAttrs.length})`, StatusCode.INTERNAL);
			}
			return rightAttrs[idx];
		});

		return buildJoinAttributes(leftAttrs, projectedRightAttrs, this.outer ? 'left' : 'inner');
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		const leftType = this.left.getType();
		const rightAttrs = this.getAttributes().slice(this.left.getAttributes().length);
		const rightType: RelationType = {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: rightAttrs.map(a => ({ name: a.name, type: a.type })),
			keys: [],
			rowConstraints: [],
		};
		return buildJoinRelationType(leftType, rightType, this.outer ? 'left' : 'inner', []);
	}

	computePhysical(childrenPhysical: PhysicalProperties[]): Partial<PhysicalProperties> {
		const leftPhys = childrenPhysical[0];

		// AsofScan emits one row per left row in left's order — left's ordering and
		// monotonicOn carry through (right values are appended per row but don't
		// reorder the output).
		const monotonicOn: readonly MonotonicOnInfo[] | undefined = leftPhys?.monotonicOn;
		const ordering = leftPhys?.ordering;

		return {
			ordering,
			monotonicOn,
			estimatedRows: this.left.estimatedRows,
			// Drop unique keys: appending right values per left row doesn't preserve
			// uniqueness on left's keys (and the right side has no key contribution).
			uniqueKeys: undefined,
		};
	}

	get estimatedRows(): number | undefined {
		return this.left.estimatedRows;
	}

	getChildren(): readonly PlanNode[] {
		return [this.left, this.right];
	}

	getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.left, this.right];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 2) {
			quereusError(`AsofScanNode expects 2 children, got ${newChildren.length}`, StatusCode.INTERNAL);
		}

		const [newLeft, newRight] = newChildren;

		if (!isRelationalNode(newLeft)) {
			quereusError('AsofScanNode: first child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}
		if (!isRelationalNode(newRight)) {
			quereusError('AsofScanNode: second child must be a RelationalPlanNode', StatusCode.INTERNAL);
		}

		if (newLeft === this.left && newRight === this.right) {
			return this;
		}

		return new AsofScanNode(
			this.scope,
			newLeft as RelationalPlanNode,
			newRight as RelationalPlanNode,
			this.matchAttr,
			this.partitionAttrs,
			this.strict,
			this.outer,
			this.rightOutputColumnIndices,
			this.rightOutputAttrs,
		);
	}

	override toString(): string {
		const op = this.strict ? '<' : '<=';
		const parts: string[] = [];
		parts.push(`right.${this.matchAttr.rightAttrId} ${op} left.${this.matchAttr.leftAttrId}`);
		for (const p of this.partitionAttrs) {
			parts.push(`right.${p.rightAttrId} = left.${p.leftAttrId}`);
		}
		return `${this.outer ? 'LEFT ' : ''}ASOF SCAN on [${parts.join(', ')}]`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			outer: this.outer,
			strict: this.strict,
			matchAttr: { left: this.matchAttr.leftAttrId, right: this.matchAttr.rightAttrId },
			partitionAttrs: this.partitionAttrs.map(p => ({ left: p.leftAttrId, right: p.rightAttrId })),
			rightOutputColumnIndices: this.rightOutputColumnIndices ? [...this.rightOutputColumnIndices] : undefined,
			leftRows: this.left.estimatedRows,
			rightRows: this.right.estimatedRows,
		};
	}
}
