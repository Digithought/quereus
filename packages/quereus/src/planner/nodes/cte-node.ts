import { PlanNode, type UnaryRelationalNode, type RelationalPlanNode, type Attribute, type TableDescriptor } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';

/**
 * Common interface for all CTE nodes (regular and recursive)
 */
export interface CTEPlanNode extends UnaryRelationalNode {
	readonly cteName: string;
	readonly columns: string[] | undefined;
	readonly materializationHint: 'materialized' | 'not_materialized' | undefined;
	readonly isRecursive: boolean;
	readonly tableDescriptor: TableDescriptor;
}

/**
 * Plan node for Common Table Expressions (CTEs).
 * This represents a single CTE definition within a WITH clause.
 */
export class CTENode extends PlanNode implements CTEPlanNode {
	readonly nodeType = PlanNodeType.CTE;
	readonly tableDescriptor: TableDescriptor = {}; // Identity object for table context lookup

	private attributesCache: Cached<Attribute[]>;
	private typeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly cteName: string,
		public readonly columns: string[] | undefined,
		public readonly source: RelationalPlanNode,
		public readonly materializationHint: 'materialized' | 'not_materialized' | undefined,
		public readonly isRecursive: boolean = false
	) {
		super(scope, source.getTotalCost() + 10); // Add small overhead for CTE materialization
		this.attributesCache = new Cached(() => this.buildAttributes());
		this.typeCache = new Cached(() => this.buildType());
	}

	private buildAttributes(): Attribute[] {
		const queryAttributes = this.source.getAttributes();

		// Use explicit column names if provided, otherwise use query output column names
		const queryType = this.source.getType();
		const columnNames = this.columns || queryType.columns.map((c: any) => c.name);

		return queryAttributes.map((attr: any, index: number) => ({
			id: PlanNode.nextAttrId(),
			name: columnNames[index] || attr.name,
			type: attr.type,
			sourceRelation: `cte:${this.cteName}`
		}));
	}

	private buildType(): RelationType {
		const queryType = this.source.getType();
		return {
			typeClass: 'relation',
			isReadOnly: false,
			isSet: queryType.isSet, // CTEs preserve the set/bag nature of their query
			columns: this.getAttributes().map((attr: any) => ({
				name: attr.name,
				type: attr.type
			})),
			keys: [], // CTEs don't have inherent keys
			rowConstraints: []
		};
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		return this.typeCache.value;
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			throw new Error(`CTENode expects 0 children, got ${newChildren.length}`);
		}
		return this; // No children in getChildren(), source is accessed via getRelations()
	}

	override toString(): string {
		const recursiveText = this.isRecursive ? 'RECURSIVE ' : '';
		const columnsText = this.columns ? `(${this.columns.join(', ')})` : '';
		const materializationText = this.materializationHint ? ` ${this.materializationHint.toUpperCase()}` : '';
		return `${recursiveText}CTE ${this.cteName}${columnsText}${materializationText}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			cteName: this.cteName,
			columns: this.columns,
			materializationHint: this.materializationHint,
			isRecursive: this.isRecursive,
			queryType: this.getType()
		};
	}
}
