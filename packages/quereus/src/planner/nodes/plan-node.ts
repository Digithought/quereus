import { PlanNodeType } from './plan-node-type.js';
import type { Scope } from '../scopes/scope.js';
import type { BaseType, RelationType, ScalarType } from '../../common/datatype.js';
import type { Expression } from '../../parser/ast.js';
import type { OutputValue, Row } from '../../common/types.js';
import { quereusError } from '../../common/errors.js';

/**
 * Physical properties that execution nodes can provide or require
 */
export interface PhysicalProperties {
  /** Ordering of rows. Each element is a column index, negative for DESC */
  ordering?: { column: number; desc: boolean }[];

  /** Estimated number of rows this node will produce */
  estimatedRows?: number;

  /**
   * Column sets that are guaranteed unique in the output.
   * Unlike logical keys which are schema-defined, these are derived from
   * the operation (e.g., DISTINCT creates a unique key on all columns)
   */
  uniqueKeys?: number[][];

  /**
   * Whether this node is read-only (does not mutate external state).
   * false = has side effects, true = pure/read-only
   */
  readonly?: boolean;

  /**
   * Whether this node is deterministic - same inputs always produce same outputs.
   * Non-deterministic examples: random(), now(), sequence generators
   */
  deterministic?: boolean;

  /**
   * Whether this node is idempotent - calling twice in same transaction
   * leaves state as if called once. Only meaningful for non-readonly nodes.
   * Examples: INSERT with IGNORE, UPDATE with same values
   */
  idempotent?: boolean;

  /**
   * Whether this node directly produces a constant result (deterministic, readonly, and no dependencies).
	 * If this is true, the node should implement getValue() to return the constant value.
   */
  constant?: boolean;
}

// Derived properties (computed, not stored):
// functional = deterministic && readonly (safe for constant folding)
// sideEffects = !readonly (mutates external state)

/**
 * Default physical properties for plan nodes
 */
export const DEFAULT_PHYSICAL: PhysicalProperties = {
	deterministic: true,
	readonly: true,
	idempotent: true, // Default true for readonly nodes
	constant: false,
} as const;

/**
 * Represents a column with a unique identifier that persists across plan transformations
 */
export interface Attribute {
  /** Globally unique identifier for this column */
  id: number;
  /** Human-readable name (may not be unique) */
  name: string;
  /** Data type information */
  type: ScalarType;
  /** Source relation that originally produced this column */
  sourceRelation?: string;
  /** Relation name for qualified access (e.g. table name or alias) */
  relationName?: string;
}

/**
 * Row descriptor that maps attribute IDs to column indices in a row array
 */
export type RowDescriptor = number[]; // attributeId → columnIndex

/**
 * Function that returns a row when called
 */
export type RowGetter = () => Row;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type TableDescriptor = {
	// Just using the object's identity for now
};

export type TableGetter = () => AsyncIterable<Row>;

/**
 * Base class for all nodes in the logical query plan.
 * PlanNodes are immutable once constructed.
 */
export abstract class PlanNode {
  private static nextId = 0;
  private static nextAttributeId = 0;

  readonly id: string;
  abstract readonly nodeType: PlanNodeType;

  /** Present if the node is a physical plan node */
  private _physical?: PhysicalProperties;

  constructor(
		/** The scope in which this node is planned. */
    public readonly scope: Scope,
	  /** Estimated cost to execute this node itself (excluding its children). */
		public readonly estimatedCost = 0.01

	) {
    this.id = `${PlanNode.nextId++}`;
  }

  abstract getType(): BaseType;
  abstract getChildren(): readonly PlanNode[];

  /**
   * Default implementation of getRelations() that filters getChildren()
   * Can be overridden for performance if needed
   */
	getRelations(): readonly RelationalPlanNode[] {
    return this.getChildren()
    	.filter(isRelationalNode);
  }

