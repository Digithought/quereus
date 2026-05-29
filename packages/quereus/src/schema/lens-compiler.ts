import type { Database } from '../core/database.js';
import type { Schema } from './schema.js';
import type { SchemaManager } from './manager.js';
import type { TableSchema } from './table.js';
import type { ViewSchema } from './view.js';
import type * as AST from '../parser/ast.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { astToString } from '../emit/ast-stringify.js';
import { buildLogicalConstraints, type LensSlot } from './lens.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('schema:lens-compiler');

/**
 * Lens compiler — the `apply schema X` step for a **logical** schema.
 *
 * For each declared logical table it: builds the logical spec, aligns it against
 * the basis schema (the default name-based aligner), produces the inlined
 * effective view body, populates the lens slot, and registers the body as an
 * ordinary `ViewSchema`. The query processor then sees a view; reads ride the
 * standard view-resolution path and writes ride view-updateability.
 *
 * v1 is **single-source, name-based** (see `docs/lens.md` § The Default Mapper):
 * a logical table maps to a name-matching basis table, and each logical column
 * to a name-matching basis column. Type/nullability conformance and the n-way
 * decomposition shape are deferred to the prover / decomposition tickets.
 */

/**
 * Deploys (or re-deploys) a logical schema's lens slots + compiled view bodies.
 *
 * Re-deploy semantics are **clear-and-rebuild**: every existing lens view + slot
 * in the logical schema is dropped, then rebuilt from the current declaration.
 * This is how asymmetric removal falls out for free — a logical table dropped
 * from the declaration is simply not rebuilt (its view + slot vanish), and the
 * basis is never touched (logical removals never cascade to basis storage; see
 * `docs/lens.md` § Deployment).
 */
export function deployLogicalSchema(
	db: Database,
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): void {
	validateLogicalDeclaration(declaredSchema, logicalSchemaName);

	const schemaManager = db.schemaManager;
	const logicalSchema = schemaManager.getSchemaOrFail(logicalSchemaName);

	// Infer the basis lazily, only when there is ≥1 logical table to align. An
	// empty logical declaration (e.g. re-applying X after all its tables are
	// removed) is a pure detach-everything operation and must NOT fail on basis
	// ambiguity — removal never depends on the basis (asymmetric removal).
	let basis: { schema: Schema; schemaName: string } | undefined;

	// Compile everything FIRST (basis alignment can throw — name mismatch, etc.).
	// Only after every table aligns successfully do we mutate the catalog, so a
	// failed re-apply leaves the existing lens state untouched (atomic deploy).
	const compiled: Array<{ slot: LensSlot; view: ViewSchema }> = [];
	for (const item of declaredSchema.items) {
		if (item.type !== 'declaredTable') continue;

		basis ??= inferDefaultBasis(schemaManager, logicalSchemaName);
		const logicalTable = schemaManager.buildLogicalTableSchema(item.tableStmt, logicalSchema.name);
		const compiledBody = compileDefaultBody(logicalTable, logicalSchemaName, basis.schema, basis.schemaName);

		const slot: LensSlot = {
			logicalTable,
			defaultBasis: { schemaName: basis.schemaName },
			override: undefined,
			compiledBody,
			attachedConstraints: buildLogicalConstraints(logicalTable),
		};
		const view: ViewSchema = {
			name: logicalTable.name,
			schemaName: logicalSchema.name,
			sql: astToString(compiledBody),
			selectAst: compiledBody,
			// Pin the consumer-facing column names to the *logical* declaration
			// (the contract), independent of the basis column casing. Equivalent
			// to `create view T(<logical cols>) as <body>`: `select * from X.T`
			// then surfaces the logical names, not whatever the basis happens to
			// spell them. Write-through is unaffected (positional passthrough).
			columns: logicalTable.columns.map(c => c.name),
			tags: logicalTable.tags,
		};
		compiled.push({ slot, view });
	}

	// Clear-and-rebuild: drop all current lens views + slots, then register the
	// freshly compiled set. A logical schema's views are exclusively lens bodies,
	// so dropping every view is safe and implements detach for tables removed
	// from the declaration (logical removals never touch basis storage).
	for (const view of Array.from(logicalSchema.getAllViews())) {
		logicalSchema.removeView(view.name);
	}
	logicalSchema.clearLensSlots();

	for (const { slot, view } of compiled) {
		logicalSchema.addLensSlot(slot);
		logicalSchema.addView(view);
		log('Deployed lens for %s.%s over %s', logicalSchemaName, slot.logicalTable.name, slot.defaultBasis.schemaName);
	}
}

/**
 * Rejects every physical construct under a logical declared schema, naming the
 * offending construct and the logical-schema context. Tags are allowed (they
 * are engine-facing and survive into the compiled view).
 */
