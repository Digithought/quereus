import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { BaseType, RelationType, ScalarType } from '../../common/datatype.js';
import type { Expression } from '../../parser/ast.js';

/**
 * Physical properties that execution nodes can provide or require
 */
export interface PhysicalProperties {
  /** Ordering of rows. Each element is a column index, negative for DESC */
  ordering?: { column: number; desc: boolean }[];
  /** Estimated number of rows */
  estimatedRows?: number;
  /** Whether rows are unique on certain columns */
  uniqueKeys?: number[][];
}

/**
 * Base class for all nodes in the logical query plan.
 * PlanNodes are immutable once constructed.
 */
export abstract class PlanNode {
  private static nextId = 0;
  readonly id: string;
  abstract readonly nodeType: PlanNodeType;

  /** Present if the node is a physical plan node */
  physical?: PhysicalProperties;

  constructor(
		/** The scope in which this node is planned.  Note that this captures references made through it, so you can tell if a node has dependencies. */
    public readonly scope: Scope,
	  /** Estimated cost to execute this node itself (excluding its children). */
		public readonly estimatedCost = 0.01

	) {
    this.id = `${PlanNode.nextId++}`;
  }

  abstract getType(): BaseType;
  abstract getChildren(): readonly PlanNode[];
	abstract getRelations(): readonly RelationalPlanNode[];

	getTotalCost(): number {
		return (this.estimatedCost + this.getChildren().reduce((acc, child) => acc + child.getTotalCost(), 0))
			* (this.getRelations().reduce((acc, relation) => acc + relation.getTotalCost(), 0) || 1);
	}

  visit(visitor: PlanNodeVisitor): void {
    visitor(this);
    this.getChildren().forEach(child => child.visit(visitor));
		this.getRelations().forEach(relation => relation.visit(visitor));
  }

	toString(): string {
		return `${this.nodeType} [${this.id}]`;
	}
}

export type PlanNodeVisitor = (node: PlanNode) => void;

/**
 * Base class for PlanNodes that do not produce a relational or scalar output,
 * typically used for DDL or other side-effecting operations.
 */
export abstract class VoidNode extends PlanNode {
  getType(): BaseType {
    // Indicates a non-relational, non-scalar result, e.g., status object or no output.
    return { typeClass: 'void' };
  }

  getChildren(): readonly PlanNode[] {
    return []; // No direct child plan nodes in the execution sense
  }

	getRelations(): readonly RelationalPlanNode[] {
    return []; // Does not operate on input relations
  }
}

/**
 * Base interface for PlanNodes that produce a relation (a set of rows).
 * Note: this is an interface that concrete RelationalNode classes will implement.
 */
export interface RelationalPlanNode extends PlanNode {
  /** Estimated number of rows this node will output. */
  readonly estimatedRows?: number;

  getType(): RelationType;
}

/**
 * Base interface for PlanNodes that produce a scalar value (Expression Nodes).
 * Note: this is an interface that concrete ScalarNode classes will implement.
 */
export interface ScalarPlanNode extends PlanNode {
	readonly expression: Expression;
  getType(): ScalarType;
}

// --- Arity-based Base Abstractions (Interfaces, to be implemented by concrete node classes) ---

/** A relational plan node that has no relational inputs (a leaf in the relational algebra tree).
 * Will not have scalar inputs either - this is either TableDee or TableDum, projection can be used to compute columns
 */
export interface ZeroAryRelationalNode extends RelationalPlanNode {
  // No specific 'inputs' property at this base level, concrete nodes will define sources.
  getRelations(): readonly [];
}

/** A relational plan node that operates on a single relational input. */
export interface UnaryRelationalNode extends RelationalPlanNode {
  readonly source: RelationalPlanNode;
  getRelations(): readonly [RelationalPlanNode];
}

/** A relational plan node that operates on two relational inputs. */
export interface BinaryRelationalNode extends RelationalPlanNode {
  readonly left: RelationalPlanNode;
  readonly right: RelationalPlanNode;
  getRelations(): readonly [RelationalPlanNode, RelationalPlanNode];
}

/** A scalar plan node that has no scalar inputs (a leaf in an expression tree).
 * May have relational input(s) e.g. EXISTS, IN, etc.
 */
export interface ZeroAryScalarNode extends ScalarPlanNode {
  // No specific 'operands' property at this base level.
  getChildren(): readonly [];
}

/** A scalar plan node that operates on a single scalar input. */
export interface UnaryScalarNode extends ScalarPlanNode {
  readonly operand: ScalarPlanNode;
  getChildren(): readonly [ScalarPlanNode];
}

/** A scalar plan node that operates on two scalar inputs. */
export interface BinaryScalarNode extends ScalarPlanNode {
  readonly left: ScalarPlanNode;
  readonly right: ScalarPlanNode;
  getChildren(): readonly [ScalarPlanNode, ScalarPlanNode];
}

/** A scalar plan node that operates on N scalar inputs. */
export interface NaryScalarNode extends ScalarPlanNode {
  readonly operands: ReadonlyArray<ScalarPlanNode>;
  getChildren(): readonly ScalarPlanNode[];
}
