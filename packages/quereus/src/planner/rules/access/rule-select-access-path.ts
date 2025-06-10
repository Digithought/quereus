/**
 * Rule: Select Access Path
 *
 * Transforms: TableScanNode → SeqScanNode | IndexScanNode | IndexSeekNode
 * Conditions: When logical table access needs to be made physical
 * Benefits: Enables cost-based access path selection and index utilization
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { Optimizer } from '../../optimizer.js';
import { TableScanNode } from '../../nodes/scan.js';
import { SeqScanNode, IndexScanNode, IndexSeekNode } from '../../nodes/physical-access-nodes.js';
import { extractConstraints } from '../../analysis/constraint-extractor.js';
import { seqScanCost, indexScanCost, indexSeekCost } from '../../cost/index.js';
import type { ColumnMeta, PredicateConstraint, BestAccessPlanRequest, BestAccessPlanResult, ConstraintOp } from '../../../vtab/best-access-plan.js';
import { PlanNode as BasePlanNode } from '../../nodes/plan-node.js';

const log = createLogger('optimizer:rule:select-access-path');

export function ruleSelectAccessPath(node: PlanNode, optimizer: Optimizer): PlanNode | null {
	// Guard: only apply to TableScanNode
	if (!(node instanceof TableScanNode)) {
		return null;
	}

	// Guard: already physical
	if (node.physical) {
		return null;
	}

	log('Selecting access path for table %s', node.source.tableSchema.name);

	try {
		// Get table schema and virtual table module
		const tableSchema = node.source.tableSchema;
		const vtabModule = tableSchema.vtabModule;

		// If no virtual table module, fall back to sequential scan
		if (!vtabModule || typeof vtabModule !== 'object' || !('getBestAccessPlan' in vtabModule)) {
			log('No getBestAccessPlan support, using sequential scan for %s', tableSchema.name);
			return createSeqScan(node);
		}

		// Extract constraints from current filter info
		const constraints = extractConstraintsFromFilterInfo(node, tableSchema);

		// Build request for getBestAccessPlan
		const request: BestAccessPlanRequest = {
			columns: tableSchema.columns.map((col, index) => ({
				index,
				name: col.name,
				type: col.affinity,
				isPrimaryKey: col.primaryKey || false,
				isUnique: col.primaryKey || false // For now, assume only PK columns are unique
			} as ColumnMeta)),
			filters: constraints,
			estimatedRows: node.source.estimatedRows
		};

		// Call getBestAccessPlan
		const accessPlan = (vtabModule as any).getBestAccessPlan(request) as BestAccessPlanResult;

		// Choose physical node based on access plan
		const physicalNode = selectPhysicalNode(node, accessPlan, constraints);

		log('Selected %s for table %s (cost: %f, rows: %s)',
			physicalNode.nodeType, tableSchema.name, accessPlan.cost, accessPlan.rows);

		return physicalNode;

	} catch (error) {
		log('Error selecting access path for %s: %s', node.source.tableSchema.name, error);
		// Fall back to sequential scan on error
		return createSeqScan(node);
	}
}

/**
 * Extract predicate constraints from FilterInfo
 */
function extractConstraintsFromFilterInfo(node: TableScanNode, tableSchema: any): PredicateConstraint[] {
	const constraints: PredicateConstraint[] = [];

	// Extract from FilterInfo.indexInfoOutput.aConstraint if available
	const indexConstraints = node.filterInfo.indexInfoOutput.aConstraint;
	if (indexConstraints) {
		for (let i = 0; i < indexConstraints.length; i++) {
			const constraint = indexConstraints[i];

			if (constraint && constraint.usable) {
				constraints.push({
					columnIndex: constraint.iColumn,
					op: mapConstraintOp(constraint.op),
					usable: constraint.usable,
					// Note: actual value would need to be extracted from args
					value: undefined
				});
			}
		}
	}

	return constraints;
}

/**
 * Map internal constraint op to public constraint op
 */
function mapConstraintOp(internalOp: number): ConstraintOp {
	// This mapping would need to be based on the actual constants used
	// For now, assume equality - in a real implementation this would map
	// from IndexConstraintOp constants to ConstraintOp
	return '=';
}

/**
 * Select the appropriate physical node based on access plan
 */
function selectPhysicalNode(
	originalNode: TableScanNode,
	accessPlan: BestAccessPlanResult,
	constraints: PredicateConstraint[]
): SeqScanNode | IndexScanNode | IndexSeekNode {

	// Analyze the access plan to determine node type
	const hasEqualityConstraints = constraints.some(c => c.op === '=' && accessPlan.handledFilters[constraints.indexOf(c)]);
	const hasRangeConstraints = constraints.some(c => ['>', '>=', '<', '<='].includes(c.op) && accessPlan.handledFilters[constraints.indexOf(c)]);

	// Convert OrderingSpec[] to the format expected by physical nodes
	const providesOrdering = accessPlan.providesOrdering?.map(spec => ({
		column: spec.columnIndex,
		desc: spec.desc
	}));

	// Decision logic for access method
	if (hasEqualityConstraints && (accessPlan.rows || 0) <= 10) {
		// Small result set with equality - use index seek
		log('Using index seek (equality constraint, small result)');
		return new IndexSeekNode(
			originalNode.scope,
			originalNode.source,
			originalNode.filterInfo,
			'primary', // Default to primary index
			[], // seekKeys would be populated from constraints
			false, // not a range
			providesOrdering,
			accessPlan.cost
		);
	} else if (hasRangeConstraints || providesOrdering) {
		// Range constraints or ordering required - use index scan
		log('Using index scan (range constraints or ordering)');
		return new IndexScanNode(
			originalNode.scope,
			originalNode.source,
			originalNode.filterInfo,
			'primary', // Default to primary index
			providesOrdering,
			accessPlan.cost
		);
	} else {
		// Fall back to sequential scan
		log('Using sequential scan (no beneficial index access)');
		return createSeqScan(originalNode, accessPlan.cost);
	}
}

/**
 * Create a sequential scan node
 */
function createSeqScan(originalNode: TableScanNode, cost?: number): SeqScanNode {
	const tableRows = originalNode.source.estimatedRows || 1000;
	const scanCost = cost ?? seqScanCost(tableRows);

	const seqScan = new SeqScanNode(
		originalNode.scope,
		originalNode.source,
		originalNode.filterInfo,
		scanCost
	);

	// Set physical properties
	BasePlanNode.setDefaultPhysical(seqScan, {
		estimatedRows: tableRows,
		readonly: true,
		deterministic: true,
		constant: false
	});

	return seqScan;
}
