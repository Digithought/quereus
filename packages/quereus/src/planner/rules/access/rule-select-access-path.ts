/**
 * Rule: Select Access Path
 *
 * Required Characteristics:
 * - Node must be a RetrieveNode representing a virtual table access boundary
 * - Module must support either supports() (query-based) or getBestAccessPlan() (index-based)
 *
 * Applied When:
 * - RetrieveNode needs to be converted to appropriate physical access method
 *
 * Benefits: Enables cost-based access path selection and module-specific execution
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { RemoteQueryNode } from '../../nodes/remote-query-node.js';
import { SeqScanNode, IndexScanNode, IndexSeekNode } from '../../nodes/table-access-nodes.js';
import { seqScanCost } from '../../cost/index.js';
import type { ColumnMeta, PredicateConstraint, BestAccessPlanRequest, BestAccessPlanResult } from '../../../vtab/best-access-plan.js';
import { FilterInfo } from '../../../vtab/filter-info.js';
import type { IndexConstraintUsage } from '../../../vtab/index-info.js';
import { TableReferenceNode } from '../../nodes/reference.js';

const log = createLogger('optimizer:rule:select-access-path');

export function ruleSelectAccessPath(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: node must be a RetrieveNode
	if (!(node instanceof RetrieveNode)) {
		return null;
	}

	const retrieveNode = node as RetrieveNode;
	const tableSchema = retrieveNode.tableRef.tableSchema;
	const vtabModule = retrieveNode.vtabModule;

	log('Selecting access path for retrieve over table %s', tableSchema.name);

	// Check if module supports query-based execution via supports() method
	if (vtabModule.supports && typeof vtabModule.supports === 'function') {
		log('Module has supports() method - checking support for current pipeline');

		// Check if module supports the current pipeline
		const assessment = vtabModule.supports(retrieveNode.source);

		if (assessment) {
			log('Pipeline supported - creating RemoteQueryNode (cost: %d)', assessment.cost);
			return new RemoteQueryNode(
				retrieveNode.scope,
				retrieveNode.source,
				retrieveNode.tableRef,
				assessment.ctx
			);
		} else {
			log('Pipeline not supported by module - falling back to sequential scan');
			return createSeqScan(retrieveNode.tableRef);
		}
	}

	// Check if module supports index-based execution via getBestAccessPlan() method
	if (vtabModule.getBestAccessPlan && typeof vtabModule.getBestAccessPlan === 'function') {
		log('Module has getBestAccessPlan() method - using index-based execution for %s', tableSchema.name);

		return createIndexBasedAccess(retrieveNode, context);
	}

	// Fall back to sequential scan if module has no access planning support
	log('No access planning support, using sequential scan for %s', tableSchema.name);
	return createSeqScan(retrieveNode.tableRef);
}

/**
 * Create index-based access for modules that support getBestAccessPlan()
 */
function createIndexBasedAccess(retrieveNode: RetrieveNode, context: OptContext): PlanNode {
	const tableSchema = retrieveNode.tableRef.tableSchema;
	const vtabModule = retrieveNode.vtabModule;

	// For now, use empty constraints since we haven't implemented constraint extraction yet
	const constraints: PredicateConstraint[] = [];

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
		estimatedRows: retrieveNode.tableRef.estimatedRows
	};

	// Use the vtab module's getBestAccessPlan method to get an optimized access plan
	const accessPlan = vtabModule.getBestAccessPlan!(context.db, tableSchema, request) as BestAccessPlanResult;

	// Choose physical node based on access plan
	const physicalNode = selectPhysicalNode(retrieveNode.tableRef, accessPlan, constraints);

	log('Selected %s for table %s (cost: %f, rows: %s)',
		physicalNode.nodeType, tableSchema.name, accessPlan.cost, accessPlan.rows);

	return physicalNode;
}

/**
 * Select the appropriate physical node based on access plan
 */
function selectPhysicalNode(
	tableRef: TableReferenceNode,
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
			tableRef.scope,
			tableRef,
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
			tableRef.scope,
			tableRef,
			filterInfo,
			'primary', // Default to primary index
			providesOrdering,
			accessPlan.cost
		);
	} else {
		// Fall back to sequential scan
		log('Using sequential scan (no beneficial index access)');
		return createSeqScan(tableRef, filterInfo, accessPlan.cost);
	}
}

/**
 * Create a sequential scan node
 */
function createSeqScan(tableRef: TableReferenceNode, filterInfo?: FilterInfo, cost?: number): SeqScanNode {
	const tableRows = tableRef.estimatedRows || 1000;
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
		tableRef.scope,
		tableRef,
		effectiveFilterInfo,
		scanCost
	);

	return seqScan;
}
