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
import { isRelationalNode, type RelationalPlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { RetrieveNode } from '../../nodes/retrieve-node.js';
import { RemoteQueryNode } from '../../nodes/remote-query-node.js';
import { SeqScanNode, IndexScanNode, IndexSeekNode } from '../../nodes/table-access-nodes.js';
import { seqScanCost } from '../../cost/index.js';
import type { ColumnMeta, BestAccessPlanRequest, BestAccessPlanResult } from '../../../vtab/best-access-plan.js';
import { FilterInfo } from '../../../vtab/filter-info.js';
import type { IndexConstraintUsage } from '../../../vtab/index-info.js';
import { TableReferenceNode } from '../../nodes/reference.js';
import { FilterNode } from '../../nodes/filter.js';
import { extractConstraintsForTable, type PredicateConstraint as PlannerPredicateConstraint } from '../../analysis/constraint-extractor.js';
import { IndexConstraintOp } from '../../../common/constants.js';
import { LiteralNode } from '../../nodes/scalar.js';
import type * as AST from '../../../parser/ast.js';

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

	// Check if we have pre-computed access plan from ruleGrowRetrieve
	const indexCtx = retrieveNode.moduleCtx as any; // IndexStyleContext from grow rule
	let accessPlan: BestAccessPlanResult;
  let constraints: PlannerPredicateConstraint[];
	let residualPredicate: PlanNode | undefined;

	if (indexCtx?.accessPlan) {
		// Use pre-computed access plan from grow rule
		log('Using pre-computed access plan from grow rule');
		accessPlan = indexCtx.accessPlan;
		constraints = indexCtx.originalConstraints || [];
		residualPredicate = indexCtx.residualPredicate;
	} else {
		// Extract constraints from grown pipeline in source
		constraints = extractConstraintsForTable(retrieveNode.source, tableSchema.name);

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
		accessPlan = vtabModule.getBestAccessPlan!(context.db, tableSchema, request) as BestAccessPlanResult;
	}

  // Choose physical node based on access plan
  const physicalLeaf: RelationalPlanNode = selectPhysicalNode(retrieveNode.tableRef, accessPlan, constraints) as unknown as RelationalPlanNode;

  // If the Retrieve source contained a pipeline (e.g., Filter/Sort/Project), rebuild it above the physical leaf
  let rebuiltPipeline: RelationalPlanNode = physicalLeaf;
  if (retrieveNode.source !== retrieveNode.tableRef) {
    log('Rebuilding Retrieve pipeline above physical access node');
    rebuiltPipeline = rebuildPipelineWithNewLeaf(retrieveNode.source, retrieveNode.tableRef, physicalLeaf);
  }

  // Wrap with residual predicate if present (on top of rebuilt pipeline)
  let finalNode: PlanNode = rebuiltPipeline;
  if (residualPredicate) {
    log('Wrapping rebuilt pipeline with residual filter');
    finalNode = new FilterNode(rebuiltPipeline.scope, rebuiltPipeline as any, residualPredicate as any);
  }

  log('Selected access for table %s (cost: %f, rows: %s)', tableSchema.name, accessPlan.cost, accessPlan.rows);
  return finalNode;
}

/**
 * Rebuilds a relational pipeline by replacing the specified leaf with a new leaf.
 * Preserves all operators (e.g., Filter, Sort, Project) above the leaf.
 */
function rebuildPipelineWithNewLeaf(
  pipelineRoot: RelationalPlanNode,
  oldLeaf: RelationalPlanNode,
  newLeaf: RelationalPlanNode
): RelationalPlanNode {
  if (pipelineRoot === oldLeaf) {
    return newLeaf;
  }
  const children = pipelineRoot.getChildren();
  const newChildren: PlanNode[] = children.map(child => {
    if (isRelationalNode(child)) {
      return rebuildPipelineWithNewLeaf(child, oldLeaf, newLeaf);
    }
    return child; // keep scalar children unchanged
  });
  return pipelineRoot.withChildren(newChildren) as RelationalPlanNode;
}

/**
 * Select the appropriate physical node based on access plan
 */
function selectPhysicalNode(
	tableRef: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PlannerPredicateConstraint[]
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
  const handled = (c: PlannerPredicateConstraint) => accessPlan.handledFilters[constraints.indexOf(c)] === true;
  const eqHandled = constraints.filter(c => c.op === '=' && handled(c));
  const hasEqualityConstraints = eqHandled.length > 0;
  const hasRangeConstraints = constraints.some(c => ['>', '>=', '<', '<='].includes(c.op) && handled(c));

	// Convert OrderingSpec[] to the format expected by physical nodes
	const providesOrdering = accessPlan.providesOrdering?.map(spec => ({
		column: spec.columnIndex,
		desc: spec.desc
	}));

	// Decision logic for access method
  const maybeRows = accessPlan.rows || 0;
  const pkCols = tableRef.tableSchema.primaryKeyDefinition ?? [];
  const eqByCol = new Map<number, PlannerPredicateConstraint>();
  for (const c of eqHandled) eqByCol.set(c.columnIndex, c);
  const coversPk = pkCols.length > 0 && pkCols.every(pk => eqByCol.has(pk.index));

  if (hasEqualityConstraints && coversPk && maybeRows <= 10) {
    // Build seek keys (as ScalarPlanNode) and constraint wiring for runtime args
    const seekKeys = pkCols.map(pk => {
      const c = eqByCol.get(pk.index)!;
      if (c.valueExpr) return c.valueExpr as unknown as import('../../nodes/plan-node.js').ScalarPlanNode;
      const lit: AST.LiteralExpr = { type: 'literal', value: c.value } as unknown as AST.LiteralExpr;
      return new LiteralNode(tableRef.scope, lit);
    });

    // Build FilterInfo with EQ constraints carrying argvIndex placeholders
    const eqConstraints = pkCols.map((pk, i) => ({
      constraint: { iColumn: pk.index, op: IndexConstraintOp.EQ, usable: true },
      argvIndex: i + 1,
    }));
    const fi: FilterInfo = {
      ...filterInfo,
      constraints: eqConstraints,
      // idxStr plan=2 (equality); include primary idx tag for clarity
      idxStr: 'idx=_primary_(0);plan=2',
    };

    log('Using index seek on primary key');
    return new IndexSeekNode(
      tableRef.scope,
      tableRef,
      fi,
      'primary',
      seekKeys,
      false,
      providesOrdering,
      accessPlan.cost
    );
  }

  if (hasRangeConstraints || providesOrdering) {
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
