/**
* Physical table access nodes for seek and range scan operations
 * These replace logical TableScanNode during optimization
 */

import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type UnaryRelationalNode, type PhysicalProperties, type Attribute } from './plan-node.js';
import type { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type { FilterInfo } from '../../vtab/filter-info.js';
import type { ScalarPlanNode } from './plan-node.js';

/**
 * Base class for physical table access operations
 * Provides common functionality for sequential scan, index scan, and index seek
 */
export abstract class PhysicalTableAccessNode extends PlanNode implements UnaryRelationalNode {
	private attributesCache: Cached<Attribute[]>;
	private outputType: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly source: TableReferenceNode,
		public readonly filterInfo: FilterInfo,
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride ?? filterInfo.indexInfoOutput.estimatedCost);

		this.attributesCache = new Cached(() => this.source.getAttributes());
		this.outputType = new Cached(() => this.source.getType());
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		return this.outputType.value;
	}

	getChildren(): readonly [TableReferenceNode] {
		return [this.source];
	}

	getRelations(): readonly [TableReferenceNode] {
		return [this.source];
	}

		/**
	 * Get common physical properties for table access
	 */
	protected getBasePhysicalProperties(): PhysicalProperties {
		const tableType = this.source.getType();

		return {
			estimatedRows: this.source.estimatedRows,
			// Table scans preserve the logical keys from the table schema
			uniqueKeys: tableType.keys.map(key => key.map(colRef => colRef.index)),
			readonly: true,
			deterministic: true,
			constant: false // Table access is never constant
		};
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			table: this.source.tableSchema.name,
			schema: this.source.tableSchema.schemaName,
			accessMethod: this.nodeType,
			filterInfo: {
				usableIndex: this.filterInfo.indexInfoOutput.idxStr,
				matchedClauses: this.filterInfo.indexInfoOutput.aConstraintUsage?.length || 0,
				estimatedCost: this.filterInfo.indexInfoOutput.estimatedCost,
				estimatedRows: this.filterInfo.indexInfoOutput.estimatedRows
			}
		};
	}
}

/**
 * Sequential scan - reads entire table without using indexes
 * Used when no suitable index exists or for small tables
 */
export class SeqScanNode extends PhysicalTableAccessNode {
	override readonly nodeType = PlanNodeType.SeqScan;

	getPhysical(): PhysicalProperties {
		const baseProps = this.getBasePhysicalProperties();

		return {
			...baseProps,
			// Sequential scans don't provide any specific ordering
			ordering: undefined
		};
	}

	override toString(): string {
		return `SEQ SCAN ${this.source.tableSchema.name}`;
	}
}

/**
 * Index scan - uses an index to read table data in order
 * Provides ordering and can handle range queries efficiently
 */
export class IndexScanNode extends PhysicalTableAccessNode {
	override readonly nodeType = PlanNodeType.IndexScan;

	constructor(
		scope: Scope,
		source: TableReferenceNode,
		filterInfo: FilterInfo,
		public readonly indexName: string,
		public readonly providesOrdering?: { column: number; desc: boolean }[],
		estimatedCostOverride?: number
	) {
		super(scope, source, filterInfo, estimatedCostOverride);
	}

	getPhysical(): PhysicalProperties {
		const baseProps = this.getBasePhysicalProperties();

		return {
			...baseProps,
			// Index scans can provide ordering
			ordering: this.providesOrdering
		};
	}

	override toString(): string {
		const orderDesc = this.providesOrdering
			? ` ORDER BY ${this.providesOrdering.map(o => `${o.column}${o.desc ? ' DESC' : ''}`).join(', ')}`
			: '';
		return `INDEX SCAN ${this.source.tableSchema.name} USING ${this.indexName}${orderDesc}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			...super.getLogicalProperties(),
			indexName: this.indexName,
			providesOrdering: this.providesOrdering
		};
	}
}

/**
 * Index seek - point lookup or tight range using an index
 * Very efficient for equality constraints and small ranges
 */
export class IndexSeekNode extends PhysicalTableAccessNode {
	override readonly nodeType = PlanNodeType.IndexSeek;

	constructor(
		scope: Scope,
		source: TableReferenceNode,
		filterInfo: FilterInfo,
		public readonly indexName: string,
		public readonly seekKeys: ScalarPlanNode[],
		public readonly isRange: boolean = false,
		public readonly providesOrdering?: { column: number; desc: boolean }[],
		estimatedCostOverride?: number
	) {
		super(scope, source, filterInfo, estimatedCostOverride);
	}

	getPhysical(): PhysicalProperties {
		const baseProps = this.getBasePhysicalProperties();

		return {
			...baseProps,
			// Index seeks can provide ordering and usually return few rows
			ordering: this.providesOrdering,
			// Seeks typically return much fewer rows than estimated
			estimatedRows: Math.min(baseProps.estimatedRows || 1000, 100)
		};
	}

	override toString(): string {
		const seekDesc = this.isRange ? 'RANGE' : 'SEEK';
		const orderDesc = this.providesOrdering
			? ` ORDER BY ${this.providesOrdering.map(o => `${o.column}${o.desc ? ' DESC' : ''}`).join(', ')}`
			: '';
		return `INDEX ${seekDesc} ${this.source.tableSchema.name} USING ${this.indexName}${orderDesc}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			...super.getLogicalProperties(),
			indexName: this.indexName,
			seekKeys: this.seekKeys.map(key => key.toString()),
			isRange: this.isRange,
			providesOrdering: this.providesOrdering
		};
	}

	getSeekKeys(): readonly ScalarPlanNode[] {
		return this.seekKeys;
	}
}
