import { createLogger } from '../common/logger.js';
import { PlanNode, type RelationalPlanNode, type PhysicalProperties } from './nodes/plan-node.js';
import { PlanNodeType } from './nodes/plan-node-type.js';
import { BlockNode } from './nodes/block.js';
import { AggregateNode } from './nodes/aggregate-node.js';
import { StreamAggregateNode } from './nodes/stream-aggregate.js';
import { SortNode } from './nodes/sort.js';
import { FilterNode } from './nodes/filter.js';
import { DistinctNode } from './nodes/distinct-node.js';
import { SetOperationNode } from './nodes/set-operation-node.js';
import { ProjectNode } from './nodes/project-node.js';
import { LimitOffsetNode } from './nodes/limit-offset.js';
import { WindowNode } from './nodes/window-node.js';
import { InsertNode } from './nodes/insert-node.js';
import { UpdateNode } from './nodes/update-node.js';
import { UpdateExecutorNode } from './nodes/update-executor-node.js';
import { DeleteNode } from './nodes/delete-node.js';
import { ConstraintCheckNode } from './nodes/constraint-check-node.js';
import { RowOp } from '../schema/table.js';
import type { RowDescriptor } from './nodes/plan-node.js';
import type { Scope } from './scopes/scope.js';

const log = createLogger('optimizer');

/**
 * Optimization rule that transforms logical nodes to physical nodes
 */
type OptimizationRule = (node: PlanNode, optimizer: Optimizer) => PlanNode | null;

/**
 * The query optimizer transforms logical plan trees into physical plan trees
 */
export class Optimizer {
	private rules: Map<PlanNodeType, OptimizationRule[]> = new Map();

	constructor() {
		this.registerDefaultRules();
	}

	/**
	 * Optimize a plan tree by applying transformation rules
	 */
	optimize(plan: PlanNode): PlanNode {
		log('Starting optimization of plan', plan.nodeType);
		return this.optimizeNode(plan);
	}

	private optimizeNode(node: PlanNode): PlanNode {
		// If already physical, just recurse on children
		if (node.physical) {
			return this.optimizeChildren(node);
		}

		// First optimize all children
		const optimizedNode = this.optimizeChildren(node);

		// Try to apply rules for this node type
		const rules = this.rules.get(optimizedNode.nodeType) || [];
		for (const rule of rules) {
			const result = rule(optimizedNode, this);
			if (result) {
				log(`Applied rule for ${optimizedNode.nodeType}, transformed to ${result.nodeType}`);
				// Mark as physical and compute properties
				this.markPhysical(result);
				return result;
			}
		}

		// No rule applied - if node supports direct physical conversion, do it
		if (this.canBePhysical(optimizedNode)) {
			this.markPhysical(optimizedNode);
			return optimizedNode;
		}

		// Otherwise, this is an error - all nodes must become physical
		throw new Error(`No rule to make ${optimizedNode.nodeType} physical`);
	}

