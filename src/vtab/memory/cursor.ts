import { VirtualTableCursor } from "../cursor.js";
import type { MemoryTable } from "./table.js";
import type { MemoryTableRow } from "./types.js";
import { StatusCode, type SqlValue, type Row } from "../../common/types.js";
import { SqliteError } from "../../common/errors.js";
import { MemoryIndex, type IndexSpec } from './index.js';
import type { IndexConstraint, IndexInfo } from '../indexInfo.js';
import type { MemoryTableConnection } from './layer/connection.js';
import type { LayerCursorInternal } from './layer/cursor.js';
import { type ScanPlan, buildScanPlanFromFilterInfo } from './layer/scan-plan.js';
import type { P4SortKey } from '../../vdbe/instruction.js';
import { createLogger } from '../../common/logger.js';
import type { FilterInfo } from "../filter-info.js";

const log = createLogger('vtab:memory:cursor');
const debugLog = log.extend('debug');

export class MemoryTableCursor<Tbl extends MemoryTable = MemoryTable> extends VirtualTableCursor<Tbl> {
	private readonly connection: MemoryTableConnection;
	private internalCursor: LayerCursorInternal | null = null;
	private plan: ScanPlan | null = null;

	public ephemeralSortingIndex: MemoryIndex | null = null;
	private sorterResults: MemoryTableRow[] = [];
	private sorterIndex: number = -1;
	private isUsingSorter: boolean = false;

	constructor(table: Tbl, connection: MemoryTableConnection) {
		super(table);
		this.connection = connection;
		this._isEof = true;
	}

	private reset(): void {
		if (this.internalCursor) { this.internalCursor.close(); this.internalCursor = null; }
		this._isEof = true; this.plan = null; this.isUsingSorter = false;
		this.sorterResults = []; this.sorterIndex = -1;
		// ephemeralSortingIndex is managed by the VDBE/Sort opcode lifecycle
	}

	async createAndPopulateSorterIndex(sortInfo: P4SortKey): Promise<void> {
		debugLog("MemoryTableCursor: Creating sorter index spec: %O", sortInfo);
		const schema = this.table.getSchema();
		if (!schema) throw new SqliteError("Cannot create sorter: Table schema not found.", StatusCode.INTERNAL);
		const sortIndexSpec: IndexSpec = {
			name: `_sorter_idx_${Date.now()}`,
			columns: sortInfo.keyIndices.map((colIndex, i) => ({ index: colIndex, desc: sortInfo.directions[i] ?? false, collation: sortInfo.collations?.[i] ?? 'BINARY' })),
		};
		const tempSorterMemoryIndex = new MemoryIndex(sortIndexSpec, schema.columns.map(c => ({ name: c.name })));
		const fullScanPlan: ScanPlan = { indexName: 'primary', descending: false };
		let readerCursor: LayerCursorInternal | null = null;
		this.sorterResults = [];
		try {
			readerCursor = this.connection.createLayerCursor(fullScanPlan); // Uses existing LayerCursorInternal chain
			while (!readerCursor.isEof()) {
				const tableRowTuple = readerCursor.getCurrentRowObject();
				if (tableRowTuple) tempSorterMemoryIndex.addEntry(tableRowTuple);
				await readerCursor.next();
			}
			for (const path of tempSorterMemoryIndex.data.ascending(tempSorterMemoryIndex.data.first())) {
				const sortEntry = tempSorterMemoryIndex.data.at(path);
				if (sortEntry) {
					const rowid = sortEntry[1];
					const fullRowTuple = await this.connection.lookupRowByRowid(rowid);
					if (fullRowTuple) this.sorterResults.push(fullRowTuple);
					else log(`Sorter: Row with rowid ${rowid} not found during lookup.`);
				}
			}
		} finally { readerCursor?.close(); }
		this.ephemeralSortingIndex = tempSorterMemoryIndex;
		debugLog(`Sorter populated ${this.sorterResults.length} rows.`);
	}

