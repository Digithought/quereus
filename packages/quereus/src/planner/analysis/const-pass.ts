/**
 * Constant folding analysis for the Titan optimizer
 * 
 * This module implements the two-phase constant folding algorithm:
 * 1. Bottom-up classification: Assign ConstInfo to every node during post-order DFS
 * 2. Top-down propagation: Walk relational tree carrying known constant attributes
 * 
 * The goal is to collapse functionally constant sub-trees to LiteralNode or ValuesNode
 * using the existing runtime as the evaluation engine.
 */

import type { PlanNode, ScalarPlanNode, RelationalPlanNode } from '../nodes/plan-node.js';
import { PlanNodeType } from '../nodes/plan-node-type.js';
import type { SqlValue, MaybePromise } from '../../common/types.js';
import { LiteralNode } from '../nodes/scalar.js';
import { isFunctional } from '../framework/physical-utils.js';
import { createLogger } from '../../common/logger.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

const log = createLogger('optimizer:folding');

/**
 * Constant information classification for plan nodes
 * Internal to folding pass - not exported
 */
interface ConstInfoConst {
	kind: 'const';
	value: MaybePromise<SqlValue>;
}

interface ConstInfoDep {
	kind: 'dep';
	deps: Set<number>; // Set of AttributeId
}

interface ConstInfoVar {
	kind: 'non-const';
}

type ConstInfo = ConstInfoConst | ConstInfoDep | ConstInfoVar;

/**
 * Context for constant folding analysis
 */
export interface ConstFoldingContext {
	/** Map from node ID to ConstInfo classification */
	constInfo: Map<string, ConstInfo>;
	/** Set of known constant attribute IDs */
	knownConstAttrs: Set<number>;
	/** Evaluation function for constant expressions */
	evaluateExpression: (expr: ScalarPlanNode) => MaybePromise<SqlValue>;
}

/**
 * Create a new constant folding context
 */
export function createConstFoldingContext(
	evaluateExpression: (expr: ScalarPlanNode) => MaybePromise<SqlValue>
): ConstFoldingContext {
	return {
		constInfo: new Map(),
		knownConstAttrs: new Set(),
		evaluateExpression
	};
}

/**
 * Perform bottom-up constant classification on a plan tree
 */
export function classifyConstants(root: PlanNode, ctx: ConstFoldingContext): void {
	// Post-order DFS - classify children before parent
	const children = root.getChildren();
	for (const child of children) {
		classifyConstants(child, ctx);
	}

	// Classify this node based on its type and children
	const constInfo = classifyNode(root, ctx);
	ctx.constInfo.set(root.id, constInfo);

	log('Classified node %s (%s): %s', root.id, root.nodeType, 
		constInfo.kind === 'const' ? `const(${constInfo.value})` :
		constInfo.kind === 'dep' ? `dep([${Array.from(constInfo.deps).join(',')}])` :
		'non-const');
}

/**
 * Classify a single node based on its type and children
 */
function classifyNode(node: PlanNode, ctx: ConstFoldingContext): ConstInfo {
	// For scalar nodes, apply the classification rules
	if (node.getType().typeClass === 'scalar') {
		return classifyScalarNode(node as ScalarPlanNode, ctx);
	}

	// Relational nodes are initially non-const
	// Their attributes will be analyzed in the top-down pass
	return { kind: 'non-const' };
}

/**
 * Classify a scalar node according to constant folding rules
 */
function classifyScalarNode(node: ScalarPlanNode, ctx: ConstFoldingContext): ConstInfo {
	// Rule 1: LiteralNode → const with its value
	if (node.nodeType === PlanNodeType.Literal) {
		const literalNode = node as LiteralNode;
		return { kind: 'const', value: literalNode.expression.value };
	}

	// Rule 2: ColumnReference → dep with {attrId}
	if (node.nodeType === PlanNodeType.ColumnReference) {
		const colRef = node as any; // ColumnReferenceNode
		return { kind: 'dep', deps: new Set([colRef.attributeId]) };
	}

	// Rule 3: Other scalar nodes - check if functional and inspect children
	// First check if node is functional (safe to fold)
	if (!isFunctional(node.physical || { deterministic: true, readonly: true })) {
		return { kind: 'non-const' };
	}

	// Inspect children
	const children = node.getChildren();
	const childConstInfos: ConstInfo[] = [];
	
	for (const child of children) {
		const childInfo = ctx.constInfo.get(child.id);
		if (!childInfo) {
			throw new Error(`No ConstInfo found for child node ${child.id}`);
		}
		childConstInfos.push(childInfo);
	}

	// If all children are const → evaluate immediately → const
	if (childConstInfos.every(info => info.kind === 'const')) {
		try {
			// Evaluation may return a promise (e.g., for subqueries), but that's fine
			// We can store the promise directly in the literal value
			const value = ctx.evaluateExpression(node);
			return { kind: 'const', value };
		} catch (error) {
			log('Failed to evaluate constant expression %s: %s', node.nodeType, error);
			return { kind: 'non-const' };
		}
	}

	// If all children ∈ {const, dep} → dep with union of child deps
	if (childConstInfos.every(info => info.kind === 'const' || info.kind === 'dep')) {
		const allDeps = new Set<number>();
		for (const info of childConstInfos) {
			if (info.kind === 'dep') {
				for (const dep of info.deps) {
					allDeps.add(dep);
				}
			}
		}
		return { kind: 'dep', deps: allDeps };
	}

	// Otherwise → non-const
	return { kind: 'non-const' };
}

