import { createLogger } from '../common/logger.js';
import { PlanNode, type RelationalPlanNode } from './nodes/plan-node.js';
import { PlanNodeType } from './nodes/plan-node-type.js';
import { AggregateNode } from './nodes/aggregate-node.js';
import { StreamAggregateNode } from './nodes/stream-aggregate.js';
import { SortNode } from './nodes/sort.js';
import { InsertNode } from './nodes/insert-node.js';
import { UpdateNode } from './nodes/update-node.js';
import { DeleteNode } from './nodes/delete-node.js';
import { ConstraintCheckNode } from './nodes/constraint-check-node.js';
import { CTENode } from './nodes/cte-node.js';
import { CacheNode } from './nodes/cache-node.js';
import { RowOp } from '../schema/table.js';
import type { Optimizer } from './optimizer.js';
import { UpdateExecutorNode } from './nodes/update-executor-node.js';
import { ReturningNode, type ReturningProjection } from './nodes/returning-node.js';
import { ProjectNode } from './nodes/project-node.js';

const log = createLogger('optimizer-rules');

/**
 * Optimization rule that transforms logical nodes to physical nodes
 */
type OptimizationRule = (node: PlanNode, optimizer: Optimizer) => PlanNode | null;

/**
 * Registry of default optimization rules mapped by node type
 */
