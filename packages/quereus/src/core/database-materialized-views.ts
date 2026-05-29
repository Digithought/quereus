/**
 * Materialized-view maintenance: schema-change staleness tracking (phase 1) plus
 * incremental on-commit maintenance (phase 2).
 *
 * Two responsibilities:
 *
 *  1. **Staleness** — a *schema* change to a source table (drop / alter) can break
 *     an MV's body. This manager subscribes to schema-change events and marks any
 *     MV whose body reads a modified/removed source `stale`. The next reference
 *     re-validates the body (erroring with the staleness diagnostic on an
 *     incompatible change); the next successful refresh clears the flag. Applies
 *     to every MV regardless of refresh policy.
 *
 *  2. **Incremental maintenance** (third consumer of `DeltaExecutor`, after
 *     assertions and watchers) — for an `on-commit-incremental` MV, a
 *     `DeltaSubscription` runs *after* commit (change log alive, connections
 *     committed) and **writes** the backing table: per affected binding it
 *     delete-then-upserts the recomputed slice; a `'global'` binding or the
 *     cost-fallback triggers a full rebuild. Failed maintenance logs-and-skips
 *     and never rolls the user's commit back (mirrors `database-watchers.ts`).
 *
 * The maintenance write path bypasses the user write-boundary via
 * `MemoryTableManager.applyMaintenance` (delete/upsert) and `replaceBaseLayer`
 * (rebuild) — both manager-level, off the user-transaction path.
 */

import type { SchemaManager } from '../schema/manager.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import { createLogger } from '../common/logger.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode, type SqlValue, type Row } from '../common/types.js';
import { Scheduler } from '../runtime/scheduler.js';
import { emitPlanNode } from '../runtime/emitters.js';
import { EmissionContext } from '../runtime/emission-context.js';
import type { RuntimeContext } from '../runtime/types.js';
import { createStrictRowContextMap, wrapTableContextsStrict } from '../runtime/strict-fork.js';
import { isAsyncIterable } from '../runtime/utils.js';
import { BlockNode } from '../planner/nodes/block.js';
import { PlanNode, type ScalarPlanNode } from '../planner/nodes/plan-node.js';
import { ColumnReferenceNode, TableReferenceNode } from '../planner/nodes/reference.js';
import { AggregateNode } from '../planner/nodes/aggregate-node.js';
import { PlanNodeType } from '../planner/nodes/plan-node-type.js';
import type { BindingMode, PlanBindings } from '../planner/analysis/binding-extractor.js';
import { buildSourceUnionScope } from '../planner/analysis/change-scope.js';
import { injectKeyFilter } from '../planner/analysis/key-filter.js';
import {
	DeltaExecutor,
	type DeltaApplyInput,
	type DeltaExecutorContext,
	type DeltaSubscription,
} from '../runtime/delta-executor.js';
import { rebuildBacking, getBackingManager } from '../runtime/emit/materialized-view-helpers.js';
import { buildPrimaryKeyFromValues } from '../vtab/memory/utils/primary-key.js';
import type { BTreeKeyForPrimary } from '../vtab/memory/types.js';
import type { MaintenanceOp } from '../vtab/memory/layer/manager.js';
import type { MaterializedViewSchema } from '../schema/view.js';
import type { Database } from './database.js';
import type * as AST from '../parser/ast.js';

const log = createLogger('core:materialized-views');
const warnLog = log.extend('warn');

/**
 * Database internals the materialized-view manager needs. Mirrors
 * `AssertionEvaluatorContext` / `WatcherManagerContext` — keeps the manager
 * decoupled from the full `Database`.
 */
export interface MaterializedViewManagerContext {
	readonly schemaManager: SchemaManager;
	readonly optimizer: Database['optimizer'];
	readonly options: Database['options'];

