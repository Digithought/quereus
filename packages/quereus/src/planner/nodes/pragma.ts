import { SqlDataType, type SqlValue } from '../../common/types.js';
import * as AST from '../../parser/ast.js';
import { Attribute, type RelationalPlanNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { expressionToString } from '../../util/ast-stringify.js';
import { PlanNode } from './plan-node.js';
import { RelationType } from '../../common/datatype.js';
import { Scope } from '../scopes/scope.js';

export class PragmaPlanNode extends PlanNode implements RelationalPlanNode {
	override readonly nodeType = PlanNodeType.Pragma;

	constructor(
		scope: Scope,
		public readonly pragmaName: string,
		public readonly statementAst: AST.PragmaStmt,
		public readonly value?: SqlValue
	) {
		super(scope, 1); // PRAGMA operations have low cost
	}

	getType(): RelationType {
		return {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: true,
			columns: [
				{
					name: "name",
					type: {
						typeClass: 'scalar',
						affinity: SqlDataType.TEXT,
						nullable: false,
						isReadOnly: true,
					},
					generated: true,
				},
				{
					name: "value",
					type: {
						typeClass: 'scalar',
						affinity: SqlDataType.TEXT,
						nullable: false,
					},
					generated: true,
				},
			],
			keys: [[]],
			rowConstraints: [],
		};
	}

	get estimatedRows(): number | undefined {
		return 1;
	}

	getAttributes(): Attribute[] {
		return this.getType().columns.map((column) => (
			{
				id: PlanNode.nextAttrId(),
				name: column.name, // Use the deduplicated name
				type: column.type,
				sourceRelation: `${this.nodeType}:${this.id}`
			} satisfies Attribute
		));
	}

	getChildren(): PlanNode[] {
		return [];
	}

	withChildren(_newChildren: readonly PlanNode[]): PlanNode {
		return new PragmaPlanNode(this.scope, this.pragmaName, this.statementAst, this.value);
	}

	override toString(): string {
		if (this.value !== undefined) {
			return `PRAGMA ${this.pragmaName} = ${this.value}`;
		}
		return `PRAGMA ${this.pragmaName}`;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const props: Record<string, unknown> = {
			type: 'pragma',
			name: this.statementAst.name,
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			statement: expressionToString(this.statementAst as any)
		};

		if (this.value !== undefined) {
			props.value = this.value;
		}

		return props;
	}
}
