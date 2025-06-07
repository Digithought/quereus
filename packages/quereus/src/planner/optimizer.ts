import { createLogger } from '../common/logger.js';
import { PlanNode, type RelationalPlanNode, type PhysicalProperties } from './nodes/plan-node.js';
import { PlanNodeType } from './nodes/plan-node-type.js';
import { BlockNode } from './nodes/block.js';
import { AggregateNode } from './nodes/aggregate-node.js';
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
import { JoinNode } from './nodes/join-node.js';
import { CacheNode } from './nodes/cache-node.js';
import { OptimizerTuning, DEFAULT_TUNING } from './optimizer-tuning.js';
import { getDefaultRules } from './optimizer-rules.js';
import { ReturningNode } from './nodes/returning-node.js';
import { SinkNode } from './nodes/sink-node.js';

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

	constructor(public readonly tuning: OptimizerTuning = DEFAULT_TUNING) {
		this.registerDefaultRules();
	}

	/**
	 * Optimize a plan tree by applying transformation rules
	 */
	optimize(plan: PlanNode): PlanNode {
		log('Starting optimization of plan', plan.nodeType);
		return this.optimizeNode(plan);
	}

	optimizeNode(node: PlanNode): PlanNode {
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

		if (node instanceof JoinNode) {
			// Use specialized join optimization that may inject caching
			return this.optimizeJoinCaching(node as JoinNode);
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
			return new WindowNode(node.scope, optimizedSource, node.windowSpec, node.functions, node.partitionExpressions, node.orderByExpressions, node.functionArguments);
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

		if (node instanceof CacheNode) {
			const cacheNode = node as CacheNode;
			const optimizedSource = this.optimizeNode(cacheNode.source) as RelationalPlanNode;
			if (optimizedSource !== cacheNode.source) {
				return new CacheNode(
					cacheNode.scope,
					optimizedSource,
					cacheNode.strategy,
					cacheNode.threshold,
					cacheNode.estimatedCost
				);
			}
			return cacheNode;
		}

		if (node instanceof ReturningNode) {
			const optimizedExecutor = this.optimizeNode(node.executor) as RelationalPlanNode;
			if (optimizedExecutor !== node.executor) {
				return new ReturningNode(
					node.scope,
					optimizedExecutor,
					node.projections
				);
			}
			return node;
		}

		if (node instanceof SinkNode) {
			const optimizedSource = this.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource === node.source) return node;
			return new SinkNode(node.scope, optimizedSource, node.operation);
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
		const defaultRules = getDefaultRules();
		for (const [nodeType, rules] of defaultRules) {
			for (const rule of rules) {
				this.registerRule(nodeType, rule);
			}
		}
	}

	/**
	 * Check if a table has constraints that need checking for a specific operation
	 */
	hasConstraintsForOperation(tableSchema: any, operation: RowOp): boolean {
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
	createRowDescriptors(node: InsertNode | UpdateNode | DeleteNode, operation: RowOp): {
		oldRowDescriptor?: RowDescriptor;
		newRowDescriptor?: RowDescriptor;
	} {
		// RowDescriptor maps attributeId (number) -> columnIndex in the physical row array.
		// We must therefore allocate unique attribute IDs for every column reference that we
		// want to expose through OLD./NEW. aliases so that ColumnReferenceNodes created later
		// can resolve deterministically.
		const result: { oldRowDescriptor?: RowDescriptor; newRowDescriptor?: RowDescriptor } = {};

		const tableSchema = node.table.tableSchema;

		// Helper that allocates a fresh attribute id for a given column index and registers it
		// into the supplied RowDescriptor.
		const allocAttr = (descriptor: RowDescriptor, columnIndex: number) => {
			const attrId = PlanNode.nextAttrId();
			descriptor[attrId] = columnIndex;
			return attrId;
		};

		if (operation === RowOp.INSERT) {
			// INSERT exposes only NEW.* values
			result.newRowDescriptor = [];
			tableSchema.columns.forEach((_, colIdx) => allocAttr(result.newRowDescriptor!, colIdx));
		} else if (operation === RowOp.UPDATE) {
			// UPDATE exposes both OLD.* and NEW.*
			result.oldRowDescriptor = [];
			result.newRowDescriptor = [];
			tableSchema.columns.forEach((_, colIdx) => {
				allocAttr(result.oldRowDescriptor!, colIdx);
				allocAttr(result.newRowDescriptor!, colIdx);
			});
		} else if (operation === RowOp.DELETE) {
			// DELETE exposes only OLD.* values
			result.oldRowDescriptor = [];
			tableSchema.columns.forEach((_, colIdx) => allocAttr(result.oldRowDescriptor!, colIdx));
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
		// Types that need logical-to-physical transformation
		const needsTransformation = new Set([
			PlanNodeType.Aggregate,  // → StreamAggregate/HashAggregate
			// Insert/Update/Delete might need ConstraintCheck wrapping (handled by rules)
			// Most other types are directly physical
		]);

		return !needsTransformation.has(node.nodeType);
	}

	private optimizeJoinCaching(node: JoinNode): RelationalPlanNode {
		// For nested loop joins, caching the right side can provide significant benefits
		// when the right side will be scanned multiple times (once per left row)

		const leftSize = node.left.estimatedRows ?? this.tuning.defaultRowEstimate;
		const rightSize = node.right.estimatedRows ?? this.tuning.defaultRowEstimate;

		// Heuristic: For nested loop joins, we almost always want to cache the right side
		// unless it's obviously too large or already cached
		const shouldCacheRight = node.right.nodeType !== PlanNodeType.Cache &&
								// Always cache for small/medium datasets or when estimates are missing
								(leftSize === 0 || leftSize > this.tuning.join.minLeftRowsForCaching ||
								 rightSize === 0 || rightSize < this.tuning.join.maxRightRowsForCaching);

		let optimizedLeft = this.optimizeNode(node.left) as RelationalPlanNode;
		let optimizedRight = this.optimizeNode(node.right) as RelationalPlanNode;

		if (shouldCacheRight) {
			log('Adding cache to right side of join (left rows: %d, right rows: %d)',
				leftSize, rightSize);
			// Inject cache with appropriate threshold
			const cacheThreshold = rightSize > 0 ?
				Math.min(rightSize * this.tuning.join.cacheThresholdMultiplier, this.tuning.join.maxCacheThreshold) :
				this.tuning.join.maxCacheThreshold;
			optimizedRight = new CacheNode(
				optimizedRight.scope,
				optimizedRight,
				'memory',
				cacheThreshold
			);
		}

		if (optimizedLeft !== node.left || optimizedRight !== node.right) {
			return new JoinNode(
				node.scope,
				optimizedLeft,
				optimizedRight,
				node.joinType,
				node.condition,
				node.usingColumns
			);
		}

		return node;
	}
}