	_buildPlan(statements: AST.Statement[]): import('./database.js').BuildPlanResult;
	_findTable(tableName: string, schemaName?: string): ReturnType<Database['_findTable']>;
	getInstructionTracer(): ReturnType<Database['getInstructionTracer']>;

	getChangedBaseTables(): Set<string>;
	getChangedTuples(base: string, columnIndices: readonly number[], pkIndices: readonly number[]): SqlValue[][];
	registerCaptureSpec(baseTable: string, spec: { extraColumns: ReadonlySet<number> }): () => void;
}

/** Pre-compiled residual artifacts for a single non-global binding of an MV body. */
interface ResidualArtifacts {
	scheduler: Scheduler;
	/** Source-table column indices, bound as `pk0..`/`gk0..` per the prefix. */
	bindColumns: number[];
	paramPrefix: 'pk' | 'gk';
	/**
	 * How to build the backing-table delete key from a binding tuple, or `null`
	 * when the binding does not map cleanly onto the (physical) MV-PK — such a
	 * relation's changes fall back to a full rebuild (always correct).
	 *
	 * `bindingTupleOrder[j]` = the binding-tuple index supplying physical-PK
	 * column `j`'s value.
	 */
	deleteKeyOrder: number[] | null;
}

/** Cached per-MV incremental compilation. */
interface CompiledIncrementalMV {
	bindings: PlanBindings;
	baseTablesInPlan: Set<string>;
	pkIndicesByBase: Map<string, number[]>;
	residualsByRelation: Map<string, ResidualArtifacts>;
	/** Backing-table physical primary-key definition (column order the btree keys on). */
	backingPkDefinition: ReadonlyArray<{ index: number; desc?: boolean; collation?: string }>;
	captureDisposers: Array<() => void>;
	subscriptionDisposer: () => void;
}

export class MaterializedViewManager {
	private unsubscribeSchemaChanges: (() => void) | null = null;
	private readonly executor: DeltaExecutor;
	/** Compiled incremental entries keyed by `schema.name` (lowercase). */
	private readonly incremental = new Map<string, CompiledIncrementalMV>();

	constructor(private readonly ctx: MaterializedViewManagerContext) {
		const executorCtx: DeltaExecutorContext = {
			getChangedBaseTables: () => ctx.getChangedBaseTables(),
			getChangedTuples: (base, cols, pk) => ctx.getChangedTuples(base, cols, pk),
			getRowCount: (base) => {
				const [schemaName, tableName] = base.split('.');
				const table = ctx._findTable(tableName, schemaName);
				return table?.estimatedRows;
			},
			deltaPerRowFallbackRatio: ctx.optimizer.tuning.deltaPerRowFallbackRatio,
		};
		this.executor = new DeltaExecutor(executorCtx);
		this.subscribeToSchemaChanges();
	}

	private subscribeToSchemaChanges(): void {
		const notifier = this.ctx.schemaManager.getChangeNotifier();
		this.unsubscribeSchemaChanges = notifier.addListener((event: SchemaChangeEvent) => {
			if (event.type === 'table_removed' || event.type === 'table_modified') {
				const changed = `${event.schemaName}.${event.objectName}`.toLowerCase();
				for (const mv of this.ctx.schemaManager.getAllMaterializedViews()) {
					if (mv.sourceTables.includes(changed)) {
						if (!mv.stale) {
							mv.stale = true;
							log('Marked materialized view %s.%s stale due to %s on %s', mv.schemaName, mv.name, event.type, changed);
						}
						// A source schema change invalidates any compiled residual; detach
						// the incremental subscription. The MV reads "stale" until refreshed
						// or recreated, which re-registers it.
						this.releaseEntry(mvKey(mv.schemaName, mv.name));
					}
				}
			} else if (event.type === 'materialized_view_removed') {
				this.releaseEntry(mvKey(event.schemaName, event.objectName));
			}
		});
	}

