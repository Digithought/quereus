import type * as AST from '../../parser/ast.js';
import type { PlanningContext } from '../planning-context.js';
import {
	CreateMaterializedViewNode,
	RefreshMaterializedViewNode,
	DropMaterializedViewNode,
} from '../nodes/materialized-view-nodes.js';
import { planViewBody } from './create-view.js';
import { astToString, createMaterializedViewToString } from '../../emit/ast-stringify.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

/** Backing modules accepted in v1. The AST keeps the slot forward-compatible. */
const SUPPORTED_BACKING_MODULES = new Set(['memory', 'mem']);

/**
 * Builds a plan node for CREATE MATERIALIZED VIEW. Validates the body (reusing
 * the CREATE VIEW gate so DML bodies and arity mismatches are rejected with the
 * same diagnostics) and restricts the backing module to `mem()` in v1.
 */
export function buildCreateMaterializedViewStmt(ctx: PlanningContext, stmt: AST.CreateMaterializedViewStmt): CreateMaterializedViewNode {
	const schemaName = stmt.view.schema || ctx.db.schemaManager.getCurrentSchemaName();
	const viewName = stmt.view.name;

	if (stmt.moduleName && !SUPPORTED_BACKING_MODULES.has(stmt.moduleName.toLowerCase())) {
		throw new QuereusError(
			`only mem() backing is supported for materialized views in v1 (got '${stmt.moduleName}')`,
			StatusCode.UNSUPPORTED,
			undefined,
			stmt.view.loc?.start.line,
			stmt.view.loc?.start.column,
		);
	}

	// Validate the body: planViewBody rejects DML bodies and yields the body's
	// relational shape. Always run it so a DML body is rejected at plan time.
	const planned = planViewBody(ctx, viewName, stmt.select);

	if (stmt.columns && stmt.columns.length > 0) {
		const bodyArity = planned.getAttributes().length;
		if (stmt.columns.length !== bodyArity) {
			throw new QuereusError(
				`Materialized view '${viewName}' has ${stmt.columns.length} declared columns but body produces ${bodyArity}`,
				StatusCode.ERROR
			);
		}
	}

	// Reject body shapes incremental maintenance cannot handle yet, up front with
	// a clear diagnostic. Binding-based ('global' source) eligibility is checked
	// at runtime in the create emitter (it needs the optimized/analyzed body).
	if (stmt.refreshPolicy === 'on-commit-incremental') {
		rejectUnsupportedIncrementalBody(stmt.select, viewName);
	}

	const sql = createMaterializedViewToString(stmt);
	const bodySql = astToString(stmt.select);

	return new CreateMaterializedViewNode(
		ctx.scope,
		viewName,
		schemaName,
		stmt.ifNotExists,
		stmt.columns,
		stmt.select,
		bodySql,
		sql,
		stmt.tags ? Object.freeze({ ...stmt.tags }) : undefined,
		stmt.refreshPolicy
	);
}

/**
 * Reject body shapes `on-commit-incremental` maintenance does not support yet,
 * with diagnostics pointing at the tracking tickets. Bag-distinguishing set-ops
 * (UNION/INTERSECT/EXCEPT — anything but `union all`) are out of scope for v1.
 *
 * Recursive CTE bodies are *not* rejected here: a recursive fixpoint has no
 * bounded per-binding residual, so `compile()` classifies it as whole-MV
 * `'global'` and maintains it by a full rebuild on any source change (always
 * correct; not algorithmically incremental). True semi-naïve/DRed delta
 * evaluation is deferred to `materialized-view-recursive-semi-naive-delta`.
 */
function rejectUnsupportedIncrementalBody(select: AST.QueryExpr, viewName: string): void {
	if (select.type !== 'select') return;
	if (select.compound && select.compound.op !== 'unionAll') {
		throw new QuereusError(
			`materialized view '${viewName}': 'on-commit-incremental' refresh does not support `
				+ `${select.compound.op} set-operation bodies yet `
				+ `(filed: materialized-view-incremental-set-ops); use 'manual' refresh`,
			StatusCode.UNSUPPORTED,
		);
	}
}

/** Builds a plan node for REFRESH MATERIALIZED VIEW. */
export function buildRefreshMaterializedViewStmt(ctx: PlanningContext, stmt: AST.RefreshMaterializedViewStmt): RefreshMaterializedViewNode {
	const schemaName = stmt.name.schema || ctx.db.schemaManager.getCurrentSchemaName();
	return new RefreshMaterializedViewNode(ctx.scope, stmt.name.name, schemaName);
}

/** Builds a plan node for DROP MATERIALIZED VIEW. */
export function buildDropMaterializedViewStmt(ctx: PlanningContext, stmt: AST.DropStmt): DropMaterializedViewNode {
	const schemaName = stmt.name.schema || ctx.db.schemaManager.getCurrentSchemaName();
	return new DropMaterializedViewNode(ctx.scope, stmt.name.name, schemaName, stmt.ifExists);
}
