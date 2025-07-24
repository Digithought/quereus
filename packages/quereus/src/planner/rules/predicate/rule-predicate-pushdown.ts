/**
 * Rule: Predicate Pushdown
 *
 * Required Characteristics:
 * - Node must be a FilterNode with a predicate
 * - Source must be a table access node or allow predicate pushdown
 * - Predicate must contain pushable constraints (column-constant comparisons)
 *
 * Applied When:
 * - Filter predicate contains constraints that can be pushed to virtual table
 * - Target table supports constraint handling via getBestAccessPlan
 *
 * Benefits: Reduces data transfer and computation by filtering at the source
 */

import { createLogger } from '../../../common/logger.js';
import type { PlanNode } from '../../nodes/plan-node.js';
import type { OptContext } from '../../framework/context.js';
import { FilterNode } from '../../nodes/filter.js';
import { TableReferenceNode } from '../../nodes/reference.js';
import { CapabilityDetectors, PlanNodeCharacteristics } from '../../framework/characteristics.js';
import { extractConstraints, createTableInfoFromNode, type PredicateConstraint, type TableInfo } from '../../analysis/constraint-extractor.js';
import { PlanNodeType } from '../../nodes/plan-node-type.js';
import type { Scope } from '../../scopes/scope.js';
import type { TableSchema } from '../../../schema/table.js';
import type { AnyVirtualTableModule } from '../../../vtab/module.js';

const log = createLogger('optimizer:rule:predicate-pushdown');

/**
 * Extended TableReferenceNode that can hold pushed-down constraints
 */
export class TableReferenceWithConstraintsNode extends TableReferenceNode {
	override readonly nodeType = PlanNodeType.TableReference; // Keep same type for compatibility

	constructor(
		scope: Scope,
		tableSchema: TableSchema,
		vtabModule: AnyVirtualTableModule,
		public readonly pushedConstraints: PredicateConstraint[],
		vtabAuxData?: unknown,
		estimatedCostOverride?: number
	) {
		super(scope, tableSchema, vtabModule, vtabAuxData, estimatedCostOverride);
	}

	override withChildren(newChildren: readonly PlanNode[]): PlanNode {
		if (newChildren.length !== 0) {
			return this; // No children
		}
		return this;
	}

	override toString(): string {
		const baseStr = super.toString();
		if (this.pushedConstraints.length > 0) {
			const constraintStrs = this.pushedConstraints.map(c =>
				`${c.attributeId}${c.op}${c.value}`
			);
			return `${baseStr} WITH CONSTRAINTS [${constraintStrs.join(', ')}]`;
		}
		return baseStr;
	}

	override getLogicalAttributes(): Record<string, unknown> {
		const base = super.getLogicalAttributes();
		return {
			...base,
			pushedConstraints: this.pushedConstraints.map(c => ({
				column: c.attributeId,
				op: c.op,
				value: c.value
			}))
		};
	}
}

export function rulePredicatePushdown(node: PlanNode, context: OptContext): PlanNode | null {
	// Guard: node must be a Filter
	if (node.nodeType !== PlanNodeType.Filter) {
		return null;
	}

	const filterNode = node as FilterNode;
	log('Analyzing filter for predicate pushdown: %s', filterNode.toString());

	// Check if the source supports predicate pushdown
	const source = filterNode.source;
	if (!canPushDownToSource(source)) {
		log('Source does not support predicate pushdown: %s', source.nodeType);
		return null;
	}

	// For now, focus on simple case: Filter directly over TableReference
	if (source.nodeType !== PlanNodeType.TableReference) {
		log('Pushdown not yet supported for source type: %s', source.nodeType);
		return null;
	}

	const tableRef = source as TableReferenceNode;

	// Create table info for constraint extraction
	const tableInfo = createTableInfoFromNode(tableRef, tableRef.toString());

	// Extract constraints from the filter predicate
	const extractionResult = extractConstraints(filterNode.predicate, [tableInfo]);

	// Check if we found any pushable constraints for this table
	const tableConstraints = extractionResult.constraintsByTable.get(tableInfo.relationName);
	if (!tableConstraints || tableConstraints.length === 0) {
		log('No pushable constraints found for table %s', tableInfo.relationName);
		return null;
	}

	log('Found %d pushable constraints for table %s', tableConstraints.length, tableInfo.relationName);

	// Check if the virtual table module supports constraint pushdown
	const vtabModule = tableRef.vtabModule;
	if (!('getBestAccessPlan' in vtabModule)) {
		log('Virtual table module does not support getBestAccessPlan - cannot push constraints');
		return null;
	}

	// Create new table reference with pushed constraints
	const tableWithConstraints = new TableReferenceWithConstraintsNode(
		tableRef.scope,
		tableRef.tableSchema,
		tableRef.vtabModule,
		tableConstraints,
		tableRef.vtabAuxData,
		tableRef.getTotalCost()
	);

	// If we have a residual predicate, keep the filter with the residual
	// Otherwise, return just the table with constraints
	if (extractionResult.residualPredicate) {
		log('Creating new filter with residual predicate');
		return new FilterNode(
			filterNode.scope,
			tableWithConstraints,
			extractionResult.residualPredicate
		);
	} else {
		log('All predicates pushed down, removing filter');
		return tableWithConstraints;
	}
}

/**
 * Check if a plan node supports predicate pushdown
 */
function canPushDownToSource(source: PlanNode): boolean {
	// For now, only support direct table references
	// TODO: Extend to support joins, subqueries, etc.

	if (source.nodeType === PlanNodeType.TableReference) {
		return true;
	}

	// Could check for other pushdown-capable nodes
	if (CapabilityDetectors.canPushDownPredicate(source)) {
		return true;
	}

	return false;
}
