import { PlanNodeType } from './plan-node-type.js';
import { PlanNode, type RelationalPlanNode, type ScalarPlanNode, type Attribute } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import type { FunctionSchema } from '../../schema/function.js';
import { isTableValuedFunctionSchema } from '../../schema/function.js';
import { Cached } from '../../util/cached.js';
import { formatExpressionList } from '../../util/plan-formatter.js';

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
      // Create attributes from function schema return type
      if (isTableValuedFunctionSchema(this.functionSchema)) {
        return this.functionSchema.returnType.columns.map((col) => ({
          id: PlanNode.nextAttrId(),
          name: col.name,
          type: col.type,
          sourceRelation: `${this.functionName}()`
        }));
      }
      return [];
    });
  }

  getType(): RelationType {
    // Return the function's defined return type
    if (isTableValuedFunctionSchema(this.functionSchema)) {
      return this.functionSchema.returnType;
    }

    // Fallback for non-table-valued functions (shouldn't happen)
    return {
      typeClass: 'relation',
      isReadOnly: true,
      isSet: false, // Table functions can return duplicate rows (bags)
      columns: [],
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

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== this.operands.length) {
      throw new Error(`TableFunctionCallNode expects ${this.operands.length} children, got ${newChildren.length}`);
    }

    // Type check
    for (const child of newChildren) {
      if (!('expression' in child)) {
        throw new Error('TableFunctionCallNode: all children must be ScalarPlanNodes');
      }
    }

    // Check if anything changed
    const childrenChanged = newChildren.some((child, i) => child !== this.operands[i]);
    if (!childrenChanged) {
      return this;
    }

    // Create new instance
    return new TableFunctionCallNode(
      this.scope,
      this.functionName,
      this.functionSchema,
      newChildren as ScalarPlanNode[],
      this.alias
    );
  }

  get estimatedRows(): number | undefined {
    // Functions can return variable numbers of rows, so we'll use a default estimate
    return 10; // Conservative estimate
  }

  override toString(): string {
    const argsStr = formatExpressionList(this.operands);
    const aliasStr = this.alias ? ` AS ${this.alias}` : '';
    return `${this.functionName}(${argsStr})${aliasStr}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    const props: Record<string, unknown> = {
      function: this.functionName,
      arguments: this.operands.map(op => op.toString())
    };

    if (this.alias) {
      props.alias = this.alias;
    }

    if (isTableValuedFunctionSchema(this.functionSchema)) {
      props.columns = this.functionSchema.returnType.columns.map(col => col.name);
    }

    return props;
  }
}
