import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type ScalarPlanNode, type ZeroAryRelationalNode } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { Cached } from '../../util/cached.js';

/**
 * Represents a VALUES clause, producing a relation from literal rows.
 */
export class ValuesNode extends PlanNode implements ZeroAryRelationalNode {
  override readonly nodeType = PlanNodeType.Values;

  private outputTypeCache: Cached<RelationType>;

  constructor(
    scope: Scope,
    // Each inner array is a row, consisting of ScalarPlanNodes for each cell.
    public readonly rows: ReadonlyArray<ReadonlyArray<ScalarPlanNode>>,
    estimatedCostOverride?: number
  ) {
    super(scope, estimatedCostOverride ?? rows.length * 0.01); // Small cost per row

    this.outputTypeCache = new Cached(() => {
      if (this.rows.length === 0) {
        return {
          typeClass: 'relation',
          isReadOnly: true,
          columns: [],
          keys: [],
          rowConstraints: [],
        };
      }
      // Assume all rows have the same number of columns as the first row
      // and derive column names/types from the first row's expressions.
      const firstRow = this.rows[0];
      return {
        typeClass: 'relation',
        isReadOnly: true,
        columns: firstRow.map((exprNode, i) => ({
          name: `column${i + 1}`, // Default column names like SQLite
          type: exprNode.getType(),
          generated: true, // Values are effectively generated
        })),
        // VALUES clauses don't have inherent keys unless defined by constraints later
        keys: [],
        rowConstraints: [],
      };
    });
  }

  getType(): RelationType {
    return this.outputTypeCache.value;
  }

  getChildren(): readonly ScalarPlanNode[] {
    // All expressions in all rows are children in terms of planning dependencies
    return this.rows.flat();
  }

  getRelations(): readonly [] {
    return [];
  }

  get estimatedRows(): number {
    return this.rows.length;
  }

  override toString(): string {
    const rowStrings = this.rows.map(row =>
      `(${row.map(expr => expr.toString()).join(', ')})`
    );
    return `${this.nodeType} (${rowStrings.join(', ')})`;
  }
}