	/**
	 * Compile + register an MV for incremental maintenance if its policy is
	 * `on-commit-incremental`. No-op for `manual`. Throws (with the offending
	 * `'global'` sources named) when the body is not incrementally maintainable
	 * — the create emitter rolls the MV back on throw.
	 */
	registerMaterializedView(mv: MaterializedViewSchema): void {
		if (mv.refreshPolicy?.kind !== 'on-commit-incremental') return;
		// Cache the source-union change-scope so a `select` from this MV projects to
		// its sources in `analyzeChangeScope` (the backing table is never written
		// through the user change log — it is maintained at COMMIT). v1 is the
		// conservative union of a `full` watch per source table.
		mv.sourceScope = buildSourceUnionScope(mv.sourceTables);
		const key = mvKey(mv.schemaName, mv.name);
		this.releaseEntry(key);
		const compiled = this.compile(mv);
		const subscription = this.buildSubscription(mv, compiled);
		compiled.subscriptionDisposer = this.executor.register(subscription);
		this.incremental.set(key, compiled);
		log('Registered incremental materialized view %s.%s', mv.schemaName, mv.name);
	}

	/** Detach an MV's incremental subscription + capture demand (DROP path). */
	unregisterMaterializedView(schemaName: string, name: string): void {
		this.releaseEntry(mvKey(schemaName, name));
	}

	/**
	 * Fire incremental maintenance for every MV impacted by the current commit.
	 * Mirrors the watcher contract: invoked after all connections commit but
	 * before the change log clears; per-MV apply errors are logged and swallowed
	 * (a failing MV never rolls the user's commit back).
	 */
	async runPostCommit(): Promise<void> {
		if (this.incremental.size === 0) return;
		try {
			await this.executor.runAll();
		} catch (err) {
			// apply() swallows its own errors; this is defensive against a kernel throw.
			log('Post-commit materialized-view maintenance threw: %O', err);
		}
	}

	dispose(): void {
		if (this.unsubscribeSchemaChanges) {
			this.unsubscribeSchemaChanges();
			this.unsubscribeSchemaChanges = null;
		}
		for (const key of [...this.incremental.keys()]) {
			this.releaseEntry(key);
		}
		this.executor.disposeAll();
	}

	private releaseEntry(key: string): void {
		const entry = this.incremental.get(key);
		if (!entry) return;
		this.incremental.delete(key);
		try { entry.subscriptionDisposer(); } catch (err) { log('MV subscription disposer for %s threw: %O', key, err); }
		for (const d of entry.captureDisposers) {
			try { d(); } catch (err) { log('MV capture disposer for %s threw: %O', key, err); }
		}
		entry.captureDisposers.length = 0;
	}

	/* ─────────────────────────── compilation ─────────────────────────── */

