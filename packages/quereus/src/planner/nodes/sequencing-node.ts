import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type Attribute, type RelationalPlanNode, type UnaryRelationalNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { Cached } from '../../util/cached.js';
import { SqlDataType } from '../../common/types.js';

/**
 * Represents a sequencing operation that adds a row number column to convert bags to sets.
 * This ensures uniqueness for operations that require set semantics.
 * The added column is typically projected away after use and not visible to the user.
 */
export class SequencingNode extends PlanNode implements UnaryRelationalNode {
	override readonly nodeType = PlanNodeType.Sequencing;

	private outputTypeCache: Cached<RelationType>;

	constructor(
		scope: Scope,
		public readonly source: RelationalPlanNode,
		public readonly sequenceColumnName: string = '__row_seq',
		estimatedCostOverride?: number
	) {
		super(scope, estimatedCostOverride);

		this.outputTypeCache = new Cached(() => {
			const sourceType = this.source.getType();

			// Add a sequence column to make this a set
			const sequenceColumn = {
				name: this.sequenceColumnName,
				type: {
					typeClass: 'scalar' as const,
					affinity: SqlDataType.INTEGER,
					nullable: false,
					isReadOnly: true
				},
				generated: true
			};

			// Create a unique key based on all columns including the sequence
			// This guarantees the result is a set
			const allColumnsKey = sourceType.columns.map((_, index) => ({ index }))
				.concat([{ index: sourceType.columns.length }]); // Include sequence column

			return {
				typeClass: 'relation',
				isReadOnly: sourceType.isReadOnly,
				isSet: true, // This operation guarantees set semantics
				columns: [...sourceType.columns, sequenceColumn],
				keys: [allColumnsKey], // All columns including sequence form a unique key
				rowConstraints: sourceType.rowConstraints,
			} as RelationType;
		});
	}

	getType(): RelationType {
		return this.outputTypeCache.value;
	}

	getAttributes(): Attribute[] {
		// Sort preserves the same attributes as its source
		return this.source.getAttributes();
	}

	getChildren(): readonly [] {
		return [];
	}

	getRelations(): readonly [RelationalPlanNode] {
		return [this.source];
	}

	get estimatedRows(): number | undefined {
		return this.source.estimatedRows; // Sequencing doesn't change row count
	}

	override toString(): string {
		return `${this.nodeType}(${this.sequenceColumnName}) from (${this.source.toString()})`;
	}
}
