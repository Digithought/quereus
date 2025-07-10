import { PlanNode, type RelationalPlanNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { CTEPlanNode } from './cte-node.js';
import { Cached } from '../../util/cached.js';

/**
 * Plan node for referencing a CTE in a FROM clause.
 * This points to a materialized CTE result.
 */
export class CTEReferenceNode extends PlanNode implements RelationalPlanNode {
	readonly nodeType = PlanNodeType.CTEReference;
	private static nextRefId = 1;
	public readonly referenceId: number;

	// Cache of attributes to avoid regenerating new IDs on each plan rewrite
	private attributesCache: Cached<Attribute[]>;
	private typeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly source: CTEPlanNode,
		public readonly alias?: string,
		/**
		 * Optionally provide an attribute list to preserve attribute IDs across
		 * plan rewrites (e.g. when `withChildren` creates a new instance). When
		 * omitted, a fresh list will be generated the first time it is requested.
		 */
		private readonly existingAttributes?: Attribute[]
	) {
		super(scope, 5); // Low cost since CTEs are materialized
		this.referenceId = CTEReferenceNode.nextRefId++;
		this.attributesCache = new Cached(() => this.existingAttributes ?? this.buildAttributes());
		this.typeCache = new Cached(() => this.buildType());
	}

	private buildAttributes(): Attribute[] {
		// CRITICAL: Always create fresh attribute IDs for each CTE reference instance.
		// Since we now cache CTEReferenceNode instances per alias in buildFrom(),
		// each alias gets its own unique set of attribute IDs that remain consistent
		// throughout the planning and execution phases.
		const relationName = this.alias || this.source.cteName;
		// Only use fresh IDs when we have an alias that differs from the CTE name
		const useFreshIds = this.alias !== undefined && this.alias.toLowerCase() !== this.source.cteName.toLowerCase();
		return this.source.getAttributes().map((attr: any) => ({
			id: useFreshIds ? PlanNode.nextAttrId() : attr.id,
			name: attr.name,
			type: attr.type,
			sourceRelation: `cte_ref:${this.source.cteName}`,
			relationName
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

	getChildren(): readonly [CTEPlanNode] {
		return [this.source];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 1) {
			throw new Error(`CTEReferenceNode expects 1 child, got ${newChildren.length}`);
		}

		const [newSource] = newChildren;

		// Type check
		if (newSource.nodeType !== PlanNodeType.CTE && newSource.nodeType !== PlanNodeType.RecursiveCTE) {
			throw new Error(`CTEReferenceNode: child (${newSource.nodeType}) must be a CTEPlanNode`);
		}

		// Return same instance if nothing changed
		if (newSource === this.source) {
			return this;
		}

		// Create new instance with updated source
		return new CTEReferenceNode(
			this.scope,
			newSource as CTEPlanNode,
			this.alias,
			// Preserve the original attribute list so IDs remain stable across rewrites
			this.getAttributes()
		);
	}

	override toString(): string {
		const aliasText = this.alias ? ` AS ${this.alias}` : '';
		return `CTE_REF ${this.source.cteName}${aliasText}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			cteName: this.source.cteName,
			alias: this.alias,
			materializationHint: this.source.materializationHint
		};
	}
}