	private compile(mv: MaterializedViewSchema): CompiledIncrementalMV {
		const db = this.ctx as unknown as Database;
		const { plan } = this.ctx._buildPlan([mv.selectAst as AST.Statement]);
		const analyzed = this.ctx.optimizer.optimizeForAnalysis(plan, db) as BlockNode;

		// Derive maintenance bindings directly. NOTE: we deliberately do NOT use
		// `extractBindings`' classification here — its 'row'/'group' is *equality-
		// pinned* (it reports a bare MV scan, and a group-by over non-key columns,
		// as 'global'), which is the right notion for assertions/watchers but not
		// for MV maintenance. MV maintenance binds on a source's identity:
		//   - an aggregate over bare source columns → 'group' on those columns;
		//   - otherwise a row-preserving body → 'row' on the source's primary key.
		// v1 supports single-source bodies; joins / set-ops are out of scope.
		const tableRefByRelKey = collectTableRefs(analyzed);
		if (tableRefByRelKey.size !== 1) {
			const bases = [...tableRefByRelKey.values()]
				.map(r => `${r.tableSchema.schemaName}.${r.tableSchema.name}`.toLowerCase());
			throw new QuereusError(
				`materialized view '${mv.name}': 'on-commit-incremental' refresh supports single-source bodies in v1, `
					+ `but the body reads [${[...new Set(bases)].join(', ') || '(no source table)'}]; use 'manual' refresh`,
				StatusCode.UNSUPPORTED,
			);
		}
		const [srcRelKey, srcRef] = [...tableRefByRelKey.entries()][0];
		const srcBase = `${srcRef.tableSchema.schemaName}.${srcRef.tableSchema.name}`.toLowerCase();
		const srcAttrToCol = new Map<number, number>();
		srcRef.getAttributes().forEach((a, i) => srcAttrToCol.set(a.id, i));

		const perRelation = new Map<string, BindingMode>();
		const relationToBase = new Map<string, string>([[srcRelKey, srcBase]]);

		const agg = findAggregate(analyzed);
		if (agg) {
			if (agg.groupBy.length === 0) {
				throw new QuereusError(
					`materialized view '${mv.name}': 'on-commit-incremental' refresh does not support `
						+ `whole-table aggregate (no GROUP BY) bodies; use 'manual' refresh`,
					StatusCode.UNSUPPORTED,
				);
			}
			const groupColumns: number[] = [];
			for (const expr of agg.groupBy) {
				const col = expr instanceof ColumnReferenceNode ? srcAttrToCol.get(expr.attributeId) : undefined;
				if (col === undefined) {
					throw new QuereusError(
						`materialized view '${mv.name}': 'on-commit-incremental' refresh requires GROUP BY over bare `
							+ `source columns; use 'manual' refresh`,
						StatusCode.UNSUPPORTED,
					);
				}
				groupColumns.push(col);
			}
			perRelation.set(srcRelKey, { kind: 'group', groupColumns });
		} else {
			const pkCols = srcRef.tableSchema.primaryKeyDefinition.map(d => d.index);
			if (pkCols.length === 0) {
				throw new QuereusError(
					`materialized view '${mv.name}': 'on-commit-incremental' refresh requires the source to have a `
						+ `primary key; use 'manual' refresh`,
					StatusCode.UNSUPPORTED,
				);
			}
			perRelation.set(srcRelKey, { kind: 'row', keyColumns: pkCols });
		}
		const bindings: PlanBindings = { perRelation, relationToBase };

		const baseTablesInPlan = new Set<string>();
		const pkIndicesByBase = new Map<string, number[]>();
		for (const base of bindings.relationToBase.values()) {
			baseTablesInPlan.add(base);
			if (!pkIndicesByBase.has(base)) {
				const [schemaName, tableName] = base.split('.');
				const table = this.ctx._findTable(tableName, schemaName);
				if (table) pkIndicesByBase.set(base, table.primaryKeyDefinition.map(d => d.index));
			}
		}

		// Register projection capture for binding columns outside the PK (PK is
		// always captured implicitly). Mirrors the assertion path's recordExtras.
		const captureDisposers: Array<() => void> = [];
		const extraByBase = new Map<string, Set<number>>();
		const recordExtras = (base: string, cols: readonly number[]): void => {
			const pkSet = new Set<number>(pkIndicesByBase.get(base) ?? []);
			for (const c of cols) {
				if (pkSet.has(c)) continue;
				let set = extraByBase.get(base);
				if (!set) { set = new Set<number>(); extraByBase.set(base, set); }
				set.add(c);
			}
		};
		for (const [relKey, mode] of bindings.perRelation) {
			const base = bindings.relationToBase.get(relKey);
			if (!base) continue;
			if (mode.kind === 'row') recordExtras(base, mode.keyColumns);
			else if (mode.kind === 'group') recordExtras(base, mode.groupColumns);
		}
		for (const [base, extra] of extraByBase) {
			captureDisposers.push(this.ctx.registerCaptureSpec(base, { extraColumns: extra }));
		}

		// Backing-table physical PK (the column order the btree keys on).
		const backing = this.ctx._findTable(mv.backingTableName, mv.schemaName);
		if (!backing) {
			throw new QuereusError(
				`Internal error: backing table '${mv.backingTableName}' for materialized view '${mv.name}' not found`,
				StatusCode.INTERNAL,
			);
		}
		const backingPkDefinition = backing.primaryKeyDefinition.map(d => ({ index: d.index, desc: d.desc, collation: d.collation }));
		const physicalPkOutCols = backingPkDefinition.map(d => d.index);

		// Pre-compile per-relation residuals + delete-key plans.
		const residualsByRelation = new Map<string, ResidualArtifacts>();
		const producingByAttrId = collectProducingExprs(analyzed);
		for (const [relKey, mode] of bindings.perRelation) {
			if (mode.kind === 'global') continue;
			const bindCols = mode.kind === 'row' ? mode.keyColumns : mode.groupColumns;
			const paramPrefix: 'pk' | 'gk' = mode.kind === 'row' ? 'pk' : 'gk';
			const rewritten = injectKeyFilter(analyzed, relKey, bindCols, paramPrefix);
			const optimizedPlan = this.ctx.optimizer.optimize(rewritten, db) as BlockNode;
			const instruction = emitPlanNode(optimizedPlan, new EmissionContext(db));
			const scheduler = new Scheduler(instruction);
			const deleteKeyOrder = computeDeleteKeyOrder(
				analyzed, tableRefByRelKey.get(relKey), producingByAttrId, bindCols, physicalPkOutCols,
			);
			residualsByRelation.set(relKey, { scheduler, bindColumns: [...bindCols], paramPrefix, deleteKeyOrder });
		}

		return {
			bindings,
			baseTablesInPlan,
			pkIndicesByBase,
			residualsByRelation,
			backingPkDefinition,
			captureDisposers,
			subscriptionDisposer: () => { /* replaced by register() */ },
		};
	}