	private optimizeChildren(node: PlanNode): PlanNode {
		// Handle specific node types that can contain children
		// This ensures we recurse into all common plan nodes

		if (node instanceof BlockNode) {
			const optimizedStatements = node.statements.map(stmt =>
				stmt instanceof PlanNode ? this.optimizeNode(stmt) : stmt
			);
			if (optimizedStatements === node.statements) return node;
			return new BlockNode(node.scope, optimizedStatements, node.parameters);
		}

		if (node instanceof AggregateNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new AggregateNode(node.scope, optimizedSource, node.groupBy, node.aggregates);
		}

		if (node instanceof SortNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new SortNode(node.scope, optimizedSource, node.sortKeys);
		}

		if (node instanceof FilterNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new FilterNode(node.scope, optimizedSource, node.predicate);
		}

		if (node instanceof DistinctNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new DistinctNode(node.scope, optimizedSource);
		}

		if (node instanceof SetOperationNode) {
			const optimizedLeft = this.optimizeNode(node.left) as RelationalPlanNode;
			const optimizedRight = this.optimizeNode(node.right) as RelationalPlanNode;
			if (optimizedLeft === node.left && optimizedRight === node.right) return node;
			return new SetOperationNode(node.scope, optimizedLeft, optimizedRight, node.op);
		}

		if (node instanceof ProjectNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new ProjectNode(node.scope, optimizedSource, node.projections);
		}

		if (node instanceof LimitOffsetNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new LimitOffsetNode(node.scope, optimizedSource, node.limit, node.offset);
		}

		if (node instanceof WindowNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new WindowNode(node.scope, optimizedSource, node.windowSpecs, node.partitionBy, node.orderBy);
		}

		if (node instanceof InsertNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new InsertNode(node.scope, node.table, node.targetColumns, optimizedSource, node.onConflict, node.newRowDescriptor);
		}

		if (node instanceof UpdateNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new UpdateNode(node.scope, node.table, node.assignments, optimizedSource, node.onConflict, node.oldRowDescriptor, node.newRowDescriptor);
		}

		if (node instanceof UpdateExecutorNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new UpdateExecutorNode(node.scope, optimizedSource, node.table);
		}

		if (node instanceof DeleteNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new DeleteNode(node.scope, node.table, optimizedSource, node.oldRowDescriptor);
		}

		if (node instanceof ConstraintCheckNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new ConstraintCheckNode(node.scope, optimizedSource, node.table, node.operation, node.oldRowDescriptor, node.newRowDescriptor);
		}

		// For other nodes, return as-is
		// This is safe for leaf nodes and nodes we don't need to optimize children for
		return node;
	}

	/**
	 * Register a transformation rule for a specific node type
	 */
	registerRule(nodeType: PlanNodeType, rule: OptimizationRule): void {
		if (!this.rules.has(nodeType)) {
			this.rules.set(nodeType, []);
		}
		this.rules.get(nodeType)!.push(rule);
	}

