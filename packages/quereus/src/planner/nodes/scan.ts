import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type UnaryRelationalNode, type PhysicalProperties, type Attribute } from './plan-node.js';
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

	getAttributes(): Attribute[] {
		// Table scans produce the same attributes as their source table reference
		return this.source.getAttributes();
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

	getPhysical(): PhysicalProperties {
		const tableType = this.source.getType();

		return {
			estimatedRows: this.estimatedRows,
			// Table scans preserve the logical keys from the table schema
			uniqueKeys: tableType.keys.map(key => key.map(colRef => colRef.index)),
			readonly: true,
			deterministic: true,
			constant: false // Table scans are never constant
		};
	}

	override toString(): string {
		return `SCAN ${this.source.tableSchema.name}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			table: this.source.tableSchema.name,
			schema: this.source.tableSchema.schemaName,
			filterInfo: {
				usableIndex: this.filterInfo.indexInfoOutput.idxStr,
				matchedClauses: this.filterInfo.indexInfoOutput.aConstraintUsage?.length || 0,
				estimatedCost: this.filterInfo.indexInfoOutput.estimatedCost,
				estimatedRows: this.filterInfo.indexInfoOutput.estimatedRows
			}
		};
	}
}