  /**
   * Return this node with its children replaced by newChildren.
   * MUST keep attribute IDs stable unless the concrete node deliberately produces new columns.
   *
   * Implementations must:
   *   1. Verify arity (throw if length mismatch)
   *   2. Return `this` if nothing changed
   *   3. Otherwise construct a new instance copying all immutable properties
   */
  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;

  /**
   * Compute physical property overrides for this node
   * Called by the optimizer when converting logical to physical nodes.
   * @param children Physical properties of optimized children
   */
  computePhysical?(children: readonly PhysicalProperties[]): Partial<PhysicalProperties>;

  /**
   * Get the attributes (columns) produced by this relational node
   */
  getAttributes?(): readonly Attribute[];

  /**
   * Get map of attribute ID to producing scalar expression (for constant folding)
   * Only relational nodes that synthesize columns from expressions need implement this
   */
  getProducingExprs?(): Map<number, ScalarPlanNode>;

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

	/**
   * Get logical properties for this node.
   * Override to provide node-specific logical information.
   */
  getLogicalAttributes(): Record<string, unknown> {
    return {};
  }

	/** Infer and cache the physical properties of this node */
	get physical(): PhysicalProperties {
		if (!this._physical) {
			const childrenPhysical = this.getChildren().map(child => child.physical);

			// Get the node-specific overrides
			const propsOverride = this.computePhysical?.(childrenPhysical);

			// Derive defaults from children if there are any, else leaf defaults
			const defaults = childrenPhysical.length
				? {
					deterministic: childrenPhysical.every(child => child.deterministic),
					idempotent: childrenPhysical.every(child => child.idempotent),
					readonly: childrenPhysical.every(child => child.readonly),
					// constant: DON'T INHERIT - only ValueNodes can be directly constant
				}
				: DEFAULT_PHYSICAL;

			this._physical = { ...defaults, ...propsOverride };
		}
		return this._physical;
	}

  /** Helper to generate unique attribute IDs */
  public static nextAttrId(): number {
    return PlanNode.nextAttributeId++;
  }

  /**
   * Check if a node is functional (pure and deterministic), safe for constant folding
   */
  public static isFunctional(physical: PhysicalProperties): boolean {
    return (physical.deterministic !== false) && (physical.readonly !== false);
  }

  /**
   * Check if a node has side effects (mutates external state)
   */
  public static hasSideEffects(physical: PhysicalProperties): boolean {
    return physical.readonly === false;
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

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
      quereusError(`${this.nodeType} expects 0 children, got ${newChildren.length}`);
    }
    return this; // No children, so no change
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

  /**
   * Get the attributes (columns) produced by this relational node
   * Each attribute has a unique ID that persists across plan transformations
   */
  getAttributes(): readonly Attribute[];
}

/**
 * Check if a node is relational (can be cached)
 */
export function isRelationalNode(node: PlanNode): node is RelationalPlanNode {
	return node.getType().typeClass === 'relation';
}

/**
 * Base interface for PlanNodes that produce a scalar value (Expression Nodes).
 * Note: this is an interface that concrete ScalarNode classes will implement.
 */
export interface ScalarPlanNode extends PlanNode {
	readonly expression: Expression;
  getType(): ScalarType;
}

/**
 * Check if a node is a scalar node
 */
export function isScalarNode(node: PlanNode): node is ScalarPlanNode {
	return node.getType().typeClass === 'scalar';
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

/** A scalar plan node that operates on three scalar inputs. */
export interface TernaryScalarNode extends ScalarPlanNode {
  getChildren(): readonly [ScalarPlanNode, ScalarPlanNode, ScalarPlanNode];
}

/** A scalar plan node that operates on N scalar inputs. */
export interface NaryScalarNode extends ScalarPlanNode {
  readonly operands: ReadonlyArray<ScalarPlanNode>;
  getChildren(): readonly ScalarPlanNode[];
}

// --- Concrete Arity-Based Base Classes ---

/**
 * Base class for relational nodes with no relational inputs (leaf nodes)
 */
export abstract class ZeroAryRelationalBase extends PlanNode implements ZeroAryRelationalNode {
  abstract getType(): RelationType;
  abstract getAttributes(): readonly Attribute[];

  getChildren(): readonly PlanNode[] {
    return [];
  }

  getRelations(): readonly [] {
    return [];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
			quereusError(`${this.nodeType} expects 0 children, got ${newChildren.length}`);
    }
    return this;
  }
}

