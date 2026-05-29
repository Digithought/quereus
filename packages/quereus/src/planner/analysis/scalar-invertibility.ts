import { type ScalarPlanNode } from '../nodes/plan-node.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import type * as AST from '../../parser/ast.js';

/**
 * Invertibility profile of a scalar transformation on an update path, per
 * `docs/view-updateability.md` § Scalar Invertibility.
 *
 * - `passthrough` — the named argument is returned with a non-data-altering
 *   transformation; lineage threads through `arg` as if the call were absent
 *   (identity / column-rename / `collate`).
 * - `inverse` — the function has a deterministic inverse (Phase 1b+).
 * - `opaque` — no inverse known; the column becomes `computed` (read-only).
 *
 * **Phase 1 scope: identity + column-rename only.** Everything that is not a
 * bare column reference classifies as `opaque`. Phase 1b extends this to
 * `cast`-style wrappers, `coalesce(x, default)` on the FD-provable-non-null
 * path, and declared `passthrough`/`inverse` profiles.
 */
export type InvertibilityProfile =
	| { readonly kind: 'passthrough'; readonly arg: number }
	| { readonly kind: 'inverse' }
	| { readonly kind: 'opaque' };

/**
 * Classify a scalar plan node's invertibility on the update path. Phase 1:
 * a column reference (with or without an alias — a rename is still a column
 * reference) is `passthrough` on its single argument; everything else is
 * `opaque`.
 */
export function classifyInvertibility(node: ScalarPlanNode): InvertibilityProfile {
	if (node instanceof ColumnReferenceNode) {
		return { kind: 'passthrough', arg: 0 };
	}
	return { kind: 'opaque' };
}

/**
 * AST-level companion used by the view-mutation rewrite, which works on the
 * view body's `selectAst` projection list rather than the planned tree. A
 * projection that is a bare column reference is an invertible (identity/rename)
 * mapping onto that base column; anything else is a computed (read-only) column.
 *
 * Phase 1 mirrors {@link classifyInvertibility}: only `ColumnExpr` is
 * invertible.
 */
export type ProjectionLineage =
	| { readonly kind: 'base'; readonly baseColumnName: string }
	| { readonly kind: 'computed' };

export function classifyProjectionExpr(expr: AST.Expression): ProjectionLineage {
	if (expr.type === 'column') {
		return { kind: 'base', baseColumnName: expr.name };
	}
	return { kind: 'computed' };
}
