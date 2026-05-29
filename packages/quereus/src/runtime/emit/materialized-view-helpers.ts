import type { Database } from '../../core/database.js';
import { QuereusError } from '../../common/errors.js';
import { StatusCode, type Row } from '../../common/types.js';
import type { PlanNode, RelationalPlanNode } from '../../planner/nodes/plan-node.js';
import { TableReferenceNode } from '../../planner/nodes/reference.js';
import { keysOf } from '../../planner/util/fd-utils.js';
import type { ColumnSchema } from '../../schema/column.js';
import { type TableSchema, type PrimaryKeyColumnDefinition, buildColumnIndexMap, requireVtabModule } from '../../schema/table.js';
import { MemoryTableModule } from '../../vtab/memory/module.js';
import type { MemoryTableManager } from '../../vtab/memory/layer/manager.js';

// Canonical body-hash lives next to the MV schema definition so the declarative
// differ can share it without depending on the runtime layer. Re-exported here
// for the create/refresh emitters that already import from this module.
export { computeBodyHash } from '../../schema/view.js';

/** Backing-table column/PK/ordering shape derived from the optimized body relation. */
export interface BackingShape {
	columns: ColumnSchema[];
	primaryKey: ReadonlyArray<{ index: number; desc: boolean }>;
	ordering?: ReadonlyArray<{ index: number; desc: boolean }>;
	/** Qualified (lowercased `schema.table`) source tables the body reads. */
	sourceTables: string[];
}

/**
 * Builds + optimizes the materialized-view body and derives the backing table's
 * column list, primary key, body ordering, and source-table dependencies.
 *
 * Columns and types come straight from the optimized relation's
 * {@link RelationalPlanNode.getType}; the PK is the first usable key from
 * `keysOf` (all-columns fallback when none — such an MV is incremental-ineligible
 * until Phase 2). Re-planning here is cheap relative to materialization and keeps
 * the create/refresh emitters free of optimizer plumbing.
 */
export function deriveBackingShape(
	db: Database,
	bodySql: string,
	explicitColumns: ReadonlyArray<string> | undefined,
): BackingShape {
	const plan = db.getPlan(bodySql);
	const root = plan.getRelations()[0];
	if (!root) {
		throw new QuereusError('materialized view body produced no relation', StatusCode.INTERNAL);
	}

	const relType = root.getType();
	const bodyColumns = relType.columns;
	const names = explicitColumns && explicitColumns.length > 0
		? explicitColumns
		: bodyColumns.map((c, i) => c.name || `col${i}`);

	const columns: ColumnSchema[] = bodyColumns.map((c, i) => ({
		name: names[i] ?? `col${i}`,
		logicalType: c.type.logicalType,
		notNull: c.type.nullable === false,
		primaryKey: false,
		pkOrder: 0,
		defaultValue: null,
		collation: c.type.collationName ?? 'BINARY',
		generated: false,
	}));

	// First usable key from the unified surface; all-columns fallback when none.
	const keys = keysOf(root);
	const pkIndices = keys.length > 0 ? [...keys[0]] : columns.map((_c, i) => i);
	const primaryKey = pkIndices.map(idx => ({ index: idx, desc: false }));

	const ordering = root.physical?.ordering?.map(o => ({ index: o.column, desc: o.desc }));

	return {
		columns,
		primaryKey,
		ordering: ordering && ordering.length > 0 ? ordering : undefined,
		sourceTables: collectSourceTables(plan),
	};
}

/** Walks the plan collecting qualified (lowercased) names of every base table referenced. */
function collectSourceTables(plan: PlanNode): string[] {
	const out = new Set<string>();
	const visited = new Set<PlanNode>();
	const walk = (node: PlanNode): void => {
		if (visited.has(node)) return;
		visited.add(node);
		if (node instanceof TableReferenceNode) {
			out.add(`${node.tableSchema.schemaName}.${node.tableSchema.name}`.toLowerCase());
		}
		for (const c of node.getChildren()) walk(c as unknown as PlanNode);
		for (const r of node.getRelations()) walk(r as unknown as PlanNode);
	};
	walk(plan);
	return [...out];
}

/**
 * Computes the backing table's *physical* primary key. When the body carries an
 * `order by`, the ordering columns lead the key so the btree clusters (and scans)
 * in the body's order — "seeding the backing-table ordering" — with the logical
 * key (from `keysOf`) appended as a uniqueness-preserving tiebreaker. Without an
 * `order by`, the physical key is just the logical key.
 *
 * NOTE: this diverges from {@link MaterializedViewSchema.primaryKey}, which keeps
 * the logical `keysOf` identity. The covering ticket replaces this seeding with a
 * proper materialized index.
 */
