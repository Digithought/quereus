/**
 * Optimization pass framework for multi-pass query optimization
 *
 * This framework enables rules to run in separate tree traversals,
 * allowing for proper sequencing of transformations that require
 * different traversal orders or multiple passes over the tree.
 */

import type { PlanNode } from '../nodes/plan-node.js';
import type { OptContext } from './context.js';
import type { RuleHandle } from './registry.js';
import { createLogger } from '../../common/logger.js';
import { performConstantFolding } from '../analysis/const-pass.js';
import { createRuntimeExpressionEvaluator } from '../analysis/const-evaluator.js';

const log = createLogger('optimizer:framework:pass');

/**
 * Traversal order for optimization passes
 */
export enum TraversalOrder {
	/** Process children before parents */
	BottomUp = 'bottom-up',
	/** Process parents before children */
	TopDown = 'top-down',
}

/**
 * Definition of an optimization pass
 */
export interface OptimizationPass {
	/** Unique identifier for this pass */
	id: string;

	/** Human-readable name for logging */
	name: string;

	/** Description of what this pass does */
	description: string;

	/** Traversal order for this pass */
	traversalOrder: TraversalOrder;

	/** Rules that belong to this pass (will be populated by registration) */
	rules: RuleHandle[];

	/** Optional custom execution logic (default uses standard rule application) */
	execute?: (plan: PlanNode, context: OptContext) => PlanNode;

	/** Whether this pass is enabled (default: true) */
	enabled?: boolean;

	/** Order in which passes execute (lower numbers first) */
	order: number;
}

/**
 * Standard optimization passes
 */
export enum PassId {
	/** Pre-optimization constant folding */
	ConstantFolding = 'constant-folding',

	/** Structural transformations (pushdown, pullup, boundary sliding) */
	Structural = 'structural',

	/** Physical operator selection and implementation */
	Physical = 'physical',

	/** Post-optimization cleanup and caching */
	PostOptimization = 'post-opt',

	/** Final validation */
	Validation = 'validation',
}

/**
 * Create a standard optimization pass
 */
export function createPass(
	id: string,
	name: string,
	description: string,
	order: number,
	traversalOrder: TraversalOrder = TraversalOrder.BottomUp
): OptimizationPass {
	return {
		id,
		name,
		description,
		traversalOrder,
		rules: [],
		enabled: true,
		order
	};
}

/**
 * Create constant folding pass with custom execution
 */
function createConstantFoldingPass(): OptimizationPass {
	return {
		id: PassId.ConstantFolding,
		name: 'Constant Folding',
		description: 'Pre-evaluate constant expressions and fold them into the plan',
		traversalOrder: TraversalOrder.BottomUp,
		rules: [],
		enabled: true,
		order: 0,
		execute: (plan: PlanNode, context: OptContext) => {
			// Custom execution for constant folding
			const evaluator = createRuntimeExpressionEvaluator(context.db);
			const result = performConstantFolding(plan, evaluator);
			log('Constant folding completed');
			return result;
		}
	};
}

/**
 * Standard pass definitions
 */
export const STANDARD_PASSES: OptimizationPass[] = [
	createConstantFoldingPass(),

	createPass(
		PassId.Structural,
		'Structural Transformations',
		'Restructure the plan tree for optimal execution boundaries',
		10,
		TraversalOrder.TopDown
	),

	createPass(
		PassId.Physical,
		'Physical Selection',
		'Convert logical operators to physical implementations',
		20,
		TraversalOrder.BottomUp
	),

	createPass(
		PassId.PostOptimization,
		'Post-Optimization',
		'Final cleanup, materialization decisions, and caching',
		30,
		TraversalOrder.BottomUp
	),

	createPass(
		PassId.Validation,
		'Validation',
		'Validate the correctness of the optimized plan',
		40,
		TraversalOrder.BottomUp
	),
];

/**
 * Pass manager for coordinating multi-pass optimization
 */
export class PassManager {
	private passes: Map<string, OptimizationPass> = new Map();
	private sortedPasses: OptimizationPass[] = [];

	constructor() {
		// Register standard passes
		for (const pass of STANDARD_PASSES) {
			this.registerPass(pass);
		}
	}

