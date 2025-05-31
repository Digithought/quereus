import { PlanNode, type UnaryRelationalNode, type RelationalPlanNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { CTEPlanNode } from './cte-node.js';
import { Cached } from '../../util/cached.js';

/**
 * Plan node for referencing a CTE in a FROM clause.
 * This points to a materialized CTE result.
 */
export class CTEReferenceNode extends PlanNode implements UnaryRelationalNode {
	readonly nodeType = PlanNodeType.TableReference; // Reuse table reference type

	private attributesCache: Cached<Attribute[]>;
	private typeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly source: CTEPlanNode,
		public readonly alias?: string
	) {
		super(scope, 5); // Low cost since CTEs are materialized
		this.attributesCache = new Cached(() => this.buildAttributes());
		this.typeCache = new Cached(() => this.buildType());
	}

	private buildAttributes(): Attribute[] {
		// Create new attribute IDs for the CTE reference to ensure proper isolation
		return this.source.getAttributes().map((attr: any) => ({
			id: PlanNode.nextAttrId(),
			name: attr.name,
			type: attr.type,
			sourceRelation: `cte_ref:${this.source.cteName}`
		}));
	}

	private buildType(): RelationType {
		const cteType = this.source.getType();
		return {
			typeClass: 'relation',
			isReadOnly: false,
			isSet: cteType.isSet,
			columns: this.getAttributes().map((attr: any) => ({
				name: attr.name,
				type: attr.type
			})),
			keys: [], // CTE references don't have inherent keys
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

	override toString(): string {
		const aliasText = this.alias ? ` AS ${this.alias}` : '';
		return `CTE_REF ${this.source.cteName}${aliasText}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			cteName: this.source.cteName,
			alias: this.alias,
			materializationHint: this.source.materializationHint
		};
	}
}
