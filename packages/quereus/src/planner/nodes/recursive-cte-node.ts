import { PlanNode, type RelationalPlanNode, type Attribute, type TableDescriptor, isRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import type { CTEPlanNode } from './cte-node.js';

/**
 * Plan node for Recursive Common Table Expressions.
 * This handles the special structure of recursive CTEs with base and recursive cases.
 */
export class RecursiveCTENode extends PlanNode implements CTEPlanNode {
	readonly nodeType = PlanNodeType.RecursiveCTE;
	readonly isRecursive = true; // Always true for recursive CTEs
	readonly tableDescriptor: TableDescriptor;

	private attributesCache: Cached<Attribute[]>;
	private typeCache: Cached<RelationType>;
	private _recursiveCaseQuery: RelationalPlanNode;

	constructor(
		scope: Scope,
		public readonly cteName: string,
		public readonly columns: string[] | undefined,
		public readonly baseCaseQuery: RelationalPlanNode,
		recursiveCaseQuery: RelationalPlanNode,
		public readonly isUnionAll: boolean,
		public readonly materializationHint: 'materialized' | 'not_materialized' | undefined = 'materialized',
		public readonly maxRecursion?: number,
		tableDescriptor?: TableDescriptor
	) {
		super(scope, baseCaseQuery.getTotalCost() + recursiveCaseQuery.getTotalCost() + 50); // Higher cost for recursion
		this._recursiveCaseQuery = recursiveCaseQuery;
		this.tableDescriptor = tableDescriptor || {}; // Identity object for table context lookup
		this.attributesCache = new Cached(() => this.buildAttributes());
		this.typeCache = new Cached(() => this.buildType());
	}

	get recursiveCaseQuery(): RelationalPlanNode {
		return this._recursiveCaseQuery;
	}

	/**
	 * Sets the recursive case query after construction.
	 * This is needed to handle the circular dependency during planning.
	 */
	setRecursiveCaseQuery(query: RelationalPlanNode): void {
		this._recursiveCaseQuery = query;
		// Clear caches since they might depend on the recursive case
		this.attributesCache = new Cached(() => this.buildAttributes());
		this.typeCache = new Cached(() => this.buildType());
	}

	private buildAttributes(): Attribute[] {
		// Use the base case query's attributes as the template
		const baseCaseAttributes = this.baseCaseQuery.getAttributes();

		// Use explicit column names if provided, otherwise use base case column names
		const baseCaseType = this.baseCaseQuery.getType();
		const columnNames = this.columns || baseCaseType.columns.map((c: any) => c.name);

		return baseCaseAttributes.map((attr: any, index: number) => ({
			id: attr.id, // Preserve original attribute ID for proper context resolution
			name: columnNames[index] || attr.name,
			type: attr.type,
			sourceRelation: `recursive_cte:${this.cteName}`
		}));
	}

	private buildType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: false,
			isSet: !this.isUnionAll, // UNION creates a set, UNION ALL creates a bag
			columns: this.getAttributes().map((attr: any) => ({
				name: attr.name,
				type: attr.type
			})),
			keys: [], // Recursive CTEs don't have inherent keys
			rowConstraints: []
		};
	}

	getAttributes(): Attribute[] {
		return this.attributesCache.value;
	}

	getType(): RelationType {
		return this.typeCache.value;
	}

	getChildren(): readonly [RelationalPlanNode, RelationalPlanNode] {
		return [this.baseCaseQuery, this.recursiveCaseQuery];
	}

	// For recursive CTEs, we consider the base case as the primary source
	get source(): RelationalPlanNode {
		return this.baseCaseQuery;
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.baseCaseQuery];
	}

	withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 2) {
			throw new Error(`RecursiveCTENode expects 2 children, got ${newChildren.length}`);
		}

		const [newBaseCaseQuery, newRecursiveCaseQuery] = newChildren;

		// Type check
		if (!isRelationalNode(newBaseCaseQuery) || !isRelationalNode(newRecursiveCaseQuery)) {
			throw new Error('RecursiveCTENode: children must be RelationalPlanNodes');
		}

		// Return same instance if nothing changed
		if (newBaseCaseQuery === this.baseCaseQuery && newRecursiveCaseQuery === this.recursiveCaseQuery) {
			return this;
		}

		// Create new instance with updated children
		const newNode = new RecursiveCTENode(
			this.scope,
			this.cteName,
			this.columns,
			newBaseCaseQuery as RelationalPlanNode,
			newRecursiveCaseQuery as RelationalPlanNode,
			this.isUnionAll,
			this.materializationHint,
			this.maxRecursion,
			this.tableDescriptor
		);

		return newNode;
	}

	override toString(): string {
		const recursiveText = 'RECURSIVE ';
		const columnsText = this.columns ? `(${this.columns.join(', ')})` : '';
		const unionText = this.isUnionAll ? 'UNION ALL' : 'UNION';
		const materializationText = this.materializationHint ? ` ${this.materializationHint.toUpperCase()}` : '';
		return `${recursiveText}CTE ${this.cteName}${columnsText} [${unionText}]${materializationText}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		return {
			cteName: this.cteName,
			columns: this.columns,
			isUnionAll: this.isUnionAll,
			materializationHint: this.materializationHint,
			isRecursive: true,
			maxRecursion: this.maxRecursion,
			baseCaseType: this.baseCaseQuery.getType(),
			recursiveCaseType: this.recursiveCaseQuery.getType()
		};
	}
}
