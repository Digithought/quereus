/**
 * Rule registration and management framework for the Titan optimizer
 * Provides centralized rule registry with tracing and loop detection
 */

import { createLogger } from '../../common/logger.js';
import type { PlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { Optimizer } from '../optimizer.js';
import { traceRuleStart, traceRuleEnd } from './trace.js';

const log = createLogger('optimizer:framework:registry');

/**
 * Rule function signature for optimization transformations
 */
export type RuleFn = (node: PlanNode, optimizer: Optimizer) => PlanNode | null;

/**
 * Rule phases for categorizing optimization rules
 */
export type RulePhase = 'rewrite' | 'impl';

/**
 * Handle for registered optimization rules
 */
export interface RuleHandle {
	/** Unique identifier for this rule */
	id: string;
	/** Node type this rule applies to */
	nodeType: PlanNodeType;
	/** Phase classification */
	phase: RulePhase;
	/** Rule implementation function */
	fn: RuleFn;
	/** Optional priority (lower numbers run first) */
	priority?: number;
}

/**
 * Global rule registry
 */
class RuleRegistry {
	private rules = new Map<PlanNodeType, RuleHandle[]>();
	private visitedRules = new Map<string, Set<string>>(); // nodeId -> ruleIds applied

	/**
	 * Register a new optimization rule
	 */
	registerRule(handle: RuleHandle): void {
		if (!this.rules.has(handle.nodeType)) {
			this.rules.set(handle.nodeType, []);
		}

		const nodeRules = this.rules.get(handle.nodeType)!;

		// Check for duplicate rule IDs
		if (nodeRules.some(r => r.id === handle.id)) {
			throw new Error(`Optimization rule '${handle.id}' already registered for node type ${handle.nodeType}`);
		}

		// Insert rule maintaining priority order (lower priority first)
		const priority = handle.priority ?? 100;
		const insertIndex = nodeRules.findIndex(r => (r.priority ?? 100) > priority);
		if (insertIndex === -1) {
			nodeRules.push(handle);
		} else {
			nodeRules.splice(insertIndex, 0, handle);
		}

		log('Registered rule %s for %s (phase: %s, priority: %d)',
			handle.id, handle.nodeType, handle.phase, priority);
	}

	/**
	 * Get all rules for a specific node type
	 */
	rulesFor(nodeType: PlanNodeType): readonly RuleHandle[] {
		return this.rules.get(nodeType) ?? [];
	}

	/**
	 * Check if a rule has already been applied to a node
	 */
	hasRuleBeenApplied(nodeId: string, ruleId: string): boolean {
		const nodeVisited = this.visitedRules.get(nodeId);
		return nodeVisited?.has(ruleId) ?? false;
	}

	/**
	 * Mark a rule as applied to a node
	 */
	markRuleApplied(nodeId: string, ruleId: string): void {
		if (!this.visitedRules.has(nodeId)) {
			this.visitedRules.set(nodeId, new Set());
		}
		this.visitedRules.get(nodeId)!.add(ruleId);
	}

	/**
	 * Clear visited rules (typically called at start of optimization)
	 */
	clearVisitedRules(): void {
		this.visitedRules.clear();
	}

	/**
	 * Get all registered rules (for debugging)
	 */
	getAllRules(): Map<PlanNodeType, readonly RuleHandle[]> {
		const result = new Map<PlanNodeType, readonly RuleHandle[]>();
		for (const [nodeType, rules] of this.rules) {
			result.set(nodeType, [...rules]);
		}
		return result;
	}

	/**
	 * Get statistics about rule application
	 */
	getStats(): { totalRules: number; nodesWithRules: number; appliedRules: number } {
		let totalRules = 0;
		for (const rules of this.rules.values()) {
			totalRules += rules.length;
		}

		let appliedRules = 0;
		for (const ruleSet of this.visitedRules.values()) {
			appliedRules += ruleSet.size;
		}

		return {
			totalRules,
			nodesWithRules: this.visitedRules.size,
			appliedRules
		};
	}
}

/**
 * Global registry instance
 */
const globalRegistry = new RuleRegistry();

/**
 * Register an optimization rule
 */
export function registerRule(handle: RuleHandle): void {
	globalRegistry.registerRule(handle);
}

/**
 * Get rules for a specific node type
 */
export function rulesFor(nodeType: PlanNodeType): readonly RuleHandle[] {
	return globalRegistry.rulesFor(nodeType);
}

/**
 * Check if a rule has been applied to a node
 */
export function hasRuleBeenApplied(nodeId: string, ruleId: string): boolean {
	return globalRegistry.hasRuleBeenApplied(nodeId, ruleId);
}

/**
 * Mark a rule as applied to a node
 */
export function markRuleApplied(nodeId: string, ruleId: string): void {
	globalRegistry.markRuleApplied(nodeId, ruleId);
}

/**
 * Clear all visited rule tracking
 */
export function clearVisitedRules(): void {
	globalRegistry.clearVisitedRules();
}

/**
 * Get registry statistics
 */
export function getRegistryStats(): { totalRules: number; nodesWithRules: number; appliedRules: number } {
	return globalRegistry.getStats();
}

/**
 * Get all registered rules (for debugging/tooling)
 */
export function getAllRules(): Map<PlanNodeType, readonly RuleHandle[]> {
	return globalRegistry.getAllRules();
}

/**
 * Apply rules to a node with tracing and loop detection
 */
export function applyRules(node: PlanNode, optimizer: Optimizer): PlanNode {
	const applicableRules = rulesFor(node.nodeType);

	if (applicableRules.length === 0) {
		return node;
	}

	let currentNode = node;
	let appliedAnyRule = false;

	for (const rule of applicableRules) {
		// Skip if rule already applied to this node
		if (hasRuleBeenApplied(currentNode.id, rule.id)) {
			log('Skipping rule %s for node %s (already applied)', rule.id, currentNode.id);
			continue;
		}

		try {
			const ruleLog = createLogger(`optimizer:rule:${rule.id}`);

			// Trace rule start
			traceRuleStart(rule, currentNode);
			ruleLog('Applying rule to node %s', currentNode.id);

			const result = rule.fn(currentNode, optimizer);

						if (result && result !== currentNode) {
				ruleLog('Rule transformed %s to %s', currentNode.nodeType, result.nodeType);
				markRuleApplied(currentNode.id, rule.id);

				// Trace successful transformation
				traceRuleEnd(rule, currentNode, result);

				currentNode = result;
				appliedAnyRule = true;
			} else {
				ruleLog('Rule not applicable to node %s', currentNode.id);

				// Trace rule not applicable
				traceRuleEnd(rule, currentNode, null);
			}
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			log('Rule %s failed on node %s: %s', rule.id, currentNode.id, errorMsg);
			// Continue with other rules rather than failing entire optimization
		}
	}

	if (appliedAnyRule) {
		log('Applied rules to node %s, result: %s', node.id, currentNode.nodeType);
	}

	return currentNode;
}

/**
 * Convenience function to register multiple rules at once
 */
export function registerRules(rules: RuleHandle[]): void {
	for (const rule of rules) {
		registerRule(rule);
	}
}

/**
 * Helper to create rule handles with common patterns
 */
export function createRule(
	id: string,
	nodeType: PlanNodeType,
	phase: RulePhase,
	fn: RuleFn,
	priority?: number
): RuleHandle {
	return { id, nodeType, phase, fn, priority };
}
