/**
 * Physical table access nodes for seek and range scan operations
 * These replace logical TableReferenceNode during optimization
 */

import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type UnaryRelationalNode, type PhysicalProperties, type Attribute } from './plan-node.js';
import { TableReferenceNode } from './reference.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type { FilterInfo } from '../../vtab/filter-info.js';
import type { ScalarPlanNode } from './plan-node.js';

/**
 * Base class for physical table access operations
 * Provides common functionality for sequential scan, index scan, and index seek
 */
export abstract class TableAccessNode extends PlanNode implements UnaryRelationalNode {
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

	getChildren(): readonly PlanNode[] {
		return [this.source];
	}

	getRelations(): readonly [TableReferenceNode] {
		return [this.source];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`${this.nodeType} expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Type check - Physical access nodes specifically need a TableReferenceNode
		if (!(newSource instanceof TableReferenceNode)) {
			throw new Error(`${this.nodeType}: child must be a TableReferenceNode`);
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Subclasses must override this with their specific constructor
		throw new Error(`${this.nodeType} must override withChildren method`);
	}

	override getLogicalAttributes(): Record<string, unknown> {
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
export class SeqScanNode extends TableAccessNode {
	override readonly nodeType = PlanNodeType.SeqScan;

	computePhysical(): Partial<PhysicalProperties> {
		return {
			estimatedRows: this.source.estimatedRows,
			uniqueKeys: this.source.getType().keys.map(key => key.map(colRef => colRef.index)),
			// Sequential scans don't provide any specific ordering
			ordering: undefined
		};
	}

	override toString(): string {
		return `SEQ SCAN ${this.source.tableSchema.name}`;
	}

	override withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`SeqScanNode expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Type check - Physical access nodes specifically need a TableReferenceNode
		if (!(newSource instanceof TableReferenceNode)) {
			throw new Error('SeqScanNode: child must be a TableReferenceNode');
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Create new instance
		return new SeqScanNode(
			this.scope,
			newSource,
			this.filterInfo
		);
	}
}

/**
 * Index scan - uses an index to read table data in order
 * Provides ordering and can handle range queries efficiently
 */
export class IndexScanNode extends TableAccessNode {
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

	computePhysical(): Partial<PhysicalProperties> {
		return {
			estimatedRows: this.source.estimatedRows,
			uniqueKeys: this.source.getType().keys.map(key => key.map(colRef => colRef.index)),
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

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			...super.getLogicalAttributes(),
			indexName: this.indexName,
			providesOrdering: this.providesOrdering
		};
	}

	override withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`IndexScanNode expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Type check - Physical access nodes specifically need a TableReferenceNode
		if (!(newSource instanceof TableReferenceNode)) {
			throw new Error('IndexScanNode: child must be a TableReferenceNode');
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Create new instance
		return new IndexScanNode(
			this.scope,
			newSource,
			this.filterInfo,
			this.indexName,
			this.providesOrdering
		);
	}
}

/**
 * Index seek - point lookup or tight range using an index
 * Very efficient for equality constraints and small ranges
 */
export class IndexSeekNode extends TableAccessNode {
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

	computePhysical(): Partial<PhysicalProperties> {
		return {
			uniqueKeys: this.source.getType().keys.map(key => key.map(colRef => colRef.index)),
			// Index seeks can provide ordering and usually return few rows
			ordering: this.providesOrdering,
			// Seeks typically return much fewer rows than estimated
			estimatedRows: Math.min(this.source.estimatedRows || 1000, 100)
		};
	}

	override toString(): string {
		const seekDesc = this.isRange ? 'RANGE' : 'SEEK';
		const orderDesc = this.providesOrdering
			? ` ORDER BY ${this.providesOrdering.map(o => `${o.column}${o.desc ? ' DESC' : ''}`).join(', ')}`
			: '';
		return `INDEX ${seekDesc} ${this.source.tableSchema.name} USING ${this.indexName}${orderDesc}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			...super.getLogicalAttributes(),
			indexName: this.indexName,
			seekKeys: this.seekKeys.map(key => key.toString()),
			isRange: this.isRange,
			providesOrdering: this.providesOrdering
		};
	}

	getSeekKeys(): readonly ScalarPlanNode[] {
		return this.seekKeys;
	}

	override getChildren(): readonly PlanNode[] {
		return [this.source, ...this.seekKeys];
	}

	override withChildren(newChildren: readonly PlanNode[]): PlanNode {
		const expectedLength = 1 + this.seekKeys.length;
		if (newChildren.length !== expectedLength) {
			throw new Error(`IndexSeekNode expects ${expectedLength} children, got ${newChildren.length}`);
		}

		const [newSource, ...newSeekKeys] = newChildren;

		// Type check - Physical access nodes specifically need a TableReferenceNode
		if (!(newSource instanceof TableReferenceNode)) {
			throw new Error('IndexSeekNode: first child must be a TableReferenceNode');
		}

		// Type check seek keys
		for (const seekKey of newSeekKeys) {
			if (!('expression' in seekKey)) {
				throw new Error('IndexSeekNode: seek keys must be ScalarPlanNodes');
			}
		}

		// Check if anything changed
		const sourceChanged = newSource !== this.source;
		const seekKeysChanged = newSeekKeys.some((key, i) => key !== this.seekKeys[i]);

		if (!sourceChanged && !seekKeysChanged) {
			return this;
		}

		// Create new instance
		return new IndexSeekNode(
			this.scope,
			newSource,
			this.filterInfo,
			this.indexName,
			newSeekKeys as ScalarPlanNode[],
			this.isRange,
			this.providesOrdering
		);
	}
}
