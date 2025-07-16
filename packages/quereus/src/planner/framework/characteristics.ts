/**
 * Characteristics-based plan node analysis
 *
 * This module provides utilities for analyzing plan nodes based on their capabilities
 * and characteristics rather than their specific types, enabling robust and extensible
 * optimization rules.
 */

import type { PlanNode, RelationalPlanNode, ScalarPlanNode, ConstantNode } from '../nodes/plan-node.js';
import { isRelationalNode } from '../nodes/plan-node.js';
import type { TableSchema } from '../../schema/table.js';

// Default row estimate when not available
const DEFAULT_ROW_ESTIMATE = 1000;

/**
 * Core physical property-based characteristics
 */
export class PlanNodeCharacteristics {
	// Physical property shortcuts
	static hasSideEffects(node: PlanNode): boolean {
		return node.physical.readonly === false;
	}

	static isReadOnly(node: PlanNode): boolean {
		return node.physical.readonly !== false;
	}

	static isDeterministic(node: PlanNode): boolean {
		return node.physical.deterministic !== false;
	}

	static isIdempotent(node: PlanNode): boolean {
		return node.physical.idempotent !== false;
	}

	static isConstant(node: PlanNode): node is ConstantNode {
		return node.physical.constant === true && 'getValue' in node;
	}

	static isFunctional(node: PlanNode): boolean {
		return this.isDeterministic(node) && this.isReadOnly(node);
	}

	// Ordering capabilities
	static hasOrderedOutput(node: PlanNode): boolean {
		return node.physical.ordering !== undefined && node.physical.ordering.length > 0;
	}

	static preservesOrdering(node: PlanNode): boolean {
		// Check if node preserves input ordering (single child with ordered output)
		const children = node.getChildren();
		return children.length === 1 && this.hasOrderedOutput(children[0]);
	}

	static getOrdering(node: PlanNode): { column: number; desc: boolean }[] | undefined {
		return node.physical.ordering;
	}

	// Cardinality analysis
	static estimatesRows(node: PlanNode): number {
		return node.physical.estimatedRows ?? DEFAULT_ROW_ESTIMATE;
	}

	static guaranteesUniqueRows(node: PlanNode): boolean {
		return node.physical.uniqueKeys?.some(key => key.length === 0) === true;
	}

	static hasUniqueKeys(node: PlanNode): boolean {
		return node.physical.uniqueKeys !== undefined && node.physical.uniqueKeys.length > 0;
	}

	static getUniqueKeys(node: PlanNode): number[][] | undefined {
		return node.physical.uniqueKeys;
	}

	// Relational capabilities
	static isRelational(node: PlanNode): node is RelationalPlanNode {
		return isRelationalNode(node);
	}

	static producesRows(node: PlanNode): node is RelationalPlanNode {
		return isRelationalNode(node);
	}

	static isScalar(node: PlanNode): boolean {
		return node.getType().typeClass === 'scalar';
	}

	static isVoid(node: PlanNode): boolean {
		return node.getType().typeClass === 'void';
	}

	// Performance characteristics
	static isExpensive(node: PlanNode): boolean {
		const estimatedRows = this.estimatesRows(node);
		return estimatedRows > 10000; // Tunable threshold
	}

	static isLikelyRepeated(node: PlanNode): boolean {
		// Heuristic: nodes with side effects are likely to be repeated in joins
		return this.hasSideEffects(node);
	}
}

/**
 * Interface for nodes that can provide predicates (WHERE clauses, join conditions)
 */
export interface PredicateCapable extends PlanNode {
	getPredicate(): ScalarPlanNode | null;
	withPredicate(newPredicate: ScalarPlanNode | null): PlanNode;
}

/**
 * Interface for nodes that can combine predicates (for pushdown optimization)
 */
export interface PredicateCombinable extends PredicateCapable {
	canCombinePredicates(): boolean;
	combineWith(other: ScalarPlanNode): ScalarPlanNode;
}