export const getDefaultRules = (): Map<PlanNodeType, OptimizationRule[]> => {
	const rules = new Map<PlanNodeType, OptimizationRule[]>();

	const registerRule = (nodeType: PlanNodeType, rule: OptimizationRule) => {
		if (!rules.has(nodeType)) {
			rules.set(nodeType, []);
		}
		rules.get(nodeType)!.push(rule);
	};

	// Rule: Logical Aggregate → Physical StreamAggregate
	registerRule(PlanNodeType.Aggregate, (node, optimizer) => {
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
	registerRule(PlanNodeType.Insert, (node, optimizer) => {
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

	// Rule: UpdateExecutor with constraints → UpdateExecutor + ConstraintCheck + Update
	registerRule(PlanNodeType.UpdateExecutor, (node, optimizer) => {
		if (!(node instanceof UpdateExecutorNode)) return null;

		// If source is already a ConstraintCheckNode, optimization has been applied - just ensure it's optimized
		if (node.source.nodeType === PlanNodeType.ConstraintCheck) {
			const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource !== node.source) {
				return new UpdateExecutorNode(node.scope, optimizedSource, node.table);
			}
			return null; // Already optimized
		}

		// Check if the child is an UpdateNode
		if (node.source.nodeType !== PlanNodeType.Update) {
			// Optimize the source and return if changed
			const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;
			if (optimizedSource !== node.source) {
				return new UpdateExecutorNode(node.scope, optimizedSource, node.table);
			}
			return null;
		}

		const updateNode = node.source as UpdateNode;
		const tableSchema = updateNode.table.tableSchema;
		const hasConstraints = optimizer.hasConstraintsForOperation(tableSchema, RowOp.UPDATE);

		if (!hasConstraints) {
			// No constraints, just optimize the UpdateNode
			const optimizedUpdate = optimizer.optimizeNode(updateNode) as RelationalPlanNode;
			if (optimizedUpdate !== updateNode) {
				return new UpdateExecutorNode(node.scope, optimizedUpdate, node.table);
			}
			return null;
		}

		// Has constraints - inject ConstraintCheckNode between UpdateExecutor and UpdateNode
		const { oldRowDescriptor, newRowDescriptor } = optimizer.createRowDescriptors(updateNode, RowOp.UPDATE);

		// Create the optimized UpdateNode with row descriptors
		const optimizedSource = optimizer.optimizeNode(updateNode.source) as RelationalPlanNode;
		const updateWithDescriptors = new UpdateNode(
			updateNode.scope,
			updateNode.table,
			updateNode.assignments,
			optimizedSource,
			updateNode.onConflict,
			oldRowDescriptor,
			newRowDescriptor
		);

		// Create ConstraintCheckNode that validates the UpdateNode output
		const constraintCheckNode = new ConstraintCheckNode(
			updateNode.scope,
			updateWithDescriptors,
			updateNode.table,
			RowOp.UPDATE,
			oldRowDescriptor,
			newRowDescriptor
		);

		// Return UpdateExecutorNode with ConstraintCheckNode as source
		return new UpdateExecutorNode(node.scope, constraintCheckNode, node.table);
	});

	// Rule: Delete with constraints → ConstraintCheck + Delete
	registerRule(PlanNodeType.Delete, (node, optimizer) => {
		if (!(node instanceof DeleteNode)) return null;

		// Check if the table has constraints that need checking
		const tableSchema = node.table.tableSchema;
		const hasConstraints = optimizer.hasConstraintsForOperation(tableSchema, RowOp.DELETE);

		if (!hasConstraints) {
			return null; // No constraints, no transformation needed
		}

		// For DELETE, we need to check constraints BEFORE deletion
		// So we put ConstraintCheck on the source rows, then pass them to DeleteNode
		const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;

		// Create row descriptors for constraint checking
		const { oldRowDescriptor } = optimizer.createRowDescriptors(node, RowOp.DELETE);

		// First, check constraints on the rows to be deleted
		const constraintCheckNode = new ConstraintCheckNode(
			node.scope,
			optimizedSource, // Check the source rows BEFORE deletion
			node.table,
			RowOp.DELETE,
			oldRowDescriptor,
			undefined // newRowDescriptor
		);

		// Then create the delete node that receives the validated rows
		return new DeleteNode(
			node.scope,
			node.table,
			constraintCheckNode, // Use constraint-checked rows as source
			oldRowDescriptor
		);
	});

	// Rule: Keep Sort nodes as physical
	registerRule(PlanNodeType.Sort, (node, optimizer) => {
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

	// Rule: CTE optimization - inject caching when beneficial
	registerRule(PlanNodeType.CTE, (node, optimizer) => {
		if (!(node instanceof CTENode)) return null;

		const optimizedSource = optimizer.optimizeNode(node.source) as RelationalPlanNode;

		// Heuristics for when to cache CTEs:
		// 1. CTE has materialization hint
		// 2. CTE is estimated to be reasonably sized
		// 3. CTE is not already cached
		const sourceSize = optimizedSource.estimatedRows ?? optimizer.tuning.defaultRowEstimate;
		const shouldCache = (
			node.materializationHint === 'materialized' ||
			(sourceSize > 0 && sourceSize < optimizer.tuning.cte.maxSizeForCaching)
		) && optimizedSource.nodeType !== PlanNodeType.Cache;

		if (shouldCache) {
			log('Adding cache to CTE %s (estimated rows: %d)', node.cteName, sourceSize);
			const cacheThreshold = Math.min(
				sourceSize * optimizer.tuning.cte.cacheThresholdMultiplier,
				optimizer.tuning.cte.maxCacheThreshold
			);
			const cachedSource = new CacheNode(
				optimizedSource.scope,
				optimizedSource,
				'memory',
				cacheThreshold
			);

			return new CTENode(
				node.scope,
				node.cteName,
				node.columns,
				cachedSource,
				node.materializationHint,
				node.isRecursive
			);
		}

		// If source was optimized but no caching needed
		if (optimizedSource !== node.source) {
			return new CTENode(
				node.scope,
				node.cteName,
				node.columns,
				optimizedSource,
				node.materializationHint,
				node.isRecursive
			);
		}

		return null; // No transformation needed
	});

	// Rule: ProjectNode wrapping VoidNode → ReturningNode for correct RETURNING semantics
	registerRule(PlanNodeType.Project, (node, optimizer) => {
		if (!(node instanceof ProjectNode)) return null;

		// Check if we're projecting from a VoidNode (like UpdateExecutorNode, InsertNode, DeleteNode)
		// This indicates a RETURNING clause that should execute after the DML operation
		const source = node.source;

		// Handle UpdateExecutorNode
		if (source.nodeType === PlanNodeType.UpdateExecutor && source instanceof UpdateExecutorNode) {
			log('Converting ProjectNode(UpdateExecutorNode) to ReturningNode for correct RETURNING semantics');

			// The UpdateExecutorNode has a constraint-checked source that we want to project from
			const projectionSource = source.source;

			// Convert ProjectNode projections to ReturningProjections
			const returningProjections: ReturningProjection[] = node.projections.map(proj => ({
				node: proj.node,
				alias: proj.alias
			}));

			// Optimize both the executor and projection source
			const optimizedExecutor = optimizer.optimizeNode(source) as UpdateExecutorNode;
			const optimizedProjectionSource = optimizer.optimizeNode(projectionSource) as RelationalPlanNode;

			return new ReturningNode(
				node.scope,
				optimizedExecutor,
				optimizedProjectionSource,
				returningProjections
			);
		}

		// Handle InsertNode
		if (source.nodeType === PlanNodeType.Insert && source instanceof InsertNode) {
			log('Converting ProjectNode(InsertNode) to ReturningNode for correct RETURNING semantics');

			// For InsertNode, the projection source should be the InsertNode itself
			// since it represents the inserted rows with table structure
			const projectionSource = source;

			// Convert ProjectNode projections to ReturningProjections
			const returningProjections: ReturningProjection[] = node.projections.map(proj => ({
				node: proj.node,
				alias: proj.alias
			}));

			// Optimize both the executor and projection source
			const optimizedExecutor = optimizer.optimizeNode(source) as InsertNode;
			const optimizedProjectionSource = optimizedExecutor; // Use the optimized InsertNode

			return new ReturningNode(
				node.scope,
				optimizedExecutor,
				optimizedProjectionSource,
				returningProjections
			);
		}

		// Handle DeleteNode
		if (source.nodeType === PlanNodeType.Delete && source instanceof DeleteNode) {
			log('Converting ProjectNode(DeleteNode) to ReturningNode for correct RETURNING semantics');

			// For DeleteNode, the projection source is the filtered source
			const projectionSource = source.source;

			// Convert ProjectNode projections to ReturningProjections
			const returningProjections: ReturningProjection[] = node.projections.map(proj => ({
				node: proj.node,
				alias: proj.alias
			}));

			// Optimize both the executor and projection source
			const optimizedExecutor = optimizer.optimizeNode(source) as DeleteNode;
			const optimizedProjectionSource = optimizer.optimizeNode(projectionSource) as RelationalPlanNode;

			return new ReturningNode(
				node.scope,
				optimizedExecutor,
				optimizedProjectionSource,
				returningProjections
			);
		}

		// For other cases, just optimize the source
		const optimizedSource = optimizer.optimizeNode(source) as RelationalPlanNode;
		if (optimizedSource !== source) {
			return new ProjectNode(node.scope, optimizedSource, node.projections);
		}

		return null; // No transformation needed
	});

	return rules;
};
