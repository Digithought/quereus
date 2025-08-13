/**
 * Rule: Predicate Pushdown (characteristic-driven)
 *
 * Goal: Move Filter predicates downward across safe commuting nodes (Sort, Distinct, eligible Project)
 * and into the Retrieve pipeline boundary so modules can execute or exploit them.
 *
 * Safe moves implemented now:
 * - Across Sort: always safe (ordering unaffected by selection)
 * - Across Distinct: safe for selection predicates (commute)
 * - Across Project: only if predicate references attribute IDs available below the Project source
 *   (we verify attribute-id coverage), and we keep predicate unchanged (IDs preserved by design)
 * - Into Retrieve: wrap Retrieve.source with a Filter
 *
 * Non-moves (for now):
 * - Across Limit/Offset (changes semantics)
 * - Across Aggregate/Window/Join (requires deeper analysis)
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode, RelationalPlanNode } from '../../nodes/plan-node.js';
import { isRelationalNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import { FilterNode } from '../../nodes/filter.js';
import { SortNode } from '../../nodes/sort.js';
import { DistinctNode } from '../../nodes/distinct-node.js';
import { ProjectNode } from '../../nodes/project-node.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { CapabilityDetectors } from '../../framework/characteristics.js';
import type { ScalarPlanNode } from '../../nodes/plan-node.js';
import { normalizePredicate } from '../../analysis/predicate-normalizer.js';
import { collectBindingsInExpr } from '../../analysis/binding-collector.js';
import { extractConstraints, createTableInfoFromNode } from '../../analysis/constraint-extractor.js';

const log = createLogger('optimizer:rule:predicate-pushdown');

export function rulePredicatePushdown(node: PlanNode, _context: OptContext): PlanNode | null {
	// Only act on Filter nodes
	if (node.nodeType !== PlanNodeType.Filter) return null;

	const filter = node as FilterNode;
  const normalized = normalizePredicate(filter.predicate);

	// If no relational child, nothing to do
	if (!isRelationalNode(filter.source)) return null;

	const pushed = tryPushDown(filter.source, normalized, filter.scope);
	if (!pushed) return null;

	return pushed;
}

function tryPushDown(child: RelationalPlanNode, predicate: ScalarPlanNode, scope: any): PlanNode | null {
  // Reach a Retrieve boundary: insert only the supported portion inside pipeline
	if (child instanceof RetrieveNode) {
    log('Pushing predicate into Retrieve pipeline (supported-only)');
    const tableInfo = createTableInfoFromNode(child.tableRef, child.tableRef.tableSchema.name);
    const extraction = extractConstraints(predicate, [tableInfo]);
    const supported = extraction.supportedPredicateByTable?.get(child.tableRef.tableSchema.name);

    if (!supported) {
      log('No supported portion for this retrieve; not pushing');
      return null;
    }

    const newInner = new FilterNode(child.source.scope, child.source, supported);
    const newBindings = [
      ...(child.bindings ?? []),
      ...collectBindingsInExpr(supported, child.tableRef)
    ];
    const updatedRetrieve = child.withPipeline(newInner, child.moduleCtx, newBindings);

    // If the supported portion equals the whole filter, remove original filter; else keep residual above
    if (!extraction.residualPredicate) {
      return updatedRetrieve;
    }
    return new FilterNode(scope, updatedRetrieve as unknown as RelationalPlanNode, extraction.residualPredicate);
	}

	// Across Sort
	if (child instanceof SortNode) {
		log('Pushing predicate below Sort');
		const under = child.source;
		const newUnder = new FilterNode(under.scope, under, predicate);
		return new SortNode(child.scope, newUnder, child.sortKeys);
	}

	// Across Distinct
	if (child instanceof DistinctNode) {
		log('Pushing predicate below Distinct');
		const under = child.source;
		const newUnder = new FilterNode(under.scope, under, predicate);
		return new DistinctNode(child.scope, newUnder);
	}

	// Across eligible Project
	if (child instanceof ProjectNode) {
		if (canPushAcrossProject(child, predicate)) {
			log('Pushing predicate below Project (eligible)');
			const under = child.source;
			const newUnder = new FilterNode(under.scope, under, predicate);
			// Rebuild Project with same projections over the filtered source
			return new ProjectNode(child.scope, newUnder, child.projections, undefined, undefined, child.preserveInputColumns);
		}
		return null;
	}

	// Default: do not push across other nodes
	return null;
}

function canPushAcrossProject(project: ProjectNode, predicate: ScalarPlanNode): boolean {
	// If project preserves input columns and all predicate-attested attributes exist below, it's safe.
	const sourceAttrIds = new Set(project.source.getAttributes().map(a => a.id));
	const referenced = collectReferencedAttributeIds(predicate);
	for (const id of referenced) {
		if (!sourceAttrIds.has(id)) return false;
	}
	return true;
}

function collectReferencedAttributeIds(expr: ScalarPlanNode): Set<number> {
	const ids = new Set<number>();
	walkExpr(expr, node => {
		if (CapabilityDetectors.isColumnReference(node)) {
			ids.add((node as any).attributeId as number);
		}
	});
	return ids;
}

function walkExpr(expr: ScalarPlanNode, fn: (n: ScalarPlanNode) => void): void {
	fn(expr);
	for (const c of expr.getChildren()) {
		// Only scalar children
		if (!isRelationalNode(c)) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			walkExpr(c as any as ScalarPlanNode, fn);
		}
	}
}



