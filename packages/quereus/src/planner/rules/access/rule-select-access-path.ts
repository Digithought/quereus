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
import type { PlanNode, ScalarPlanNode } from '../../nodes/plan-node.js';
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
import { extractConstraintsForTable, type PredicateConstraint as PlannerPredicateConstraint, createTableInfoFromNode } from '../../analysis/constraint-extractor.js';
import { LiteralNode } from '../../nodes/scalar.js';
import type * as AST from '../../../parser/ast.js';
import { IndexConstraintOp } from '../../../common/constants.js';

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

	// Always allow fallback to sequential scan to guarantee physicalization
	// even when no specialized support is available.

	// If grow-retrieve established an index-style context, reuse it directly
	if (isIndexStyleContext(retrieveNode.moduleCtx)) {
		log('Using index-style context provided by grow-retrieve');
		const accessPlan = retrieveNode.moduleCtx.accessPlan;
		const originalConstraints = retrieveNode.moduleCtx.originalConstraints as unknown as PlannerPredicateConstraint[];
		const physicalLeaf: RelationalPlanNode = selectPhysicalNode(retrieveNode.tableRef, accessPlan, originalConstraints) as unknown as RelationalPlanNode;
		if (retrieveNode.moduleCtx.residualPredicate) {
			return new FilterNode(retrieveNode.scope, physicalLeaf, retrieveNode.moduleCtx.residualPredicate);
		}
		return physicalLeaf;
	}

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
		// Extract constraints from grown pipeline in source using table instance key
		const tInfo = createTableInfoFromNode(retrieveNode.tableRef, `${tableSchema.schemaName}.${tableSchema.name}`);
		constraints = extractConstraintsForTable(retrieveNode.source, tInfo.relationKey);

		// Build request for getBestAccessPlan
		const request: BestAccessPlanRequest = {
			columns: tableSchema.columns.map((col, index) => ({
				index,
				name: col.name,
				type: col.logicalType,
				isPrimaryKey: col.primaryKey || false,
				isUnique: col.primaryKey || false // For now, assume only PK columns are unique
			} as ColumnMeta)),
			filters: constraints,
			estimatedRows: retrieveNode.tableRef.estimatedRows || undefined
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

	// Convert OrderingSpec[] to the format expected by physical nodes
	const providesOrdering = accessPlan.providesOrdering?.map(spec => ({
		column: spec.columnIndex,
		desc: spec.desc
	}));

	// --- Index-aware path: use module-provided index identity ---
	if (accessPlan.indexName && accessPlan.seekColumnIndexes && accessPlan.seekColumnIndexes.length > 0) {
		return selectPhysicalNodeFromPlan(tableRef, accessPlan, constraints, filterInfo, providesOrdering);
	}

	// --- Legacy fallback: infer access method from constraints and PK definition ---
	return selectPhysicalNodeLegacy(tableRef, accessPlan, constraints, filterInfo, providesOrdering);
}

/**
 * Index-aware physical node selection using module-provided indexName and seekColumnIndexes.
 * Works for both primary key and secondary indexes.
 */