/**
 * Apply constant propagation and folding to a relational tree
 * This is the top-down pass that propagates known constant attributes
 */
export function applyConstPropagation(
	root: RelationalPlanNode,
	ctx: ConstFoldingContext
): RelationalPlanNode {
	return propagateConstants(root, ctx, new Set());
}

/**
 * Internal recursive function for constant propagation
 */
function propagateConstants(
	node: RelationalPlanNode,
	ctx: ConstFoldingContext,
	knownConstAttrs: Set<number>
): RelationalPlanNode {
	let hasChanges = false;
	const newlyConstAttrs = new Set<number>();

	// For relational nodes that produce expressions, use the generic interface
	if (node.getProducingExprs) {
		const producingExprs = node.getProducingExprs();
		const newExpressions = new Map<number, ScalarPlanNode>();
		
		for (const [attrId, expr] of producingExprs) {
			const exprInfo = ctx.constInfo.get(expr.id);
			
			if (exprInfo?.kind === 'const') {
				// Expression is constant - replace with literal
				const literalExpr = { type: 'literal' as const, value: exprInfo.value };
				const newLiteral = new LiteralNode(expr.scope, literalExpr);
				newExpressions.set(attrId, newLiteral);
				newlyConstAttrs.add(attrId);
				hasChanges = true;
				log('Folded constant expression to literal: %s = %s', expr.nodeType, exprInfo.value);
			} else if (exprInfo?.kind === 'dep' && isSubsetOf(exprInfo.deps, knownConstAttrs)) {
				// Expression depends only on known constants - evaluate and replace
				try {
					// Evaluation may return a promise, but we can store it directly
					const value = ctx.evaluateExpression(expr);
					const literalExpr = { type: 'literal' as const, value };
					const newLiteral = new LiteralNode(expr.scope, literalExpr);
					newExpressions.set(attrId, newLiteral);
					newlyConstAttrs.add(attrId);
					hasChanges = true;
					log('Evaluated dependent expression to literal: %s = %s', expr.nodeType, value);
				} catch (error) {
					log('Failed to evaluate dependent expression %s: %s', expr.nodeType, error);
				}
			}
		}
		
		// If we made changes, rebuild the node with new expressions
		if (hasChanges) {
			// For ProjectNode specifically (the most common case)
			if ('projections' in node) {
				const projNode = node as any; // ProjectNode
				const newProjections = projNode.projections.map((proj: any) => {
					const newExpr = newExpressions.get(proj.attributeId || -1);
					if (newExpr) {
						return { ...proj, node: newExpr };
					}
					return proj;
				});
				
				node = node.withChildren([
					...node.getRelations(),
					...newProjections.map((p: any) => p.node)
				]) as RelationalPlanNode;
			}
			// For other node types, would need specific handling here
		}
	}

	// Recurse to child relations with updated known constant attributes
	const updatedKnownAttrs = new Set([...knownConstAttrs, ...newlyConstAttrs]);
	const childRelations = node.getRelations();
	const newChildRelations: RelationalPlanNode[] = [];
	
	for (const child of childRelations) {
		// Translate known constant attributes through this node's mapping
		// For simplicity, we pass through all known attributes
		// In a more sophisticated implementation, we would map attribute IDs
		const newChild = propagateConstants(child, ctx, updatedKnownAttrs);
		newChildRelations.push(newChild);
		if (newChild !== child) {
			hasChanges = true;
		}
	}

	// If child relations changed, create new node
	if (hasChanges && newChildRelations.length > 0) {
		const allChildren = [...newChildRelations, ...node.getChildren().filter(c => c.getType().typeClass !== 'relation')];
		node = node.withChildren(allChildren) as RelationalPlanNode;
	}

	return node;
}

/**
 * Fold scalar expressions in a node (builder-level utility)
 */
export function foldScalars(
	expr: ScalarPlanNode,
	evaluateExpression: (expr: ScalarPlanNode) => MaybePromise<SqlValue>
): ScalarPlanNode {
	const ctx = createConstFoldingContext(evaluateExpression);
	
	// Classify the expression tree
	classifyConstants(expr, ctx);
	
	// Check if the root expression can be folded
	const rootInfo = ctx.constInfo.get(expr.id);
	if (rootInfo?.kind === 'const') {
		// Replace with literal
		const literalExpr = { type: 'literal' as const, value: rootInfo.value };
		return new LiteralNode(expr.scope, literalExpr);
	}

	// For non-constant expressions, we could recursively fold subexpressions
	// For now, return the original expression
	return expr;
}

/**
 * Utility function to check if set A is a subset of set B
 */
function isSubsetOf<T>(setA: Set<T>, setB: Set<T>): boolean {
	for (const elem of setA) {
		if (!setB.has(elem)) {
			return false;
		}
	}
	return true;
} 