/**
 * Interface for table access nodes
 */
export interface TableAccessCapable extends RelationalPlanNode {
	readonly tableSchema: TableSchema;
	getAccessMethod(): 'sequential' | 'index-scan' | 'index-seek' | 'virtual';
}

/**
 * Interface for aggregation operations
 */
export interface AggregationCapable extends RelationalPlanNode {
	getGroupingKeys(): readonly ScalarPlanNode[];
	getAggregateExpressions(): readonly { expr: ScalarPlanNode; alias: string; attributeId: number }[];
	requiresOrdering(): boolean;
	canStreamAggregate(): boolean;
}

/**
 * Interface for sorting operations
 */
export interface SortCapable extends PlanNode {
	getSortKeys(): readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc' }[];
	withSortKeys(keys: readonly { expression: ScalarPlanNode; direction: 'asc' | 'desc' }[]): PlanNode;
}

/**
 * Interface for projection operations
 */
export interface ProjectionCapable extends RelationalPlanNode {
	getProjections(): readonly { node: ScalarPlanNode; alias: string; attributeId: number }[];
	withProjections(projections: readonly { node: ScalarPlanNode; alias: string; attributeId: number }[]): PlanNode;
}

/**
 * Interface for join operations
 */
export interface JoinCapable extends RelationalPlanNode {
	getJoinType(): 'inner' | 'left' | 'right' | 'full' | 'cross';
	getJoinCondition(): ScalarPlanNode | null;
	getLeftSource(): RelationalPlanNode;
	getRightSource(): RelationalPlanNode;
}

/**
 * Interface for cached operations
 */
export interface CacheCapable extends PlanNode {
	getCacheStrategy(): string | null;
	isCached(): boolean;
}

/**
 * Type guards for capability detection
 */
export class CapabilityDetectors {
	static canPushDownPredicate(node: PlanNode): node is PredicateCapable {
		return 'getPredicate' in node &&
			   typeof (node as any).getPredicate === 'function' &&
			   'withPredicate' in node &&
			   typeof (node as any).withPredicate === 'function';
	}

	static canCombinePredicates(node: PlanNode): node is PredicateCombinable {
		return this.canPushDownPredicate(node) &&
			   'canCombinePredicates' in node &&
			   typeof (node as any).canCombinePredicates === 'function';
	}

	static isTableAccess(node: PlanNode): node is TableAccessCapable {
		return PlanNodeCharacteristics.isRelational(node) &&
			   'tableSchema' in node &&
			   'getAccessMethod' in node &&
			   typeof (node as any).getAccessMethod === 'function';
	}

	static isAggregating(node: PlanNode): node is AggregationCapable {
		return PlanNodeCharacteristics.isRelational(node) &&
			   'getGroupingKeys' in node &&
			   typeof (node as any).getGroupingKeys === 'function' &&
			   'getAggregateExpressions' in node &&
			   typeof (node as any).getAggregateExpressions === 'function';
	}

	static isSortable(node: PlanNode): node is SortCapable {
		return 'getSortKeys' in node &&
			   typeof (node as any).getSortKeys === 'function' &&
			   'withSortKeys' in node &&
			   typeof (node as any).withSortKeys === 'function';
	}

	static canProject(node: PlanNode): node is ProjectionCapable {
		return PlanNodeCharacteristics.isRelational(node) &&
			   'getProjections' in node &&
			   typeof (node as any).getProjections === 'function';
	}

	static isJoin(node: PlanNode): node is JoinCapable {
		return PlanNodeCharacteristics.isRelational(node) &&
			   'getJoinType' in node &&
			   typeof (node as any).getJoinType === 'function' &&
			   'getLeftSource' in node &&
			   'getRightSource' in node;
	}

	static isCached(node: PlanNode): node is CacheCapable {
		return 'getCacheStrategy' in node &&
			   typeof (node as any).getCacheStrategy === 'function';
	}
}

