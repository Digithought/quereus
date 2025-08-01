import type { Scope } from '../scopes/scope.js';
import { PlanNode, type RelationalPlanNode, type Attribute, isRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import type { ScalarPlanNode } from './plan-node.js';
import type { RelationType } from '../../common/datatype.js';
import { ColumnReferenceNode } from './reference.js';
import { expressionToString } from '../../util/ast-stringify.js';
import { Cached } from '../../util/cached.js';

export interface ReturningProjection {
  node: ScalarPlanNode;
  alias?: string;
  /** Optional predefined attribute ID to preserve during optimization */
  attributeId?: number;
}

/**
 * Represents a RETURNING clause that projects rows from a DML operation.
 * The executor performs the DML operation and yields the affected rows.
 */
export class ReturningNode extends PlanNode implements RelationalPlanNode {
  override readonly nodeType = PlanNodeType.Returning;

  private outputTypeCache: Cached<RelationType>;
  private attributesCache: Cached<readonly Attribute[]>;

  constructor(
    scope: Scope,
    public readonly executor: RelationalPlanNode, // The DML operation that yields affected rows
    public readonly projections: ReadonlyArray<ReturningProjection>,
    /** Optional predefined attributes for preserving IDs during optimization */
    predefinedAttributes?: readonly Attribute[]
  ) {
    super(scope);

    this.outputTypeCache = new Cached(() => this.buildOutputType());
    this.attributesCache = new Cached(() => {
      // If predefined attributes are provided, use them (for optimization)
      if (predefinedAttributes) {
        return predefinedAttributes.slice(); // Return a copy
      }

      return this.buildAttributes();
    });
  }

  private buildOutputType(): RelationType {
    // Return type is based on the projections, similar to ProjectNode
    // Build column names with proper duplicate handling
    const columnNames: string[] = [];
    const nameCount = new Map<string, number>();

    const columns = this.projections.map((proj) => {
      // Determine base column name
      let baseName: string;
      if (proj.alias) {
        baseName = proj.alias.toLowerCase();
      } else if (proj.node instanceof ColumnReferenceNode) {
        // For column references, check if there's a table qualifier (like NEW or OLD)
        const expr = proj.node.expression;
        if (expr.table) {
          // Use qualified name for NEW.id, OLD.id, etc., normalized to lowercase
          baseName = `${expr.table.toLowerCase()}.${expr.name.toLowerCase()}`;
        } else {
          // Use the unqualified column name, normalized to lowercase
          baseName = expr.name.toLowerCase();
        }
      } else {
        // For expressions, use the string representation
        baseName = expressionToString(proj.node.expression);
      }

      // Handle duplicate names
      let finalName: string;
      const currentCount = nameCount.get(baseName) || 0;
      if (currentCount === 0) {
        // First occurrence - use the base name
        finalName = baseName;
      } else {
        // Subsequent occurrences - add numbered suffix
        finalName = `${baseName}:${currentCount}`;
      }
      nameCount.set(baseName, currentCount + 1);
      columnNames.push(finalName);

      return {
        name: finalName,
        type: proj.node.getType(),
        nullable: true // Conservative assumption
      };
    });

    return {
      typeClass: 'relation',
      columns,
      isSet: this.executor.getType().isSet, // Preserve set/bag semantics
      isReadOnly: false,
      keys: [], // No known keys for returning results
      rowConstraints: [], // No row constraints for returning results
    };
  }

  private buildAttributes(): readonly Attribute[] {
    // Create attributes for the projected columns
    // Get the computed column names from the type
    const outputType = this.getType();

    // For each projection, preserve attribute ID if it's a simple column reference
    return this.projections.map((proj, index) => {
      // Check if projection has a predefined attribute ID
      if (proj.attributeId !== undefined) {
        return {
          id: proj.attributeId,
          name: outputType.columns[index].name,
          type: proj.node.getType(),
          sourceRelation: `${this.nodeType}:${this.id}`
        };
      }

      // If this projection is a simple column reference, preserve its attribute ID
      if (proj.node instanceof ColumnReferenceNode) {
        return {
          id: proj.node.attributeId,
          name: outputType.columns[index].name, // Use the deduplicated name
          type: proj.node.getType(),
          sourceRelation: `${this.nodeType}:${this.id}`
        };
      } else {
        // For computed expressions, generate new attribute ID
        return {
          id: PlanNode.nextAttrId(),
          name: outputType.columns[index].name, // Use the deduplicated name
          type: proj.node.getType(),
          sourceRelation: `${this.nodeType}:${this.id}`
        };
      }
    });
  }

  getType(): RelationType {
    return this.outputTypeCache.value;
  }

  getAttributes(): readonly Attribute[] {
		return this.attributesCache.value;
	}

  getRelations(): readonly RelationalPlanNode[] {
    // Return the executor which is now a RelationalPlanNode
    return [this.executor];
  }

  getChildren(): readonly PlanNode[] {
    // Return executor first, then all projection expressions
    return [this.executor, ...this.projections.map(proj => proj.node)];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    const expectedChildren = 1 + this.projections.length; // executor + projections
    if (newChildren.length !== expectedChildren) {
      throw new Error(`ReturningNode expects ${expectedChildren} children, got ${newChildren.length}`);
    }

    const [newExecutor, ...newProjectionNodes] = newChildren;

    // Type check the executor
    if (!isRelationalNode(newExecutor)) {
      throw new Error('ReturningNode: first child must be a RelationalPlanNode (executor)');
    }

    // Type check projection expressions
    for (let i = 0; i < newProjectionNodes.length; i++) {
      const expr = newProjectionNodes[i];
      if (!('expression' in expr)) {
        throw new Error(`ReturningNode: projection child ${i + 1} must be a ScalarPlanNode`);
      }
    }

    // Check if anything changed
    const executorChanged = newExecutor !== this.executor;
    const projectionsChanged = newProjectionNodes.some((child, i) => child !== this.projections[i].node);

    if (!executorChanged && !projectionsChanged) {
      return this;
    }

    // **CRITICAL**: Preserve original attribute IDs to maintain column reference stability
    const originalAttributes = this.getAttributes();

    // Create new projections with preserved attribute IDs
    const newProjections = this.projections.map((proj, i) => ({
      node: newProjectionNodes[i] as ScalarPlanNode,
      alias: proj.alias,
      attributeId: originalAttributes[i].id // Preserve original attribute ID
    }));

    // Create new instance with preserved attributes
    return new ReturningNode(
      this.scope,
      newExecutor as RelationalPlanNode,
      newProjections,
      originalAttributes // Pass original attributes to preserve IDs
    );
  }

  get estimatedRows(): number | undefined {
    return this.executor.estimatedRows;
  }

  override toString(): string {
    const projList = this.projections.length > 3
      ? `${this.projections.length} columns`
      : this.projections.map(p => p.alias || 'expr').join(', ');
    return `RETURNING ${projList}`;
  }

  override getLogicalAttributes(): Record<string, unknown> {
    return {
      executor: this.executor.nodeType,
      projectionCount: this.projections.length,
      projections: this.projections.map(proj => ({
        alias: proj.alias,
        expression: proj.node.toString()
      }))
    };
  }
}