	/**
	 * Register the default optimization rules
	 */
	private registerDefaultRules(): void {
		// Rule: Logical Aggregate → Physical StreamAggregate
		this.registerRule(PlanNodeType.Aggregate, (node, optimizer) => {
			if (!(node instanceof AggregateNode)) return null;

			// Optimize the source first
			const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;

			// For now, always use StreamAggregate
			// TODO: Check if source is ordered on groupBy columns
			// TODO: Consider HashAggregate for unordered inputs

			if (node.groupBy.length > 0) {
				// Need to ensure ordering for streaming aggregate
				// For now, always insert a sort
				// TODO: Check if source already provides the required ordering
				const sortKeys = node.groupBy.map(expr => ({
					expression: expr,
					direction: 'asc' as const,
					nulls: undefined
				}));

				const sortNode = new SortNode(node.scope, optimizedSource, sortKeys);
				sortNode.physical = {
					ordering: node.groupBy.map((_, idx) => ({ column: idx, desc: false }))
				};

				return new StreamAggregateNode(
					node.scope,
					sortNode,
					node.groupBy,
					node.aggregates,
					undefined, // estimatedCostOverride
					node.getAttributes() // Preserve original attribute IDs
				);
			} else {
				// No GROUP BY - can stream aggregate without sorting
				return new StreamAggregateNode(
					node.scope,
					optimizedSource,
					node.groupBy,
					node.aggregates,
					undefined, // estimatedCostOverride
					node.getAttributes() // Preserve original attribute IDs
				);
			}
		});

		// Rule: Insert with constraints → ConstraintCheck + Insert
		this.registerRule(PlanNodeType.Insert, (node, optimizer) => {
			if (!(node instanceof InsertNode)) return null;

			// Check if the table has constraints that need checking
			const tableSchema = node.table.tableSchema;
			const hasConstraints = optimizer.hasConstraintsForOperation(tableSchema, RowOp.INSERT);

			if (!hasConstraints) {
				return null; // No constraints, no transformation needed
			}

			// Create row descriptors for constraint checking
			const { newRowDescriptor } = optimizer.createRowDescriptors(node, RowOp.INSERT);

			// Optimize the source first
			const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;

			// Create ConstraintCheck that processes the source rows BEFORE insert
			const constraintCheckNode = new ConstraintCheckNode(
				node.scope,
				optimizedSource, // Check the rows from Values, not from Insert
				node.table,
				RowOp.INSERT,
				undefined, // oldRowDescriptor
				newRowDescriptor
			);

			// Create new Insert that receives validated rows from ConstraintCheck
			const insertWithConstraints = new InsertNode(
				node.scope,
				node.table,
				node.targetColumns,
				constraintCheckNode, // Use ConstraintCheck as source
				node.onConflict,
				newRowDescriptor
			);

			return insertWithConstraints;
		});

		// Rule: Update with constraints → ConstraintCheck + Update
		this.registerRule(PlanNodeType.Update, (node, optimizer) => {
			if (!(node instanceof UpdateNode)) return null;

			// Check if the table has constraints that need checking
			const tableSchema = node.table.tableSchema;
			const hasConstraints = optimizer.hasConstraintsForOperation(tableSchema, RowOp.UPDATE);

			if (!hasConstraints) {
				return null; // No constraints, no transformation needed
			}

			// Create row descriptors for constraint checking
			const { oldRowDescriptor, newRowDescriptor } = optimizer.createRowDescriptors(node, RowOp.UPDATE);

			// Create the optimized DML node with row descriptors
			const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;
			const updateWithDescriptors = new UpdateNode(
				node.scope,
				node.table,
				node.assignments,
				optimizedSource,
				node.onConflict,
				oldRowDescriptor,
				newRowDescriptor
			);

			// Wrap with constraint checking
			return new ConstraintCheckNode(
				node.scope,
				updateWithDescriptors,
				node.table,
				RowOp.UPDATE,
				oldRowDescriptor,
				newRowDescriptor
			);
		});

		// Rule: Delete with constraints → ConstraintCheck + Delete
		this.registerRule(PlanNodeType.Delete, (node, optimizer) => {
			if (!(node instanceof DeleteNode)) return null;

			// Check if the table has constraints that need checking
			const tableSchema = node.table.tableSchema;
			const hasConstraints = optimizer.hasConstraintsForOperation(tableSchema, RowOp.DELETE);

			if (!hasConstraints) {
				return null; // No constraints, no transformation needed
			}

			// Create row descriptors for constraint checking
			const { oldRowDescriptor } = optimizer.createRowDescriptors(node, RowOp.DELETE);

			// Create the optimized DML node with row descriptors
			const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;
			const deleteWithDescriptors = new DeleteNode(
				node.scope,
				node.table,
				optimizedSource,
				oldRowDescriptor
			);

			// Wrap with constraint checking
			return new ConstraintCheckNode(
				node.scope,
				deleteWithDescriptors,
				node.table,
				RowOp.DELETE,
				oldRowDescriptor,
				undefined // newRowDescriptor
			);
		});

		// Rule: Keep Sort nodes as physical
		this.registerRule(PlanNodeType.Sort, (node, optimizer) => {
			if (!(node instanceof SortNode)) return null;

			// Sort is already a physical node in our current design
			// Just optimize its source
			const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return null; // No change

			const newSort = new SortNode(node.scope, optimizedSource, node.sortKeys);
			// Set physical properties
			newSort.physical = {
				ordering: node.sortKeys.map((key, idx) => ({
					column: idx,
					desc: key.direction === 'desc'
				}))
			};
			return newSort;
		});
	}

	/**
	 * Check if a table has constraints that need checking for a specific operation
	 */
	private hasConstraintsForOperation(tableSchema: any, operation: RowOp): boolean {
		// Check for NOT NULL constraints (apply to INSERT and UPDATE)
		if (operation !== RowOp.DELETE) {
			const hasNotNull = tableSchema.columns?.some((col: any) => col.notNull);
			if (hasNotNull) return true;
		}

		// Check for CHECK constraints
		const hasCheckConstraints = tableSchema.checkConstraints?.some((constraint: any) => {
			if (!constraint.operations) {
				// Default applies to INSERT and UPDATE
				return operation === RowOp.INSERT || operation === RowOp.UPDATE;
			}
			return (constraint.operations & operation) !== 0;
		});

		return !!hasCheckConstraints;
	}

