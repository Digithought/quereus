import { PlanNode, type ZeroAryRelationalNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { SqlDataType } from '../../common/types.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { ViewSchema } from '../../schema/view.js';
import { Cached } from '../../util/cached.js';

/**
 * Plan node for referencing a view in a FROM clause.
 * This expands to the view's underlying SELECT statement.
 */
export class ViewReferenceNode extends PlanNode implements ZeroAryRelationalNode {
	readonly nodeType = PlanNodeType.TableReference;

	private attributesCache: Cached<Attribute[]>;
	private typeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly viewSchema: ViewSchema,
		public readonly alias?: string
	) {
		super(scope, 10); // Low cost since views are just query substitution
		this.attributesCache = new Cached(() => this.buildAttributes());
		this.typeCache = new Cached(() => this.buildType());
	}

	private buildAttributes(): Attribute[] {
		// For now, we'll create attributes based on the view's SELECT statement
		// In a full implementation, this should be derived from the planned SELECT
		// For simplicity, we'll assume the view has been planned elsewhere and use column names
		const viewColumns = this.viewSchema.columns || [];
		return viewColumns.map((columnName: string) => ({
			id: PlanNode.nextAttrId(),
			name: columnName,
			type: {
				typeClass: 'scalar' as const,
				affinity: SqlDataType.TEXT,
				nullable: true,
				isReadOnly: false
			}, // Default type, should be inferred
			sourceRelation: `view:${this.viewSchema.name}`
		}));
	}

	private buildType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: false,
			isSet: false, // Views can contain duplicates unless they have DISTINCT
			columns: this.getAttributes().map((attr: any) => ({
				name: attr.name,
				type: attr.type
			})),
			keys: [], // Views don't have inherent keys
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

	getRelations(): readonly [] {
		return [];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			throw new Error(`ViewReferenceNode expects 0 children, got ${newChildren.length}`);
		}
		return this; // No children, so no change
	}

	override toString(): string {
		const aliasText = this.alias ? ` AS ${this.alias}` : '';
		return `VIEW ${this.viewSchema.schemaName}.${this.viewSchema.name}${aliasText}`;
	}

	override getLogicalProperties(): Record<string, unknown> {
		return {
			viewName: this.viewSchema.name,
			schemaName: this.viewSchema.schemaName,
			alias: this.alias,
			columns: this.viewSchema.columns
		};
	}
}