	private buildSubscription(mv: MaterializedViewSchema, compiled: CompiledIncrementalMV): DeltaSubscription {
		const db = this.ctx as unknown as Database;
		const bindingsForExecutor = new Map<string, BindingMode>(compiled.bindings.perRelation);
		const relationToBase = new Map<string, string>(compiled.bindings.relationToBase);
		const pkIndicesByBase = new Map<string, readonly number[]>(compiled.pkIndicesByBase);

		const apply = async (input: DeltaApplyInput): Promise<void> => {
			try {
				// Any global relation (a 'global' binding — rejected at create — or a
				// cost-fallback demotion) makes a full rebuild the only correct option.
				if (input.globalRelations.size > 0) {
					await rebuildBacking(db, mv);
					return;
				}

				const ops: MaintenanceOp[] = [];
				for (const [relKey, tuples] of input.perRelationTuples) {
					const residual = compiled.residualsByRelation.get(relKey);
					if (!residual || residual.deleteKeyOrder === null) {
						// No clean per-binding delete mapping — rebuild (always correct).
						await rebuildBacking(db, mv);
						return;
					}
					for (const tuple of tuples) {
						const key = this.buildDeleteKey(compiled, residual.deleteKeyOrder, tuple);
						ops.push({ kind: 'delete-key', key });
						const recomputed = await this.runResidual(residual, tuple);
						for (const row of recomputed) ops.push({ kind: 'upsert', row });
					}
				}

				if (ops.length === 0) return;
				const backing = this.ctx.schemaManager.getTable(mv.schemaName, mv.backingTableName);
				if (!backing) {
					throw new QuereusError(
						`Internal error: backing table '${mv.backingTableName}' for materialized view '${mv.name}' not found`,
						StatusCode.INTERNAL,
					);
				}
				await getBackingManager(backing).applyMaintenance(ops);
			} catch (err) {
				// Maintenance failure logs-and-skips; the user's commit stands.
				warnLog('Incremental maintenance for %s.%s failed (commit stands): %O', mv.schemaName, mv.name, err);
			}
		};

		return {
			id: `materialized-view:${mv.schemaName}.${mv.name}`,
			dependencies: compiled.baseTablesInPlan,
			bindings: bindingsForExecutor,
			relationToBase,
			pkIndicesByBase,
			apply,
			dispose: () => { /* resources released by releaseEntry */ },
		};
	}

