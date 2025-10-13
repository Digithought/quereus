import type { Row, SqlValue, OutputValue } from '../common/types.js';
import type { RowDescriptor } from '../planner/nodes/plan-node.js';
import type { RuntimeContext } from './types.js';
import type { Database } from '../core/database.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createRowSlot } from './context-helpers.js';
import type { VirtualTableConnection } from '../vtab/connection.js';

export interface DeferredConstraintRow {
	row: Row;
	descriptor: RowDescriptor;
	evaluator: (ctx: RuntimeContext) => OutputValue;
	constraintName: string;
	connectionId?: string;
}

type DeferredConstraintBuckets = Map<string, Map<string, DeferredConstraintRow[]>>;

export class DeferredConstraintQueue {
	private readonly entries: DeferredConstraintBuckets = new Map();
	private layers: DeferredConstraintBuckets[] = [];

	constructor(private readonly db: Database) { }

	enqueue(baseTable: string, constraintName: string, row: Row, descriptor: RowDescriptor, evaluator: (ctx: RuntimeContext) => OutputValue, connectionId?: string): void {
		const store = this.getActiveStore();
		const tableKey = baseTable.toLowerCase();
		if (!store.has(tableKey)) store.set(tableKey, new Map());
		const constraints = store.get(tableKey)!;
		if (!constraints.has(constraintName)) constraints.set(constraintName, []);
		constraints.get(constraintName)!.push({ row: row.slice() as Row, descriptor, evaluator, constraintName, connectionId });
	}

	beginLayer(): void {
		this.layers.push(new Map());
	}

	rollbackLayer(): void {
		this.layers.pop();
	}

	releaseLayer(): void {
		const top = this.layers.pop();
		if (!top) return;
		const target = this.getActiveStore();
		this.merge(target, top);
	}

	clear(): void {
		this.entries.clear();
		this.layers = [];
	}

	async runDeferredRows(): Promise<void> {
		if (!this.hasPending()) return;
		const activeConnections = this.db.getAllConnections();
		const runtimeCtx: RuntimeContext = {
			db: this.db,
			stmt: undefined,
			params: {},
			context: new Map(),
			tableContexts: new Map(),
			tracer: this.db.getInstructionTracer(),
			enableMetrics: this.db.options.getBooleanOption('runtime_stats'),
		};
		const store = this.cloneAll();
		for (const [table, constraints] of store) {
			for (const [_, rows] of constraints) {
				for (const entry of rows) {
					const connection = this.findConnection(activeConnections, table, entry.connectionId);
					runtimeCtx.activeConnection = connection;
					await this.evaluateEntry(runtimeCtx, entry);
				}
			}
		}
		this.clear();
	}

	private async evaluateEntry(runtimeCtx: RuntimeContext, entry: DeferredConstraintRow): Promise<void> {
		const slot = createRowSlot(runtimeCtx, entry.descriptor);
		try {
			slot.set(entry.row);
			const value = await entry.evaluator(runtimeCtx) as SqlValue;
			if (value === false || value === 0) {
				throw new QuereusError(`CHECK constraint failed: ${entry.constraintName}`, StatusCode.CONSTRAINT);
			}
		} finally {
			slot.close();
		}
	}

	private getActiveStore(): DeferredConstraintBuckets {
		return this.layers.length > 0 ? this.layers[this.layers.length - 1] : this.entries;
	}

	private hasPending(): boolean {
		if (this.entries.size > 0) return true;
		return this.layers.some(layer => layer.size > 0);
	}

	private cloneAll(): DeferredConstraintBuckets {
		const clone: DeferredConstraintBuckets = new Map();
		const append = (source: DeferredConstraintBuckets) => {
			for (const [table, constraints] of source) {
				const lowerTable = table.toLowerCase();
				if (!clone.has(lowerTable)) clone.set(lowerTable, new Map());
				const targetConstraints = clone.get(lowerTable)!;
				for (const [constraintName, rows] of constraints) {
					if (!targetConstraints.has(constraintName)) targetConstraints.set(constraintName, []);
					targetConstraints.get(constraintName)!.push(...rows.map(entry => ({
						row: entry.row.slice() as Row,
						descriptor: entry.descriptor,
						evaluator: entry.evaluator,
						constraintName: entry.constraintName,
						connectionId: entry.connectionId,
					})));
				}
			}
		};

		append(this.entries);
		for (const layer of this.layers) append(layer);
		return clone;
	}

	private merge(target: DeferredConstraintBuckets, source: DeferredConstraintBuckets): void {
		for (const [table, constraints] of source) {
			const lowerTable = table.toLowerCase();
			if (!target.has(lowerTable)) target.set(lowerTable, new Map());
			const destConstraints = target.get(lowerTable)!;
			for (const [constraintName, rows] of constraints) {
				if (!destConstraints.has(constraintName)) destConstraints.set(constraintName, []);
				destConstraints.get(constraintName)!.push(...rows);
			}
		}
	}

	private findConnection(connections: VirtualTableConnection[], tableKey: string, preferredId?: string): VirtualTableConnection | undefined {
		if (preferredId) {
			const direct = connections.find(conn => conn.connectionId === preferredId);
			if (direct) {
				return direct;
			}
		}
		const normalized = tableKey.toLowerCase();
		const simple = normalized.includes('.') ? normalized.substring(normalized.lastIndexOf('.') + 1) : normalized;
		return connections.find(conn => {
			const connName = conn.tableName.toLowerCase();
			return connName === normalized || connName === simple;
		});
	}
}

