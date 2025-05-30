import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type { FunctionSchema } from '../../schema/function.js';
import { Cached } from '../../util/cached.js';

/**
 * Represents a table-valued function call in the FROM clause.
 * This produces a relation from a function call like query_plan('SELECT ...').
 */
export class TableFunctionCallNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.TableFunctionCall;

  private attributesCache: Cached<Attribute[]>;

  constructor(
    scope: Scope,
    public readonly functionName: string,
    public readonly functionSchema: FunctionSchema,
    public readonly operands: readonly ScalarPlanNode[],
    public readonly alias?: string,
    estimatedCostOverride?: number
  ) {
    super(scope, estimatedCostOverride ?? 1); // Default cost for function calls

    this.attributesCache = new Cached(() => {
      // Create attributes from function schema columns
      return this.functionSchema.columns?.map((col) => ({
        id: PlanNode.nextAttrId(),
        name: col.name,
        type: {
          typeClass: 'scalar' as const,
          affinity: col.type,
          nullable: col.nullable ?? true,
          isReadOnly: true,
        },
        sourceRelation: `${this.functionName}()`
      })) || [];
    });
  }

  getType(): RelationType {
    // Build the output relation type based on the function schema
    const columns = this.functionSchema.columns?.map((col, index) => ({
      name: col.name,
      type: {
        typeClass: 'scalar' as const,
        affinity: col.type,
        nullable: col.nullable ?? true,
        isReadOnly: true,
      },
      generated: true, // Function results are effectively generated
    })) || [];

    return {
      typeClass: 'relation',
      isReadOnly: true, // Function results are read-only
			// TODO: Have table function schema expose relation type
      isSet: false, // Table functions can return duplicate rows (bags)
      columns,
      keys: [], // Functions don't typically have inherent keys
      rowConstraints: [],
    };
  }

  getAttributes(): Attribute[] {
    return this.attributesCache.value;
  }

  getChildren(): readonly ScalarPlanNode[] {
    return this.operands;
  }

  getRelations(): readonly [] {
    return [];
  }

  get estimatedRows(): number | undefined {
    // Functions can return variable numbers of rows, so we'll use a default estimate
    return 10; // Conservative estimate
  }

  override toString(): string {
    const argsStr = this.operands.map(op => op.toString()).join(', ');
    const aliasStr = this.alias ? ` as ${this.alias}` : '';
    return `${this.nodeType} (${this.functionName}(${argsStr}))${aliasStr}`;
  }
}