	/** Build a backing-table delete key from a binding tuple, in physical-PK order. */
	private buildDeleteKey(
		compiled: CompiledIncrementalMV,
		deleteKeyOrder: number[],
		tuple: readonly SqlValue[],
	): BTreeKeyForPrimary {
		const keyValues: SqlValue[] = deleteKeyOrder.map(i => tuple[i]);
		return buildPrimaryKeyFromValues(keyValues, compiled.backingPkDefinition);
	}

	/** Run a residual scheduler for one binding tuple and collect its output rows. */
	private async runResidual(residual: ResidualArtifacts, tuple: readonly SqlValue[]): Promise<Row[]> {
		const params: Record<string, SqlValue> = {};
		for (let i = 0; i < tuple.length; i++) {
			params[`${residual.paramPrefix}${i}`] = tuple[i];
		}
		const runtimeCtx: RuntimeContext = {
			db: this.ctx as unknown as Database,
			stmt: undefined,
			params,
			context: createStrictRowContextMap(),
			tableContexts: wrapTableContextsStrict(new Map()),
			tracer: this.ctx.getInstructionTracer(),
			enableMetrics: this.ctx.options.getBooleanOption('runtime_stats'),
		};
		const result = await residual.scheduler.run(runtimeCtx);
		const rows: Row[] = [];
		if (isAsyncIterable(result)) {
			for await (const row of result as AsyncIterable<Row>) rows.push(row);
		}
		return rows;
	}
}

/* ─────────────────────────── helpers ─────────────────────────── */

function mvKey(schemaName: string, name: string): string {
	return `${schemaName}.${name}`.toLowerCase();
}

/** Aggregate node types (logical + physical) — the analyzed plan may carry any. */
const AGGREGATE_NODE_TYPES = new Set<PlanNodeType>([
	PlanNodeType.Aggregate,
	PlanNodeType.StreamAggregate,
	PlanNodeType.HashAggregate,
]);

/** Structural view of an aggregate node shared by the logical/physical variants. */
interface AggregateLike {
	readonly groupBy: readonly ScalarPlanNode[];
	readonly aggregates: readonly { readonly expression: ScalarPlanNode }[];
}

/** Find the first aggregate node anywhere in the plan (single-source bodies in v1). */
function findAggregate(node: PlanNode): AggregateLike | undefined {
	if (AGGREGATE_NODE_TYPES.has(node.nodeType)) return node as unknown as AggregateLike;
	for (const child of node.getChildren()) {
		const found = findAggregate(child as unknown as PlanNode);
		if (found) return found;
	}
	return undefined;
}

/** Collect `relationKey → TableReferenceNode` over a plan. */
function collectTableRefs(node: PlanNode, out = new Map<string, TableReferenceNode>()): Map<string, TableReferenceNode> {
	if (node instanceof TableReferenceNode) {
		const base = `${node.tableSchema.schemaName}.${node.tableSchema.name}`.toLowerCase();
		out.set(`${base}#${node.id ?? 'unknown'}`, node);
	}
	for (const child of node.getChildren()) collectTableRefs(child as unknown as PlanNode, out);
	return out;
}

/** Minimal duck-type for nodes (aggregates) that expose attribute provenance. */
interface HasProducingExprs { getProducingExprs(): Map<number, ScalarPlanNode>; }

/**
 * Merge attribute provenance (output attr id → producing scalar expr) from every
 * node that exposes it. Physical aggregates expose `getProducingExprs()`; the
 * logical {@link AggregateNode} present in the pre-physical analyzed plan does
 * not, so its group-by → output-attr mapping is reconstructed directly here.
 */
