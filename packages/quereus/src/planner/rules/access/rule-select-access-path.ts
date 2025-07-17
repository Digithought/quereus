/**
 * Rule: Select Access Path
 *
 * Required Characteristics:
 * - Node must support table access operations (TableAccessCapable interface)
 * - Node must be relational (produces rows)
 * - Node must represent a logical table reference
 *
 * Applied When:
 * - Logical table access node needs to be converted to physical access method
 *
 * Benefits: Enables cost-based access path selection and index utilization
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { TableReferenceNode } from '../../nodes/reference.js';
import { SeqScanNode, IndexScanNode, IndexSeekNode } from '../../nodes/table-access-nodes.js';
import { seqScanCost } from '../../cost/index.js';
import type { ColumnMeta, PredicateConstraint, BestAccessPlanRequest, BestAccessPlanResult } from '../../../vtab/best-access-plan.js';
import { FilterInfo } from '../../../vtab/filter-info.js';
import type { IndexConstraintUsage } from '../../../vtab/index-info.js';
import { CapabilityDetectors, type TableAccessCapable } from '../../framework/characteristics.js';

const log = createLogger('optimizer:rule:select-access-path');

export function ruleSelectAccessPath(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: node must support table access operations
	if (!CapabilityDetectors.isTableAccess(node)) {
		return null;
	}

	// Additional check: ensure this is specifically a TableReferenceNode for now
	// (in the future, other table access nodes might need different handling)
	if (!(node instanceof TableReferenceNode)) {
		return null;
	}

	// Get table access characteristics
	const tableAccessNode = node as TableAccessCapable;
	const tableSchema = tableAccessNode.tableSchema;

	log('Selecting access path for table %s', tableSchema.name);

	try {
		// Get virtual table module from schema
		const vtabModule = tableSchema.vtabModule;

		// If no virtual table module, fall back to sequential scan
		if (!vtabModule || typeof vtabModule !== 'object' || !('getBestAccessPlan' in vtabModule)) {
			log('No getBestAccessPlan support, using sequential scan for %s', tableSchema.name);
			return createSeqScan(node as TableReferenceNode, undefined);
		}

		// Extract constraints from current filter info
		const constraints: PredicateConstraint[] = []; // TODO: Extract from parent Filter node if any

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
			estimatedRows: tableAccessNode.estimatedRows
		};

		// Call getBestAccessPlan
		const accessPlan = (vtabModule as any).getBestAccessPlan(context.db, tableSchema, request) as BestAccessPlanResult;

		// Choose physical node based on access plan
		const physicalNode = selectPhysicalNode(node as TableReferenceNode, accessPlan, constraints);

		log('Selected %s for table %s (cost: %f, rows: %s)',
			physicalNode.nodeType, tableSchema.name, accessPlan.cost, accessPlan.rows);

		return physicalNode;

	} catch (error) {
		log('Error selecting access path for %s: %s', tableSchema.name, error);
		// Fall back to sequential scan on error
		return createSeqScan(node as TableReferenceNode);
	}
}

/**
 * Select the appropriate physical node based on access plan
 */
function selectPhysicalNode(
	originalNode: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PredicateConstraint[]
): SeqScanNode | IndexScanNode | IndexSeekNode {

	// Create a default FilterInfo for the physical nodes
	const filterInfo: FilterInfo = {
		idxNum: 0,
		idxStr: 'fullscan',
		constraints: [],
		args: [],
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			aConstraintUsage: [] as IndexConstraintUsage[],
			idxNum: 0,
			idxStr: 'fullscan',
			orderByConsumed: false,
			estimatedCost: accessPlan.cost,
			estimatedRows: BigInt(accessPlan.rows || 1000),
			idxFlags: 0,
			colUsed: 0n,
		}
	};

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
			originalNode,
			filterInfo,
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
			originalNode,
			filterInfo,
			'primary', // Default to primary index
			providesOrdering,
			accessPlan.cost
		);
	} else {
		// Fall back to sequential scan
		log('Using sequential scan (no beneficial index access)');
		return createSeqScan(originalNode, filterInfo, accessPlan.cost);
	}
}

/**
 * Create a sequential scan node
 */
function createSeqScan(originalNode: TableReferenceNode, filterInfo?: FilterInfo, cost?: number): SeqScanNode {
	const tableRows = originalNode.estimatedRows || 1000;
	const scanCost = cost ?? seqScanCost(tableRows);

	// Create default FilterInfo if not provided
	const effectiveFilterInfo = filterInfo || {
		idxNum: 0,
		idxStr: 'fullscan',
		constraints: [],
		args: [],
		indexInfoOutput: {
			nConstraint: 0,
			aConstraint: [],
			nOrderBy: 0,
			aOrderBy: [],
			aConstraintUsage: [] as IndexConstraintUsage[],
			idxNum: 0,
			idxStr: 'fullscan',
			orderByConsumed: false,
			estimatedCost: scanCost,
			estimatedRows: BigInt(tableRows),
			idxFlags: 0,
			colUsed: 0n,
		}
	};

	const seqScan = new SeqScanNode(
		originalNode.scope,
		originalNode,
		effectiveFilterInfo,
		scanCost
	);

	return seqScan;
}