function selectPhysicalNodeFromPlan(
	tableRef: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PlannerPredicateConstraint[],
	filterInfo: FilterInfo,
	providesOrdering: { column: number; desc: boolean }[] | undefined
): SeqScanNode | IndexScanNode | IndexSeekNode {
	const seekCols = accessPlan.seekColumnIndexes!;
	// Map accessPlan.indexName to physical node indexName ('_primary_' → 'primary')
	const physicalIndexName = accessPlan.indexName === '_primary_' ? 'primary' : accessPlan.indexName!;
	// idxStr uses the raw name (scan-plan builder maps '_primary_' → 'primary')
	const idxStrName = accessPlan.indexName!;

	// Build a map of constraints by column index for quick lookup
	const constraintsByCol = new Map<number, PlannerPredicateConstraint[]>();
	for (const c of constraints) {
		if (!constraintsByCol.has(c.columnIndex)) constraintsByCol.set(c.columnIndex, []);
		constraintsByCol.get(c.columnIndex)!.push(c);
	}

	// Determine handled columns
	const handledByCol = new Set<number>();
	constraints.forEach((c, i) => {
		if (accessPlan.handledFilters[i] === true) handledByCol.add(c.columnIndex);
	});

	// Check if all seek columns have equality constraints (= or single-value IN)
	const eqBySeekCol = new Map<number, PlannerPredicateConstraint>();
	let allEquality = true;
	for (const colIdx of seekCols) {
		const colConstraints = constraintsByCol.get(colIdx) ?? [];
		const eqConstraint = colConstraints.find(c =>
			(c.op === '=' || (c.op === 'IN' && Array.isArray(c.value) && (c.value as unknown[]).length === 1)) &&
			handledByCol.has(c.columnIndex)
		);
		if (eqConstraint) {
			eqBySeekCol.set(colIdx, eqConstraint);
		} else {
			allEquality = false;
			break;
		}
	}

	if (allEquality && eqBySeekCol.size === seekCols.length) {
		// Equality seek on all seek columns
		const seekKeys: ScalarPlanNode[] = seekCols.map(colIdx => {
			const c = eqBySeekCol.get(colIdx)!;
			if (c.valueExpr && !Array.isArray(c.valueExpr)) return c.valueExpr as unknown as ScalarPlanNode;
			const val = c.op === 'IN' && Array.isArray(c.value) ? (c.value as unknown[])[0] : c.value;
			const lit: AST.LiteralExpr = { type: 'literal', value: val } as unknown as AST.LiteralExpr;
			return new LiteralNode(tableRef.scope, lit);
		});

		const eqConstraints = seekCols.map((colIdx, i) => ({
			constraint: { iColumn: colIdx, op: IndexConstraintOp.EQ, usable: true },
			argvIndex: i + 1,
		}));
		const fi: FilterInfo = {
			...filterInfo,
			constraints: eqConstraints,
			idxStr: `idx=${idxStrName}(0);plan=2`,
		};

		log('Using index seek on %s (equality)', physicalIndexName);
		return new IndexSeekNode(
			tableRef.scope,
			tableRef,
			fi,
			physicalIndexName,
			seekKeys,
			false,
			providesOrdering,
			accessPlan.cost
		);
	}

	// Check for range constraints on the seek columns
	// Use the first (or only) seek column that has range constraints
	const rangeCol = seekCols.find(colIdx => {
		const colConstraints = constraintsByCol.get(colIdx) ?? [];
		return colConstraints.some(c => ['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex));
	});

	if (rangeCol !== undefined) {
		const colConstraints = constraintsByCol.get(rangeCol) ?? [];
		const lower = colConstraints.find(c => (c.op === '>' || c.op === '>=') && handledByCol.has(c.columnIndex));
		const upper = colConstraints.find(c => (c.op === '<' || c.op === '<=') && handledByCol.has(c.columnIndex));

		const seekKeys: ScalarPlanNode[] = [];
		const rangeConstraints: { constraint: { iColumn: number; op: number; usable: boolean }; argvIndex: number }[] = [];

		let argv = 1;
		if (lower) {
			rangeConstraints.push({ constraint: { iColumn: rangeCol, op: opToIndexOp(lower.op as any), usable: true }, argvIndex: argv });
			seekKeys.push(lower.valueExpr && !Array.isArray(lower.valueExpr) ? lower.valueExpr as any : new LiteralNode(tableRef.scope, { type: 'literal', value: lower.value } as any));
			argv++;
		}
		if (upper) {
			rangeConstraints.push({ constraint: { iColumn: rangeCol, op: opToIndexOp(upper.op as any), usable: true }, argvIndex: argv });
			seekKeys.push(upper.valueExpr && !Array.isArray(upper.valueExpr) ? upper.valueExpr as any : new LiteralNode(tableRef.scope, { type: 'literal', value: upper.value } as any));
			argv++;
		}

		const fi: FilterInfo = {
			...filterInfo,
			constraints: rangeConstraints as any,
			idxStr: `idx=${idxStrName}(0);plan=3`,
		};

		log('Using index seek (range) on %s', physicalIndexName);
		return new IndexSeekNode(
			tableRef.scope,
			tableRef,
			fi,
			physicalIndexName,
			seekKeys,
			true,
			providesOrdering,
			accessPlan.cost
		);
	}

	// Ordering-only index scan
	if (providesOrdering) {
		const orderingIndexName = accessPlan.orderingIndexName ?? physicalIndexName;
		const orderingIdxStr = orderingIndexName === 'primary' ? '_primary_' : orderingIndexName;
		log('Using index scan (ordering provided by %s)', orderingIndexName);

		const orderingFilterInfo: FilterInfo = {
			...filterInfo,
			idxStr: `idx=${orderingIdxStr}(0);plan=0`,
			indexInfoOutput: {
				...filterInfo.indexInfoOutput,
				idxStr: `idx=${orderingIdxStr}(0);plan=0`,
				orderByConsumed: true,
			}
		};

		return new IndexScanNode(
			tableRef.scope,
			tableRef,
			orderingFilterInfo,
			orderingIndexName,
			providesOrdering,
			accessPlan.cost
		);
	}

	// Fall back to sequential scan
	log('Using sequential scan (index %s: no usable seek/range constraints)', physicalIndexName);
	return createSeqScan(tableRef, filterInfo, accessPlan.cost);
}

/**
 * Legacy physical node selection for backward compatibility when module
 * doesn't provide indexName/seekColumnIndexes (PK-based heuristics).
 */
function selectPhysicalNodeLegacy(
	tableRef: TableReferenceNode,
	accessPlan: BestAccessPlanResult,
	constraints: PlannerPredicateConstraint[],
	filterInfo: FilterInfo,
	providesOrdering: { column: number; desc: boolean }[] | undefined
): SeqScanNode | IndexScanNode | IndexSeekNode {
	// Analyze the access plan to determine node type
	const handledByCol = new Set<number>();
	constraints.forEach((c, i) => {
		if (accessPlan.handledFilters[i] === true) handledByCol.add(c.columnIndex);
	});
	const eqHandled = constraints.filter(c => c.op === '=');
	const hasEqualityConstraints = eqHandled.length > 0;
	const hasRangeConstraints = constraints.some(c => ['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex));

	const maybeRows = accessPlan.rows || 0;
	const pkCols = tableRef.tableSchema.primaryKeyDefinition ?? [];
	const eqByCol = new Map<number, PlannerPredicateConstraint>();
	for (const c of eqHandled) eqByCol.set(c.columnIndex, c);
	const coversPk = pkCols.length > 0 && pkCols.every(pk => eqByCol.has(pk.index));
	const treatAsHandledPk = coversPk && pkCols.every(pk => handledByCol.has(pk.index) || eqByCol.has(pk.index));

	if ((hasEqualityConstraints && coversPk || treatAsHandledPk) && maybeRows <= 10) {
		const seekKeys = pkCols.map(pk => {
			const c = eqByCol.get(pk.index)!;
			if (c.valueExpr) return c.valueExpr as unknown as ScalarPlanNode;
			const lit: AST.LiteralExpr = { type: 'literal', value: c.value } as unknown as AST.LiteralExpr;
			return new LiteralNode(tableRef.scope, lit);
		});

		const eqConstraints = pkCols.map((pk, i) => ({
			constraint: { iColumn: pk.index, op: IndexConstraintOp.EQ, usable: true },
			argvIndex: i + 1,
		}));
		const fi: FilterInfo = {
			...filterInfo,
			constraints: eqConstraints,
			idxStr: 'idx=_primary_(0);plan=2',
		};

		log('Using index seek on primary key (legacy)');
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

	if (hasRangeConstraints) {
		const rangeCols = constraints
			.filter(c => ['>', '>=', '<', '<='].includes(c.op) && handledByCol.has(c.columnIndex))
			.sort((a, b) => a.columnIndex - b.columnIndex);

		const primaryFirstCol = (tableRef.tableSchema.primaryKeyDefinition?.[0]?.index) ?? (rangeCols[0]?.columnIndex ?? 0);
		const lower = rangeCols.find(c => c.columnIndex === primaryFirstCol && (c.op === '>' || c.op === '>='));
		const upper = rangeCols.find(c => c.columnIndex === primaryFirstCol && (c.op === '<' || c.op === '<='));

		const seekKeys: ScalarPlanNode[] = [];
		const rangeConstraints: { constraint: { iColumn: number; op: number; usable: boolean }; argvIndex: number }[] = [];

		let argv = 1;
		if (lower) {
			rangeConstraints.push({ constraint: { iColumn: primaryFirstCol, op: opToIndexOp(lower.op as any), usable: true }, argvIndex: argv });
			seekKeys.push(lower.valueExpr ? lower.valueExpr as any : new LiteralNode(tableRef.scope, { type: 'literal', value: lower.value } as any));
			argv++;
		}
		if (upper) {
			rangeConstraints.push({ constraint: { iColumn: primaryFirstCol, op: opToIndexOp(upper.op as any), usable: true }, argvIndex: argv });
			seekKeys.push(upper.valueExpr ? upper.valueExpr as any : new LiteralNode(tableRef.scope, { type: 'literal', value: upper.value } as any));
			argv++;
		}

		const fi: FilterInfo = {
			...filterInfo,
			constraints: rangeConstraints as any,
			idxStr: 'idx=_primary_(0);plan=3',
		};

		log('Using index seek (range) on primary key (legacy)');
		return new IndexSeekNode(
			tableRef.scope,
			tableRef,
			fi,
			'primary',
			seekKeys,
			true,
			providesOrdering,
			accessPlan.cost
		);
	}

	if (providesOrdering) {
		const indexName = accessPlan.orderingIndexName ?? 'primary';
		log('Using index scan (ordering provided by %s)', indexName);

		const indexIdxStr = indexName === 'primary' ? '_primary_' : indexName;
		const orderingFilterInfo: FilterInfo = {
			...filterInfo,
			idxStr: `idx=${indexIdxStr}(0);plan=0`,
			indexInfoOutput: {
				...filterInfo.indexInfoOutput,
				idxStr: `idx=${indexIdxStr}(0);plan=0`,
				orderByConsumed: true,
			}
		};

		return new IndexScanNode(
			tableRef.scope,
			tableRef,
			orderingFilterInfo,
			indexName,
			providesOrdering,
			accessPlan.cost
		);
	}

	log('Using sequential scan (no beneficial index access)');
	return createSeqScan(tableRef, filterInfo, accessPlan.cost);
}

// Narrow module context originating from grow-retrieve index-style fallback
function isIndexStyleContext(ctx: unknown): ctx is { kind: 'index-style'; accessPlan: BestAccessPlanResult; residualPredicate?: ScalarPlanNode; originalConstraints: unknown[] } {
	return !!ctx && typeof ctx === 'object' && (ctx as any).kind === 'index-style';
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

function opToIndexOp(op: '>' | '>=' | '<' | '<='): number {
  switch (op) {
    case '>': return IndexConstraintOp.GT as unknown as number;
    case '>=': return IndexConstraintOp.GE as unknown as number;
    case '<': return IndexConstraintOp.LT as unknown as number;
    case '<=': return IndexConstraintOp.LE as unknown as number;
    default: return IndexConstraintOp.GE as unknown as number;
  }
}