	async filter(idxNum: number, idxStr: string | null, constraints: ReadonlyArray<{ constraint: IndexConstraint, argvIndex: number }>, args: ReadonlyArray<SqlValue>, indexInfo: IndexInfo ): Promise<void> {
		this.reset();
		if (this.ephemeralSortingIndex) { // This implies createAndPopulateSorterIndex was called by VDBE
			debugLog("MemoryTableCursor.filter: Using pre-populated sorter results from ephemeralSortingIndex.");
			this.isUsingSorter = true;
			if (this.sorterResults.length > 0) { this.sorterIndex = 0; this._isEof = false; }
			else { this._isEof = true; }
			return;
		}
		this.isUsingSorter = false;

		// Construct FilterInfo from parameters
		const filterInfoForPlan: FilterInfo = {
			idxNum,
			idxStr,
			constraints,
			args,
			indexInfoOutput: indexInfo // Pass the full IndexInfo object
		};
		const tableSchema = this.table.getSchema();
		if (!tableSchema) throw new SqliteError("Schema not found for scan plan build in cursor", StatusCode.INTERNAL);

		this.plan = buildScanPlanFromFilterInfo(filterInfoForPlan, tableSchema); // Use unified builder
		this.internalCursor = this.connection.createLayerCursor(this.plan);
		this._isEof = this.internalCursor.isEof();
	}

	async* rows(): AsyncIterable<Row> {
		if (!this.internalCursor && !this.isUsingSorter) {
			throw new SqliteError("MemoryTableCursor.rows() called before filter() or after close().", StatusCode.MISUSE);
		}
		const schema = this.table.getSchema();
		if (!schema) throw new SqliteError("Schema not found for rows() iteration.", StatusCode.INTERNAL);

		while (!this.eof()) {
			let memoryTableRowTuple: MemoryTableRow | null = null;
			if (this.isUsingSorter) {
				if (this.sorterIndex >= 0 && this.sorterIndex < this.sorterResults.length) {
					memoryTableRowTuple = this.sorterResults[this.sorterIndex];
				}
			} else if (this.internalCursor) {
				memoryTableRowTuple = this.internalCursor.getCurrentRowObject();
			}
			if (memoryTableRowTuple) {
				yield memoryTableRowTuple[1]; // Yield the data_array part
			}
			await this.next();
		}
	}

	async next(): Promise<void> {
		if (this._isEof) return;
		if (this.isUsingSorter) {
			if (this.sorterIndex >= this.sorterResults.length - 1) { this._isEof = true; this.sorterIndex = this.sorterResults.length; }
			else { this.sorterIndex++; this._isEof = false; }
		} else {
			if (!this.internalCursor) { this._isEof = true; return; }
			await this.internalCursor.next();
			this._isEof = this.internalCursor.isEof();
		}
	}

	async rowid(): Promise<bigint> {
		let currentMemoryTableRow: MemoryTableRow | null = null;
		if (this.isUsingSorter) {
			if (this.sorterIndex >= 0 && this.sorterIndex < this.sorterResults.length) {
				currentMemoryTableRow = this.sorterResults[this.sorterIndex];
			}
		} else if (this.internalCursor) {
			currentMemoryTableRow = this.internalCursor.getCurrentRowObject();
		}
		if (currentMemoryTableRow === null) {
			throw new SqliteError("Cursor is not pointing to a valid row for rowid()", StatusCode.MISUSE);
		}
		return currentMemoryTableRow[0]; // rowid from tuple
	}

	async close(): Promise<void> {
		this.ephemeralSortingIndex = null;
		this.reset();
	}

	async seekRelative(_offset: number): Promise<boolean> { log('seekRelative not implemented'); throw new SqliteError(`seekRelative not implemented`, StatusCode.INTERNAL); }
	async seekToRowid(_rowid: bigint): Promise<boolean> { log('seekToRowid not implemented'); throw new SqliteError(`seekToRowid not implemented`, StatusCode.INTERNAL); }
}