/**
 * Base class for relational nodes with one relational input
 */
export abstract class UnaryRelationalBase extends PlanNode implements UnaryRelationalNode {
  abstract readonly source: RelationalPlanNode;
  abstract getType(): RelationType;
  abstract getAttributes(): readonly Attribute[];

  getChildren(): readonly PlanNode[] {
    return [this.source];
  }

  getRelations(): readonly [RelationalPlanNode] {
    return [this.source];
  }

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * Base class for relational nodes with two relational inputs
 */
export abstract class BinaryRelationalBase extends PlanNode implements BinaryRelationalNode {
  abstract readonly left: RelationalPlanNode;
  abstract readonly right: RelationalPlanNode;
  abstract getType(): RelationType;
  abstract getAttributes(): readonly Attribute[];

  getChildren(): readonly PlanNode[] {
    return [this.left, this.right];
  }

  getRelations(): readonly [RelationalPlanNode, RelationalPlanNode] {
    return [this.left, this.right];
  }

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * Base class for scalar nodes with no scalar inputs (leaf expressions)
 */
export abstract class ZeroAryScalarBase extends PlanNode implements ZeroAryScalarNode {
  abstract readonly expression: Expression;
  abstract getType(): ScalarType;

  getChildren(): readonly [] {
    return [];
  }

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 0) {
      quereusError(`${this.nodeType} expects 0 children, got ${newChildren.length}`);
    }
    return this;
  }
}

/**
 * Base class for scalar nodes with one scalar input
 */
export abstract class UnaryScalarBase extends PlanNode implements UnaryScalarNode {
  abstract readonly operand: ScalarPlanNode;
  abstract readonly expression: Expression;
  abstract getType(): ScalarType;

  getChildren(): readonly [ScalarPlanNode] {
    return [this.operand];
  }

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * Base class for scalar nodes with two scalar inputs
 */
export abstract class BinaryScalarBase extends PlanNode implements BinaryScalarNode {
  abstract readonly left: ScalarPlanNode;
  abstract readonly right: ScalarPlanNode;
  abstract readonly expression: Expression;
  abstract getType(): ScalarType;

  getChildren(): readonly [ScalarPlanNode, ScalarPlanNode] {
    return [this.left, this.right];
  }

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * Base class for scalar nodes with three scalar inputs
 */
export abstract class TernaryScalarBase extends PlanNode implements TernaryScalarNode {
  abstract readonly expression: Expression;
  abstract getType(): ScalarType;
  abstract getChildren(): readonly [ScalarPlanNode, ScalarPlanNode, ScalarPlanNode];

  withChildren(newChildren: readonly PlanNode[]): PlanNode {
    if (newChildren.length !== 3) {
      quereusError(`${this.nodeType} expects 3 children, got ${newChildren.length}`);
    }
    return this;
  }
}

/**
 * Base class for scalar nodes with N scalar inputs
 */
export abstract class NaryScalarBase extends PlanNode implements NaryScalarNode {
  abstract readonly operands: ReadonlyArray<ScalarPlanNode>;
  abstract readonly expression: Expression;
  abstract getType(): ScalarType;

  getChildren(): readonly ScalarPlanNode[] {
    return this.operands;
  }

  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}

/**
 * A node that directly produces a constant result (deterministic, readonly, and no dependencies).
 * If the node is constant (literal value), it should implement getValue() to return the constant value.
 */
export interface ConstantNode extends PlanNode {
	getValue(): OutputValue;
}
