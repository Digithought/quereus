import type * as AST from '../../parser/ast.js';
import type { TableSchema } from '../../schema/table.js';
import { classifyProjectionExpr } from './scalar-invertibility.js';
import { expressionToString } from '../../emit/ast-stringify.js';

/**
 * Update-lineage model — per-output-column provenance back onto base columns,
 * per `docs/view-updateability.md` § The Update Site Model.
 *
 * **Shipped scope (Phase 1).** This is the AST-driven, single-source lineage
 * the view-mutation rewrite consumes: a view body's projection list maps each
 * output column to either a writable base column (`base`) or a read-only
 * computed expression (`computed`). It is the dual of the optimizer's FD walk,
 * restricted to the single-source projection-and-filter shape.
 *
 * The doc additionally describes threading a richer `UpdateSite` /
 * `AttributeDefault` surface through `PhysicalProperties.computePhysical`
 * (so `query_plan()` can surface lineage and so arbitrary operator nesting
 * composes). That plan-node-threaded generalization is the Phase-2 foundation
 * and is intentionally NOT wired here — see the Status note in
 * docs/view-updateability.md.
 */

/** Attribute id — matches the `number` keys used by `attribute-provenance.ts`. */
export type AttributeId = number;

/** Where one view output column traces back to on the base table. */
export type ViewColumnLineage =
	| { readonly kind: 'base'; readonly baseColumnName: string }
	| { readonly kind: 'computed'; readonly expr: AST.Expression };

/** One output column of an updateable view body. */
export interface ViewColumn {
	readonly name: string;
	readonly lineage: ViewColumnLineage;
	/** True when the underlying base column is a generated column. */
	readonly generated: boolean;
}

/**
 * Derive the per-output-column lineage of a single-source projection-and-filter
 * view body from its `SELECT` AST and the resolved base table.
 *
 * - `select *` expands to every base column, each tracing to itself.
 * - a bare/aliased column reference traces to that base column (identity /
 *   rename — the only invertible profile in Phase 1).
 * - any other projection expression is `computed` (read-only).
 *
 * An explicit `CREATE VIEW v(a, b)` column list overrides the output names
 * positionally, leaving the lineage targets unchanged.
 */
export function deriveViewColumns(
	sel: AST.SelectStmt,
	baseTable: TableSchema,
	viewColumnsOverride?: ReadonlyArray<string>,
): ViewColumn[] {
	const columns: ViewColumn[] = [];

	for (const rc of sel.columns) {
		if (rc.type === 'all') {
			for (const col of baseTable.columns) {
				columns.push({
					name: col.name,
					lineage: { kind: 'base', baseColumnName: col.name },
					generated: !!col.generated,
				});
			}
			continue;
		}

		const lineage = classifyProjectionExpr(rc.expr);
		const name = rc.alias ?? (rc.expr.type === 'column' ? rc.expr.name : expressionToString(rc.expr));
		if (lineage.kind === 'base') {
			const baseCol = baseTable.columns.find(c => c.name.toLowerCase() === lineage.baseColumnName.toLowerCase());
			columns.push({
				name,
				lineage: { kind: 'base', baseColumnName: baseCol?.name ?? lineage.baseColumnName },
				generated: !!baseCol?.generated,
			});
		} else {
			columns.push({ name, lineage: { kind: 'computed', expr: rc.expr }, generated: false });
		}
	}

	if (viewColumnsOverride && viewColumnsOverride.length > 0) {
		for (let i = 0; i < viewColumnsOverride.length && i < columns.length; i++) {
			columns[i] = { ...columns[i], name: viewColumnsOverride[i] };
		}
	}

	return columns;
}