/**
 * Extensible capability registry for custom characteristics
 */
export class CapabilityRegistry {
	private static readonly detectors = new Map<string, (node: PlanNode) => boolean>();

	static register(
		capability: string,
		detector: (node: PlanNode) => boolean
	): void {
		this.detectors.set(capability, detector);
	}

	static hasCapability(node: PlanNode, capability: string): boolean {
		const detector = this.detectors.get(capability);
		return detector ? detector(node) : false;
	}

	static getCapable(
		nodes: readonly PlanNode[],
		capability: string
	): PlanNode[] {
		const detector = this.detectors.get(capability);
		if (!detector) return [];
		return nodes.filter(detector);
	}

	static getAllCapabilities(): string[] {
		return Array.from(this.detectors.keys());
	}

	static unregister(capability: string): boolean {
		return this.detectors.delete(capability);
	}
}

/**
 * Caching analysis utilities
 */
export class CachingAnalysis {
	static isCacheable(node: PlanNode): boolean {
		// Must be relational to cache results
		if (!PlanNodeCharacteristics.isRelational(node)) {
			return false;
		}

		// Already cached nodes don't need re-caching
		if (CapabilityDetectors.isCached(node) && (node as any).isCached()) {
			return false;
		}

		// Check physical properties for side effects
		if (PlanNodeCharacteristics.hasSideEffects(node)) {
			// Only cache if execution would be expensive and repeated
			return this.isExpensiveRepeatedOperation(node);
		}

		return true;
	}

	static shouldCache(node: PlanNode): boolean {
		if (!this.isCacheable(node)) {
			return false;
		}

		// Cache expensive operations
		if (PlanNodeCharacteristics.isExpensive(node)) {
			return true;
		}

		// Cache likely repeated operations
		if (PlanNodeCharacteristics.isLikelyRepeated(node)) {
			return true;
		}

		return false;
	}

	private static isExpensiveRepeatedOperation(node: PlanNode): boolean {
		return PlanNodeCharacteristics.isExpensive(node) &&
			   PlanNodeCharacteristics.isLikelyRepeated(node);
	}

	static getCacheThreshold(node: PlanNode): number {
		const estimatedRows = PlanNodeCharacteristics.estimatesRows(node);
		return Math.min(Math.max(estimatedRows * 0.1, 1000), 100000);
	}
}

/**
 * Predicate analysis utilities
 */
export class PredicateAnalysis {
	static canPushDown(predicate: ScalarPlanNode, targetNode: PlanNode): boolean {
		if (!CapabilityDetectors.canPushDownPredicate(targetNode)) {
			return false;
		}

		// Check if predicate only references columns from target
		return this.predicateReferencesOnly(predicate, targetNode);
	}

	static canCombine(pred1: ScalarPlanNode, pred2: ScalarPlanNode): boolean {
		// Basic heuristic: both must be deterministic
		return PlanNodeCharacteristics.isDeterministic(pred1) &&
			   PlanNodeCharacteristics.isDeterministic(pred2);
	}

	private static predicateReferencesOnly(_predicate: ScalarPlanNode, _targetNode: PlanNode): boolean {
		// TODO: Implement column reference analysis
		// For now, conservatively return true
		return true;
	}
}

// Register built-in capabilities
CapabilityRegistry.register('predicate-pushdown', CapabilityDetectors.canPushDownPredicate);
CapabilityRegistry.register('table-access', CapabilityDetectors.isTableAccess);
CapabilityRegistry.register('aggregation', CapabilityDetectors.isAggregating);
CapabilityRegistry.register('sort', CapabilityDetectors.isSortable);
CapabilityRegistry.register('projection', CapabilityDetectors.canProject);
CapabilityRegistry.register('join', CapabilityDetectors.isJoin);
CapabilityRegistry.register('cache', CapabilityDetectors.isCached);