function computeBackingPrimaryKey(shape: BackingShape): ReadonlyArray<{ index: number; desc: boolean }> {
	if (!shape.ordering || shape.ordering.length === 0) {
		return shape.primaryKey;
	}
	const seeded: { index: number; desc: boolean }[] = [];
	const seen = new Set<number>();
	for (const o of shape.ordering) {
		if (!seen.has(o.index)) { seeded.push({ index: o.index, desc: o.desc }); seen.add(o.index); }
	}
	for (const k of shape.primaryKey) {
		if (!seen.has(k.index)) { seeded.push({ index: k.index, desc: k.desc }); seen.add(k.index); }
	}
	return seeded.length > 0 ? seeded : shape.primaryKey;
}

/**
 * Constructs the backing-table {@link TableSchema} for a materialized view from a
 * derived {@link BackingShape}. Module is always `memory` in v1.
 */
export function buildBackingTableSchema(
	db: Database,
	schemaName: string,
	backingTableName: string,
	shape: BackingShape,
): TableSchema {
	const moduleInfo = db.schemaManager.getModule('memory');
	if (!moduleInfo || !moduleInfo.module) {
		throw new QuereusError(`No virtual table module named 'memory'`, StatusCode.INTERNAL);
	}

	const backingPk = computeBackingPrimaryKey(shape);
	const pkDefinition: PrimaryKeyColumnDefinition[] = backingPk.map(pk => ({
		index: pk.index,
		desc: pk.desc,
		collation: shape.columns[pk.index]?.collation,
	}));
	// Reflect the physical PK in the column flags (cosmetic; the memory table reads
	// `primaryKeyDefinition`, but catalog/introspection consults column flags).
	backingPk.forEach((pk, order) => {
		const col = shape.columns[pk.index];
		if (col) { col.primaryKey = true; col.pkOrder = order + 1; }
	});

	return {
		name: backingTableName,
		schemaName,
		columns: Object.freeze(shape.columns),
		columnIndexMap: buildColumnIndexMap(shape.columns),
		primaryKeyDefinition: Object.freeze(pkDefinition),
		checkConstraints: Object.freeze([]),
		vtabModule: moduleInfo.module,
		vtabModuleName: 'memory',
		vtabArgs: {},
		vtabAuxData: moduleInfo.auxData,
		isView: false,
		estimatedRows: 0,
	};
}

/** Runs the body to completion and returns its rows (raw `Row` arrays). Uses the
 *  no-transaction-management primitive — the caller is already inside DDL execution. */
export async function collectBodyRows(db: Database, bodySql: string): Promise<Row[]> {
	const stmt = db.prepare(bodySql);
	try {
		const rows: Row[] = [];
		for await (const row of stmt._iterateRowsRaw()) {
			rows.push(row as Row);
		}
		return rows;
	} finally {
		await stmt.finalize();
	}
}

/** Resolves the {@link MemoryTableManager} backing a materialized view's table. */
export function getBackingManager(backingSchema: TableSchema): MemoryTableManager {
	const module = requireVtabModule(backingSchema);
	if (!(module instanceof MemoryTableModule)) {
		throw new QuereusError(
			`materialized view backing table '${backingSchema.name}' is not a memory table`,
			StatusCode.INTERNAL,
		);
	}
	const key = `${backingSchema.schemaName}.${backingSchema.name}`.toLowerCase();
	const manager = module.tables.get(key);
	if (!manager) {
		throw new QuereusError(`backing table manager not found for '${key}'`, StatusCode.INTERNAL);
	}
	return manager;
}

/** Re-validates a stale MV's body against the current source schemas. Throws the
 *  staleness diagnostic when the body no longer plans. Returns the optimized
 *  relational root on success. */
export function revalidateBody(db: Database, mvName: string, bodySql: string): RelationalPlanNode {
	let root: RelationalPlanNode | undefined;
	try {
		root = db.getPlan(bodySql).getRelations()[0];
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		throw new QuereusError(
			`materialized view '${mvName}' is stale; a source changed in an incompatible way — drop and recreate (${message})`,
			StatusCode.ERROR,
			e instanceof Error ? e : undefined,
		);
	}
	if (!root) {
		throw new QuereusError(
			`materialized view '${mvName}' is stale; a source changed in an incompatible way — drop and recreate`,
			StatusCode.ERROR,
		);
	}
	return root;
}
