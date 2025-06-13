/**
 * Rule: Constant Folding
 *
 * Transforms: Relational nodes with constant scalar expressions → Same node with literals
 * Conditions: When relational nodes contain scalar expressions that can be folded
 * Benefits: Reduces runtime computation by evaluating constants at plan time
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { classifyConstants, applyConstPropagation, createConstFoldingContext } from '../../analysis/const-pass.js';
import { createRuntimeExpressionEvaluator } from '../../analysis/const-evaluator.js';

const log = createLogger('optimizer:rule:constant-folding');

export function ruleConstantFolding(node: PlanNode, context: OptContext): PlanNode | null {
	// Only apply to relational nodes that can have scalar expressions
	if (node.getType().typeClass !== 'relation') {
		return null;
	}

	const relationalNode = node as RelationalPlanNode;
	
	// Skip if this node doesn't have any scalar expressions to fold
	// We'll target nodes that commonly have expressions: Project, Filter, etc.
	const targetNodeTypes = new Set([
		'Project',    // Projection expressions
		'Filter',     // Predicate expressions
		'Window',     // Window function expressions
		'Aggregate',  // Aggregate expressions
		'Sort',       // Sort key expressions
		'Values',     // Literal values in VALUES clauses
		'Join'        // Join condition expressions
	]);

	if (!targetNodeTypes.has(node.nodeType)) {
		return null;
	}

	log('Applying constant folding to %s node %s', node.nodeType, node.id);

	// Apply constant folding using the full const-pass infrastructure
	return applyConstantFoldingToNode(relationalNode, context);
}

/**
 * Apply constant folding to a relational node using the const-pass infrastructure
 */
function applyConstantFoldingToNode(node: RelationalPlanNode, context: OptContext): RelationalPlanNode | null {
	try {
		// Create runtime expression evaluator
		const evaluator = createRuntimeExpressionEvaluator(context.db);
		const foldingContext = createConstFoldingContext(evaluator);
		
		// Classify constants in the tree
		classifyConstants(node, foldingContext);
		
		// Apply propagation
		const result = applyConstPropagation(node, foldingContext);
		
		if (result !== node) {
			log('Constant folding transformed node %s', node.nodeType);
			return result;
		}
		
		return null; // No changes
		
	} catch (error) {
		log('Failed to apply constant folding to node %s: %s', node.id, error);
		return null;
	}
} 