function collectProducingExprs(node: PlanNode, out = new Map<number, ScalarPlanNode>()): Map<number, ScalarPlanNode> {
	const fn = (node as Partial<HasProducingExprs>).getProducingExprs;
	if (typeof fn === 'function') {
		for (const [attrId, expr] of fn.call(node)) {
			if (!out.has(attrId)) out.set(attrId, expr);
		}
	} else if (node instanceof AggregateNode) {
		const attrs = node.getAttributes();
		node.groupBy.forEach((expr, i) => {
			const attr = attrs[i];
			if (attr && !out.has(attr.id)) out.set(attr.id, expr);
		});
		node.aggregates.forEach((agg, i) => {
			const attr = attrs[node.groupBy.length + i];
			if (attr && !out.has(attr.id)) out.set(attr.id, agg.expression);
		});
	}
	for (const child of node.getChildren()) collectProducingExprs(child as unknown as PlanNode, out);
	return out;
}

/**
 * Compute how to project a binding tuple onto the backing table's physical
 * primary key for the per-binding delete. Returns `bindingTupleOrder` where
 * entry `j` is the binding-tuple index supplying physical-PK column `j`'s value,
 * or `null` when the binding does not cover the full physical PK cleanly (the
 * caller then falls back to a full rebuild).
 *
 * Provenance: a passthrough output column forwards its source attribute id, so
 * its id is directly the source column's id; an aggregate group-by column mints
 * a fresh id but `getProducingExprs()` maps it back to the group-by expression
 * (a `ColumnReferenceNode` whose `attributeId` is the source column's id).
 */
function computeDeleteKeyOrder(
	analyzedRoot: BlockNode,
	tableRef: TableReferenceNode | undefined,
	producingByAttrId: Map<number, ScalarPlanNode>,
	bindColumns: readonly number[],
	physicalPkOutCols: readonly number[],
): number[] | null {
	if (!tableRef) return null;

	// source attribute id → source column index, for the target table reference.
	const sourceAttrToCol = new Map<number, number>();
	tableRef.getAttributes().forEach((a, i) => sourceAttrToCol.set(a.id, i));

	// binding source-column index → its position in the binding tuple.
	const sourceColToBindPos = new Map<number, number>();
	bindColumns.forEach((c, i) => sourceColToBindPos.set(c, i));

	const rootAttrs = relationalAttributes(analyzedRoot);
	if (!rootAttrs) return null;

	const order: number[] = [];
	for (const pkOutCol of physicalPkOutCols) {
		const attr = rootAttrs[pkOutCol];
		if (!attr) return null;
		const sourceCol = resolveSourceCol(attr.id, sourceAttrToCol, producingByAttrId);
		if (sourceCol === undefined) return null;
		const bindPos = sourceColToBindPos.get(sourceCol);
		if (bindPos === undefined) return null;
		order.push(bindPos);
	}
	return order;
}

/** Resolve an output attribute id back to a source column index, via provenance. */
function resolveSourceCol(
	outAttrId: number,
	sourceAttrToCol: Map<number, number>,
	producingByAttrId: Map<number, ScalarPlanNode>,
): number | undefined {
	const direct = sourceAttrToCol.get(outAttrId);
	if (direct !== undefined) return direct;
	const expr = producingByAttrId.get(outAttrId);
	if (expr instanceof ColumnReferenceNode) {
		return sourceAttrToCol.get(expr.attributeId);
	}
	return undefined;
}

/** Read the output attributes of a block's final relational statement. */
function relationalAttributes(block: BlockNode): ReturnType<TableReferenceNode['getAttributes']> | undefined {
	const children = block.getChildren();
	for (let i = children.length - 1; i >= 0; i--) {
		const child = children[i] as unknown as { getAttributes?: () => ReturnType<TableReferenceNode['getAttributes']> };
		if (typeof child.getAttributes === 'function') return child.getAttributes();
	}
	return undefined;
}