	/**
	 * Create row descriptors for constraint checking
	 */
	private createRowDescriptors(node: InsertNode | UpdateNode | DeleteNode, operation: RowOp): {
		oldRowDescriptor?: RowDescriptor;
		newRowDescriptor?: RowDescriptor;
	} {
		const result: { oldRowDescriptor?: RowDescriptor; newRowDescriptor?: RowDescriptor } = {};

		// For constraint checking, we need to map table columns to row positions
		const tableSchema = node.table.tableSchema;

		if (operation === RowOp.INSERT) {
			// For INSERT, we only need NEW row descriptor
			result.newRowDescriptor = [];
			tableSchema.columns.forEach((column: any, index: number) => {
				result.newRowDescriptor![column.name] = index;
				result.newRowDescriptor![column.name.toLowerCase()] = index;
			});
		} else if (operation === RowOp.UPDATE) {
			// For UPDATE, we need both OLD and NEW row descriptors
			result.oldRowDescriptor = [];
			result.newRowDescriptor = [];
			tableSchema.columns.forEach((column: any, index: number) => {
				result.oldRowDescriptor![column.name] = index;
				result.oldRowDescriptor![column.name.toLowerCase()] = index;
				result.newRowDescriptor![column.name] = index;
				result.newRowDescriptor![column.name.toLowerCase()] = index;
			});
		} else if (operation === RowOp.DELETE) {
			// For DELETE, we only need OLD row descriptor
			result.oldRowDescriptor = [];
			tableSchema.columns.forEach((column: any, index: number) => {
				result.oldRowDescriptor![column.name] = index;
				result.oldRowDescriptor![column.name.toLowerCase()] = index;
			});
		}

		return result;
	}

	/**
	 * Mark a node as physical and compute its properties
	 */
	private markPhysical(node: PlanNode): void {
		if (node.physical) return; // Already physical

		// Collect physical properties from children (both scalar and relational)
		const childrenPhysical: PhysicalProperties[] = [];

		// Add properties from scalar children
		for (const child of node.getChildren()) {
			if (child instanceof PlanNode && child.physical) {
				childrenPhysical.push(child.physical);
			}
		}

		// Add properties from relational children
		for (const relation of node.getRelations()) {
			if (relation.physical) {
				childrenPhysical.push(relation.physical);
			}
		}

		// Let the node compute its own physical properties if it can
		if (node.getPhysical) {
			node.physical = node.getPhysical(childrenPhysical);
		} else {
			// Basic defaults
			node.physical = {
				deterministic: true,
				readonly: true
			};
		}

		// Optimizer can override/adjust properties here
		// For example, propagate constant flag up the tree
		if (childrenPhysical.length > 0 && childrenPhysical.every(p => p.constant)) {
			node.physical.constant = true;
		}
	}

	/**
	 * Check if a node type can be directly marked as physical without transformation
	 */
	private canBePhysical(node: PlanNode): boolean {
		// List node types that are already physical in nature
		const directPhysicalTypes = [
			PlanNodeType.Block,
			PlanNodeType.TableReference,
			PlanNodeType.TableScan,
			PlanNodeType.TableFunctionCall,
			PlanNodeType.Filter,
			PlanNodeType.Project,
			PlanNodeType.Distinct,
			PlanNodeType.Sort,
			PlanNodeType.LimitOffset,
			PlanNodeType.Window,
			PlanNodeType.Sequencing,
			PlanNodeType.SetOperation,
			PlanNodeType.Values,
			PlanNodeType.SingleRow,
			PlanNodeType.CTE,
			PlanNodeType.RecursiveCTE,
			// DDL operations
			PlanNodeType.CreateTable,
			PlanNodeType.DropTable,
			PlanNodeType.CreateView,
			PlanNodeType.DropView,
			// DML operations (only when no constraints need checking)
			PlanNodeType.Insert,
			PlanNodeType.Update,
			PlanNodeType.UpdateExecutor,
			PlanNodeType.Delete,
			// Constraint checking
			PlanNodeType.ConstraintCheck,
			// Other operations
			PlanNodeType.Pragma,
			PlanNodeType.Transaction,
			// Scalar operations (already physical)
			PlanNodeType.Literal,
			PlanNodeType.BinaryOp,
			PlanNodeType.UnaryOp,
			PlanNodeType.ColumnReference,
			PlanNodeType.ParameterReference,
			PlanNodeType.ScalarFunctionCall,
			PlanNodeType.CaseExpr,
			PlanNodeType.Cast,
			PlanNodeType.Collate,
			// Add more as needed
		];
		return directPhysicalTypes.includes(node.nodeType);
	}
}
