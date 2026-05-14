/**
 * Delta executor kernel.
 *
 * A reusable dispatcher that any change-driven consumer (assertions today;
 * materialized views, reactive signals, triggers tomorrow) can register
 * subscriptions against. The kernel inspects per-subscription bindings
 * (`BindingMode`), collects the relevant changed binding tuples from the
 * TransactionManager's change capture, applies a cost-based fallback to
 * global re-evaluation when too many tuples would need per-binding dispatch,
 * and invokes the subscription's `apply` once with the resulting batches.
 *
 * The kernel itself is stateless across runs; subscriptions own their own
 * residual plan cache (no shared cache, since plan-shape generation is
 * consumer-specific).
 */

import { createLogger } from '../common/logger.js';
import type { SqlValue } from '../common/types.js';
import type { BindingMode } from '../planner/analysis/binding-extractor.js';

const log = createLogger('runtime:delta-executor');

/**
 * The slice of `Database` the kernel needs. Decoupled so subscriptions can
 * be unit-tested against a minimal mock.
 */
export interface DeltaExecutorContext {
	/** Changed base tables for the current commit. */
	getChangedBaseTables(): Set<string>;
	/** Projected tuples for a changed base table. PK columns are always
	 *  available; non-PK columns must be registered via `registerCaptureSpec`
	 *  before any DML records changes. */
	getChangedTuples(base: string, columnIndices: readonly number[], pkIndices: readonly number[]): SqlValue[][];
	/** Heuristic row count for cost fallback. Optional — when omitted the
	 *  kernel does not demote any bindings to global. */
	getRowCount?(base: string): number | undefined;
	/** Tuning parameter: ratio of changed-distinct-tuples to table row count
	 *  above which the kernel demotes a 'row'/'group' binding to 'global'. */
	readonly deltaPerRowFallbackRatio: number;
}

/**
 * Input to a subscription's `apply`. Carries per-relation tuple batches plus
 * a set of relations that should be re-evaluated globally (either because
 * the binding is 'global' or because the cost-fallback fired).
 */
export interface DeltaApplyInput {
	/** RelationKey → tuples to bind for that relation. Tuple order matches
	 *  the BindingMode's `keyColumns`/`groupColumns`. */
	readonly perRelationTuples: ReadonlyMap<string, readonly SqlValue[][]>;
	/** RelationKeys flagged for global re-evaluation. */
	readonly globalRelations: ReadonlySet<string>;
}

/**
 * A single change-driven consumer registered with the executor.
 */
export interface DeltaSubscription {
	/** Diagnostic id (e.g. 'assertion:no_negative_balance'). */
	readonly id: string;
	/** Base table dependencies (lowercased 'schema.table'). */
	readonly dependencies: ReadonlySet<string>;
	/** BindingMode per relationKey (one per TableReferenceNode instance). */
	readonly bindings: ReadonlyMap<string, BindingMode>;
	/** relationKey → base table (from PlanBindings). */
	readonly relationToBase: ReadonlyMap<string, string>;
	/** PK indices per base table; used to retrieve changed tuples. */
	readonly pkIndicesByBase: ReadonlyMap<string, readonly number[]>;
	/** Invoked once with the per-relation batches for this commit. */
	apply(input: DeltaApplyInput): Promise<void>;
	/** Release any external resources this subscription holds. */
	dispose(): void;
}

/**
 * Coordinates delta dispatch across all registered subscriptions.
 */
export class DeltaExecutor {
	private subscriptions = new Set<DeltaSubscription>();

	constructor(private readonly ctx: DeltaExecutorContext) {}

	/**
	 * Register a subscription. Returns a dispose handle that removes the
	 * subscription and calls its `dispose()`.
	 */
	register(sub: DeltaSubscription): () => void {
		this.subscriptions.add(sub);
		let disposed = false;
		return () => {
			if (disposed) return;
			disposed = true;
			this.subscriptions.delete(sub);
			sub.dispose();
		};
	}

	/** Dispose all subscriptions. */
	disposeAll(): void {
		for (const sub of this.subscriptions) {
			sub.dispose();
		}
		this.subscriptions.clear();
	}

	/**
	 * Run all impacted subscriptions. Throws on the first subscription's
	 * `apply` rejection — exceptions are surfaced unchanged so the COMMIT
	 * path can roll back.
	 */
	async runAll(): Promise<void> {
		if (this.subscriptions.size === 0) return;
		const changedBases = this.ctx.getChangedBaseTables();
		if (changedBases.size === 0) return;

		for (const sub of this.subscriptions) {
			await this.runOne(sub, changedBases);
		}
	}

	private async runOne(sub: DeltaSubscription, changedBases: Set<string>): Promise<void> {
		// Quick skip: if no dependency of the subscription changed at all.
		let any = false;
		for (const dep of sub.dependencies) {
			if (changedBases.has(dep)) { any = true; break; }
		}
		if (!any) return;

		const perRelationTuples = new Map<string, SqlValue[][]>();
		const globalRelations = new Set<string>();

		for (const [relKey, binding] of sub.bindings) {
			const base = sub.relationToBase.get(relKey);
			if (!base || !changedBases.has(base)) continue;

			if (binding.kind === 'global') {
				globalRelations.add(relKey);
				continue;
			}

			const cols = binding.kind === 'row' ? binding.keyColumns : binding.groupColumns;
			const pkIndices = sub.pkIndicesByBase.get(base);
			if (!pkIndices) {
				// No PK known for this base — can't fetch tuples; fall back to global.
				log('No PK for base %s; falling back to global for %s', base, sub.id);
				globalRelations.add(relKey);
				continue;
			}

			let tuples: SqlValue[][];
			try {
				tuples = this.ctx.getChangedTuples(base, cols, pkIndices);
			} catch (e) {
				// The requested columns aren't registered. Fall back to global
				// for safety — the subscription forgot to register a CaptureSpec.
				log('getChangedTuples failed for %s on %s (%s); falling back to global', sub.id, base, (e as Error).message);
				globalRelations.add(relKey);
				continue;
			}

			if (tuples.length === 0) {
				// Dependency changed but no captured tuples touched this binding —
				// nothing to dispatch for this relation.
				continue;
			}

			// Cost fallback: if the number of distinct binding tuples is a large
			// fraction of the base table size, doing N per-binding runs is likely
			// worse than one global run.
			const rowCount = this.ctx.getRowCount?.(base);
			if (rowCount !== undefined && rowCount > 0) {
				const ratio = tuples.length / rowCount;
				if (ratio >= this.ctx.deltaPerRowFallbackRatio) {
					log('Cost fallback for %s on %s: %d/%d ≥ %s — running global',
						sub.id, base, tuples.length, rowCount, this.ctx.deltaPerRowFallbackRatio);
					globalRelations.add(relKey);
					continue;
				}
			}

			perRelationTuples.set(relKey, tuples);
		}

		if (perRelationTuples.size === 0 && globalRelations.size === 0) {
			return;
		}

		const input: DeltaApplyInput = { perRelationTuples, globalRelations };
		await sub.apply(input);
	}
}