	/**
	 * Register an optimization pass
	 */
	registerPass(pass: OptimizationPass): void {
		if (this.passes.has(pass.id)) {
			log('Warning: Overwriting existing pass %s', pass.id);
		}

		this.passes.set(pass.id, pass);
		this.updateSortedPasses();

		log('Registered pass %s (order: %d, traversal: %s)',
			pass.id, pass.order, pass.traversalOrder);
	}

	/**
	 * Get a pass by ID
	 */
	getPass(id: string): OptimizationPass | undefined {
		return this.passes.get(id);
	}

	/**
	 * Add a rule to a specific pass
	 */
	addRuleToPass(passId: string, rule: RuleHandle): void {
		const pass = this.passes.get(passId);
		if (!pass) {
			throw new Error(`Unknown pass: ${passId}`);
		}

		// Avoid duplicate registrations by rule ID within a pass
		if (pass.rules.some(r => r.id === rule.id)) {
			log('Skipping duplicate rule %s for pass %s', rule.id, passId);
			return;
		}

		pass.rules.push(rule);
		log('Added rule %s to pass %s', rule.id, passId);
	}

	/**
	 * Get all passes in execution order
	 */
	getPasses(): readonly OptimizationPass[] {
		return this.sortedPasses;
	}

	/**
	 * Update sorted pass list after changes
	 */
	private updateSortedPasses(): void {
		this.sortedPasses = Array.from(this.passes.values())
			.filter(pass => pass.enabled !== false)
			.sort((a, b) => a.order - b.order);
	}

	/**
	 * Execute all passes on a plan
	 */
	execute(plan: PlanNode, context: OptContext): PlanNode {
		let currentPlan = plan;

		for (const pass of this.sortedPasses) {
			log('Starting pass: %s', pass.name);

			if (pass.execute) {
				// Custom execution logic
				currentPlan = pass.execute(currentPlan, context);
			} else {
				// Standard rule-based execution
				currentPlan = this.executeStandardPass(currentPlan, context, pass);
			}

			log('Completed pass: %s', pass.name);
		}

		return currentPlan;
	}

	/**
	 * Execute a standard rule-based pass
	 */
	private executeStandardPass(
		plan: PlanNode,
		context: OptContext,
		pass: OptimizationPass
	): PlanNode {
		// This will be implemented to traverse the tree in the specified order
		// and apply the pass's rules at each node

		if (pass.traversalOrder === TraversalOrder.TopDown) {
			return this.traverseTopDown(plan, context, pass);
		} else {
			return this.traverseBottomUp(plan, context, pass);
		}
	}

	/**
	 * Top-down traversal with rule application
	 */
	private traverseTopDown(
		node: PlanNode,
		context: OptContext,
		pass: OptimizationPass
	): PlanNode {
		// Apply rules to this node first
		let currentNode = this.applyPassRules(node, context, pass);

		// Then traverse children
		const children = currentNode.getChildren();
		if (children.length > 0) {
			const newChildren = children.map(child =>
				this.traverseTopDown(child, context, pass)
			);

			// Only create new node if children changed
			const childrenChanged = children.some((child, i) => child !== newChildren[i]);
			if (childrenChanged) {
				currentNode = currentNode.withChildren(newChildren);
			}
		}

		return currentNode;
	}

	/**
	 * Bottom-up traversal with rule application
	 */
	private traverseBottomUp(
		node: PlanNode,
		context: OptContext,
		pass: OptimizationPass
	): PlanNode {
		// Traverse children first
		const children = node.getChildren();
		let currentNode = node;

		if (children.length > 0) {
			const newChildren = children.map(child =>
				this.traverseBottomUp(child, context, pass)
			);

			// Only create new node if children changed
			const childrenChanged = children.some((child, i) => child !== newChildren[i]);
			if (childrenChanged) {
				currentNode = currentNode.withChildren(newChildren);
			}
		}

		// Then apply rules to this node
		return this.applyPassRules(currentNode, context, pass);
	}

	/**
	 * Apply all rules in a pass to a node
	 */
	private applyPassRules(
		node: PlanNode,
		context: OptContext,
		pass: OptimizationPass
	): PlanNode {
		let currentNode = node;
		// Apply rules against the current node type only
		for (const rule of pass.rules) {
			if (rule.nodeType !== currentNode.nodeType) continue;
			const result = rule.fn(currentNode, context);
			if (result && result !== currentNode) {
				log('Rule %s transformed node in pass %s', rule.id, pass.id);
				currentNode = result;
			}
		}

		return currentNode;
	}
}