export function validateLogicalDeclaration(
	declaredSchema: AST.DeclareSchemaStmt,
	logicalSchemaName: string,
): void {
	const ctx = `logical schema '${logicalSchemaName}'`;
	for (const item of declaredSchema.items) {
		switch (item.type) {
			case 'declaredTable': {
				if (item.tableStmt.moduleName) {
					throw new QuereusError(
						`lens: module association 'using ${item.tableStmt.moduleName}(...)' on table '${item.tableStmt.table.name}' is not allowed in ${ctx}; logical tables declare columns and constraints only`,
						StatusCode.ERROR,
					);
				}
				break;
			}
			case 'declaredIndex': {
				const kind = item.indexStmt.isUnique ? 'unique index' : 'index';
				throw new QuereusError(
					`lens: ${kind} '${item.indexStmt.index.name}' is not allowed in ${ctx}; indexes are a basis-layer construct (a materialized view over the basis)`,
					StatusCode.ERROR,
				);
			}
			case 'declaredMaterializedView': {
				throw new QuereusError(
					`lens: materialized view '${item.viewStmt.view.name}' is not allowed in ${ctx}; materialized views are a basis-layer construct`,
					StatusCode.ERROR,
				);
			}
			// declaredView / declaredSeed / declaredAssertion / declareIgnored:
			// not part of the logical-table surface in v1 — neither rejected nor
			// processed by the lens compiler (only declaredTable becomes a slot).
		}
	}
}

/**
 * Infers the default basis for a logical schema (MVP binding — there is no
 * `declare lens for X over Y` yet). The basis is the single registered
 * **physical** schema that contains ≥1 table, excluding the logical schema
 * itself and `temp`. See `docs/lens.md` § Default-basis inference.
 */
export function inferDefaultBasis(
	schemaManager: SchemaManager,
	logicalSchemaName: string,
): { schema: Schema; schemaName: string } {
	const lowerLogical = logicalSchemaName.toLowerCase();
	const candidates: Array<{ schema: Schema; schemaName: string }> = [];

	for (const schema of schemaManager._getAllSchemas()) {
		const lowerName = schema.name.toLowerCase();
		if (lowerName === lowerLogical) continue;
		if (lowerName === 'temp') continue;
		if (schema.kind !== 'physical') continue;

		let hasTable = false;
		for (const _t of schema.getAllTables()) { hasTable = true; break; }
		if (!hasTable) continue;

		candidates.push({ schema, schemaName: schema.name });
	}

	if (candidates.length === 1) {
		return candidates[0];
	}

	throw new QuereusError(
		`lens: cannot infer a default basis for logical schema '${logicalSchemaName}' (found ${candidates.length} candidates); supply 'declare lens for ${logicalSchemaName} over <basis>'`,
		StatusCode.ERROR,
	);
}

/**
 * The default name-based aligner: produces `select <logical columns> from B.T'`
 * for one logical table `L.T` over basis schema `B`.
 *
 * - The basis table is matched by name (case-insensitive).
 * - Each logical column is matched to a basis column by name (case-insensitive).
 * - The projection lists exactly the logical columns, in declaration order, so
 *   a basis table with extra columns is correctly projected down.
 *
 * The empty-key (singleton) case needs no special path: a `primary key ()`
 * logical table over a `primary key ()` basis table is an ordinary single-source
 * projection.
 */
export function compileDefaultBody(
	logicalTable: TableSchema,
	logicalSchemaName: string,
	basisSchema: Schema,
	basisSchemaName: string,
): AST.SelectStmt {
	const logicalName = logicalTable.name;
	const basisTable = basisSchema.getTable(logicalName);
	if (!basisTable) {
		throw new QuereusError(
			`lens: logical table '${logicalSchemaName}.${logicalName}' has no basis backing`,
			StatusCode.ERROR,
		);
	}

	const columns: AST.ResultColumn[] = [];
	for (const col of logicalTable.columns) {
		const basisColIdx = basisTable.columnIndexMap.get(col.name.toLowerCase());
		if (basisColIdx === undefined) {
			throw new QuereusError(
				`lens: logical column '${logicalSchemaName}.${logicalName}.${col.name}' has no basis backing`,
				StatusCode.ERROR,
			);
		}
		// Single source → an unqualified column reference is unambiguous. Reference
		// the basis column by its actual name; the consumer-facing column *names*
		// (and casing) are pinned to the logical declaration via the registered
		// view's explicit column list (see `deployLogicalSchema`), so the basis
		// spelling never leaks through `select * from Logical.T`.
		const basisColName = basisTable.columns[basisColIdx].name;
		columns.push({
			type: 'column',
			expr: { type: 'column', name: basisColName } as AST.ColumnExpr,
		});
	}

	return {
		type: 'select',
		columns,
		from: [{
			type: 'table',
			table: { type: 'identifier', name: basisTable.name, schema: basisSchemaName },
		}],
	};
}
