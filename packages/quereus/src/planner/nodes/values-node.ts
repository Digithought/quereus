import type { RelationType } from '../../common/datatype.js';
import type { Scope } from '../scopes/scope.js';
import { PlanNode, type ScalarPlanNode, type ZeroAryRelationalNode, type Attribute } from './plan-node.js';
import { PlanNodeType } from './plan-node-type.js';
import { Cached } from '../../util/cached.js';
import { formatScalarType } from '../../util/plan-formatter.js';

/**
 * Represents a VALUES clause, producing a relation from literal rows.
 */
export class ValuesNode extends PlanNode implements ZeroAryRelationalNode {
  override readonly nodeType = PlanNodeType.Values;

  private outputTypeCache: Cached<RelationType>;
  private attributesCache: Cached<Attribute[]>;

  constructor(
    scope: Scope,
    // Each inner array is a row, consisting of ScalarPlanNodes for each cell.
    public readonly rows: ReadonlyArray<ReadonlyArray<ScalarPlanNode>>,
    // Optional column names - if not provided, defaults to column_0, column_1, etc.
    public readonly columnNames?: ReadonlyArray<string>,
    estimatedCostOverride?: number
  ) {
    super(scope, estimatedCostOverride ?? rows.length * 0.01); // Small cost per row

    this.outputTypeCache = new Cached(() => this.buildOutputType());
    this.attributesCache = new Cached(() => this.buildAttributes());
  }

  private buildOutputType(): RelationType {
    if (this.rows.length === 0) {
      return {
        typeClass: 'relation',
        isReadOnly: true,
        isSet: true,
        columns: [],
        keys: [],
        rowConstraints: [],
      };
    }

    // Infer column types from the first row
    const firstRow = this.rows[0];
    const columns = firstRow.map((expr, index) => ({
      name: this.columnNames?.[index] ?? `column_${index}`,
      type: expr.getType(),
      generated: false,
    }));

    return {
      typeClass: 'relation',
      isReadOnly: true,
      isSet: false, // VALUES can have duplicate rows
      columns,
      keys: [], // VALUES doesn't have inherent keys
      rowConstraints: [],
    };
  }

  private buildAttributes(): Attribute[] {
    if (this.rows.length === 0) {
      return [];
    }

    // Create attributes for each column
    const firstRow = this.rows[0];
    return firstRow.map((expr, index) => ({
      id: PlanNode.nextAttrId(),
      name: this.columnNames?.[index] ?? `column_${index}`,
      type: expr.getType(),
      sourceRelation: `${this.nodeType}:${this.id}`
    }));
  }

  getType(): RelationType {
    return this.outputTypeCache.value;
  }

  getAttributes(): Attribute[] {
    return this.attributesCache.value;
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
    return `VALUES (${this.rows.length} rows)`;
  }

  override getLogicalProperties(): Record<string, unknown> {
    if (this.rows.length === 0) {
      return {
        rows: [],
        numRows: 0
      };
    }

    const firstRow = this.rows[0];
    return {
      numRows: this.rows.length,
      numColumns: firstRow.length,
      columnTypes: firstRow.map(expr => formatScalarType(expr.getType())),
      rows: this.rows.map(row =>
        row.map(expr => expr.toString())
      )
    };
  }
}
