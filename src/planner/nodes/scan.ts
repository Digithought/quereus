import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type UnaryRelationalNode } from './plan-node.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type { FilterInfo } from '../../vtab/filter-info.js';

/**
 * Represents a table scan operation (full or filtered).
 * This is a physical node that accesses actual table data.
 */
export class TableScanNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.TableScan;

	private outputType: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly source: TableReferenceNode,
		public readonly filterInfo: FilterInfo,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride ?? filterInfo.indexInfoOutput.estimatedCost);

		this.outputType = new Cached(() => this.source.getType());
	}

	getType(): RelationType {
		return this.outputType.value;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [TableReferenceNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		return Number(this.filterInfo.indexInfoOutput.estimatedRows);
	}

	override toString(): string {
		return `${super.toString()} (${this.source.tableSchema.name})`;
	}
}
