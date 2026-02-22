import type { Database, DatabaseInternal, MaybePromise, Row, SqlValue, TableIndexSchema as IndexSchema, FilterInfo, SchemaChangeInfo, UpdateArgs, VirtualTableConnection, UpdateResult } from '@quereus/quereus';
import { VirtualTable, compareSqlValues, isUpdateOk } from '@quereus/quereus';
import type { IsolationModule, ConnectionOverlayState } from './isolation-module.js';
import { IsolatedConnection, type IsolatedTableCallback } from './isolated-connection.js';
import { mergeStreams, createMergeEntry, createTombstone } from './merge-iterator.js';
import type { MergeEntry, MergeConfig } from './merge-types.js';

/**
 * Information about which index is being scanned.
 */
type IndexScanInfo =
	| { type: 'primary' }
	| { type: 'secondary'; indexName: string; columnIndices: number[] };

/**
 * A table wrapper that provides transaction isolation via an overlay.
 *
 * Each IsolatedTable instance accesses a connection-scoped overlay that is:
 * - Created lazily on first write
 * - Shared across all IsolatedTable instances in the same transaction
 * - Stored in the IsolationModule's connection overlay map
 *
 * This provides true per-connection isolation - each connection's uncommitted
 * changes are invisible to other connections, but visible to all queries
 * within the same connection.
 *
 * Reads merge overlay changes with underlying data.
 * Writes go to overlay only until commit.
 */
export class IsolatedTable extends VirtualTable implements IsolatedTableCallback {
	private readonly isolationModule: IsolationModule;
	private readonly underlyingTable: VirtualTable;

	private registeredConnection: IsolatedConnection | null = null;

	constructor(
		db: Database,
		module: IsolationModule,
		underlyingTable: VirtualTable
	) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		super(db, module as any, underlyingTable.schemaName, underlyingTable.tableName);
		this.isolationModule = module;
		this.underlyingTable = underlyingTable;
		// Schema comes from underlying - may be populated lazily by the underlying module
		this.tableSchema = underlyingTable.tableSchema;
	}

	/**
	 * Gets the tombstone column name from the module.
	 */
	private get tombstoneColumn(): string {
		return this.isolationModule.tombstoneColumn;
	}

	/**
	 * Gets the connection-scoped overlay state, or undefined if no overlay exists yet.
	 */
	private getOverlayState(): ConnectionOverlayState | undefined {
		return this.isolationModule.getConnectionOverlay(this.db, this.schemaName, this.tableName);
	}

	/**
	 * Gets the overlay table, or undefined if no overlay exists yet.
	 */
	private get overlayTable(): VirtualTable | undefined {
		return this.getOverlayState()?.overlayTable;
	}

	/**
	 * Gets whether this connection has uncommitted changes.
	 */
	private get hasChanges(): boolean {
		return this.getOverlayState()?.hasChanges ?? false;
	}

	/**
	 * Sets the hasChanges flag in the connection-scoped overlay state.
	 */
	private setHasChanges(value: boolean): void {
		const state = this.getOverlayState();
		if (state) {
			state.hasChanges = value;
		}
	}

	/**
	 * Lazily creates the overlay table on first write.
	 *
	 * The overlay is stored in connection-scoped storage, so it persists
	 * across multiple IsolatedTable instances within the same transaction.
	 *
	 * The schema is obtained from the underlying table at this point,
	 * supporting scenarios where schema is discovered lazily from storage.
	 */
	private async ensureOverlay(): Promise<VirtualTable> {
		// Check if overlay already exists for this connection
		const existingState = this.getOverlayState();
		if (existingState) {
			return existingState.overlayTable;
		}

		// Get schema from underlying table (may have been populated lazily)
		const schema = this.underlyingTable.tableSchema;
		if (!schema || schema.columns.length === 0) {
			throw new Error(
				`Cannot create isolation overlay: underlying table '${this.tableName}' has no schema. ` +
				'Ensure the underlying module provides schema before performing writes.'
			);
		}

		// Update our schema reference in case it was populated lazily
		this.tableSchema = schema;

		// Create overlay schema with tombstone column
		const overlaySchema = this.isolationModule.createOverlaySchema(schema);

		// Create the overlay table.
		// overlaySchema already contains indexes (copied from the base schema by
		// createOverlaySchema), so the overlay's BaseLayer initialises all secondary
		// indexes from the schema during construction.  No explicit createIndex loop
		// is needed, and calling it would throw a "duplicate index" error.
		const overlayTable = await this.isolationModule.overlayModule.create(this.db, overlaySchema);

		// Store in connection-scoped storage
		const state: ConnectionOverlayState = {
			overlayTable,
			hasChanges: false,
		};
		this.isolationModule.setConnectionOverlay(this.db, this.schemaName, this.tableName, state);

		return overlayTable;
	}

	/**
	 * Ensures a connection is registered with the database for transaction coordination.
	 * This is called before any read or write operation.
	 */
	private async ensureConnection(): Promise<IsolatedConnection> {
		if (!this.registeredConnection) {
			// Create connection - overlay connection created lazily if needed
			const overlayConn = this.overlayTable
				? await Promise.resolve(this.overlayTable.createConnection?.())
				: undefined;

			this.registeredConnection = new IsolatedConnection(
				this.tableName,
				undefined,
				overlayConn,
				this
			);

			// Register connection with the database for transaction management
			await (this.db as DatabaseInternal).registerConnection(this.registeredConnection);
		}
		return this.registeredConnection;
	}

	// ==================== Connection Management ====================

	/**
	 * Creates a new isolated connection for transaction support.
	 * The connection includes this table as a callback so commit/rollback
	 * operations properly flush/clear the overlay.
	 */
	createConnection(): MaybePromise<VirtualTableConnection> {
		const underlyingConn = this.underlyingTable.createConnection?.();
		// Overlay connection created lazily - may not exist yet
		const overlayConn = this.overlayTable?.createConnection?.();

		// Handle sync/async connection creation
		if (underlyingConn instanceof Promise || overlayConn instanceof Promise) {
			return this.createConnectionAsync(underlyingConn, overlayConn);
		}

		return new IsolatedConnection(
			this.tableName,
			underlyingConn,
			overlayConn,
			this  // Include callback for commit/rollback handling
		);
	}

	private async createConnectionAsync(
		underlyingConn: MaybePromise<VirtualTableConnection> | undefined,
		overlayConn: MaybePromise<VirtualTableConnection> | undefined
	): Promise<VirtualTableConnection> {
		const [underlying, overlay] = await Promise.all([
			underlyingConn,
			overlayConn,
		]);
		return new IsolatedConnection(this.tableName, underlying, overlay, this);
	}

	// ==================== Query Operations ====================

	/**
	 * Query the table, merging overlay with underlying.
	 *
	 * When overlay is empty or doesn't exist, delegates directly to underlying for efficiency.
	 * When overlay has changes, merges both streams using the appropriate key order.
	 *
	 * For primary key scans: merge by PK order
	 * For secondary index scans: merge by (indexKey, PK) order
	 */
	query(filterInfo: FilterInfo): AsyncIterable<Row> {
		if (!this.underlyingTable.query) {
			throw new Error('Underlying table does not support query');
		}

		// Fast path: no overlay or no changes, skip merge overhead
		if (!this.overlayTable || !this.hasChanges) {
			return this.underlyingTable.query(filterInfo);
		}

		// Merge overlay with underlying (with connection ensured)
		return this.mergedQueryWithConnection(filterInfo);
	}

	/**
	 * Wrapper that ensures connection before merging.
	 */
	private async *mergedQueryWithConnection(filterInfo: FilterInfo): AsyncGenerator<Row> {
		await this.ensureConnection();
		yield* this.mergedQuery(filterInfo);
	}

	/**
	 * Performs merged query combining overlay and underlying data.
	 *
	 * For primary key scans: uses position-based merge since both streams share
	 * the same sort order and overlay entries align with underlying rows by PK.
	 *
	 * For secondary index scans: uses PK-exclusion approach because overlay entries
	 * may have different index key values than the underlying rows they shadow
	 * (tombstones have null non-PK columns; updates may change the indexed column).
	 */
	private async *mergedQuery(filterInfo: FilterInfo): AsyncGenerator<Row> {
		const overlay = this.overlayTable;
		if (!overlay) {
			yield* this.underlyingTable.query!(filterInfo);
			return;
		}

		const indexInfo = this.parseIndexFromFilterInfo(filterInfo);

		if (indexInfo.type === 'secondary') {
			yield* this.mergedSecondaryIndexQuery(overlay, filterInfo, indexInfo);
			return;
		}

		// Primary key scan - use standard sort-key merge
		const overlayFilterInfo = this.adaptFilterInfoForOverlay(filterInfo);
		const overlayStream = this.queryOverlayAsMergeEntries(overlay, overlayFilterInfo, indexInfo);
		const underlyingStream = this.underlyingTable.query!(filterInfo);
		const mergeConfig = this.buildMergeConfig(indexInfo);
		yield* mergeStreams(overlayStream, underlyingStream, mergeConfig);
	}

	/**
	 * Merged query strategy for secondary index scans.
	 *
	 * Instead of position-based merging (which fails when overlay entries have
	 * different index key values than the underlying rows they shadow), this:
	 * 1. Collects all PKs modified in the overlay (full scan)
	 * 2. Queries underlying via secondary index, excluding modified PKs
	 * 3. Queries overlay via secondary index for non-tombstone data rows
	 * 4. Merges the two disjoint, sorted streams by sort key
	 */
	private async *mergedSecondaryIndexQuery(
		overlay: VirtualTable,
		filterInfo: FilterInfo,
		indexInfo: IndexScanInfo & { type: 'secondary' }
	): AsyncGenerator<Row> {
		if (!overlay.query) {
			yield* this.underlyingTable.query!(filterInfo);
			return;
		}

		const pkIndices = this.getPrimaryKeyIndices();
		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);

		// Step 1: Collect all PKs modified in overlay (full scan)
		const modifiedPKs = new Set<string>();
		for await (const row of overlay.query(this.createFullScanFilterInfo())) {
			const pk = pkIndices.map(i => row[i]);
			modifiedPKs.add(JSON.stringify(pk));
		}

		// Step 2: Query overlay via secondary index for non-tombstone data rows
		const overlayFilterInfo = this.adaptFilterInfoForOverlay(filterInfo);
		const overlayRows: Row[] = [];
		for await (const row of overlay.query(overlayFilterInfo)) {
			if (row[tombstoneIndex] !== 1) {
				overlayRows.push(row.slice(0, tombstoneIndex));
			}
		}

		// Step 3: Query underlying via secondary index, filter out modified PKs
		const mergeConfig = this.buildMergeConfig(indexInfo);
		const compareSortKey = mergeConfig.compareSortKey ?? mergeConfig.comparePK;
		const extractSortKey = mergeConfig.extractSortKey ?? mergeConfig.extractPK;

		// Merge two sorted, disjoint streams
		let oi = 0;
		for await (const underlyingRow of this.underlyingTable.query!(filterInfo)) {
			const pk = pkIndices.map(i => underlyingRow[i]);
			if (modifiedPKs.has(JSON.stringify(pk))) {
				continue; // Skip rows modified in overlay
			}

			// Yield any overlay rows that sort before this underlying row
			while (oi < overlayRows.length) {
				const oKey = extractSortKey(overlayRows[oi]);
				const uKey = extractSortKey(underlyingRow);
				if (compareSortKey(oKey, uKey) <= 0) {
					yield overlayRows[oi++];
				} else {
					break;
				}
			}

			yield underlyingRow;
		}

		// Yield remaining overlay rows
		while (oi < overlayRows.length) {
			yield overlayRows[oi++];
		}
	}

	/**
	 * Parses FilterInfo to determine which index is being used.
	 * Returns null for full table scan or primary key scan, index name for secondary indexes.
	 */
	private parseIndexFromFilterInfo(filterInfo: FilterInfo): IndexScanInfo {
		const { idxStr } = filterInfo;
		if (!idxStr) {
			return { type: 'primary' };
		}

		// Parse idxStr format: "idx=indexName(n);plan=2;..."
		const params = new Map<string, string>();
		idxStr.split(';').forEach(part => {
			const [key, value] = part.split('=', 2);
			if (key && value !== undefined) params.set(key, value);
		});

		const idxMatch = params.get('idx')?.match(/^(.*?)\((\d+)\)$/);
		if (!idxMatch) {
			return { type: 'primary' };
		}

		const indexName = idxMatch[1];
		if (indexName === '_primary_') {
			return { type: 'primary' };
		}

		// Secondary index scan
		return {
			type: 'secondary',
			indexName,
			columnIndices: this.getIndexColumnIndices(indexName),
		};
	}

	/**
	 * Gets the column indices for a secondary index.
	 */
	private getIndexColumnIndices(indexName: string): number[] {
		const schema = this.tableSchema;
		if (!schema?.indexes) return [];

		const index = schema.indexes.find(idx => idx.name.toLowerCase() === indexName.toLowerCase());
		if (!index) return [];

		return index.columns.map(col => col.index);
	}

	/**
	 * Adapts FilterInfo for the overlay table schema (which has an extra tombstone column).
	 * The constraints and index references remain the same since the overlay has matching indexes.
	 */
	private adaptFilterInfoForOverlay(filterInfo: FilterInfo): FilterInfo {
		// The overlay table has the same schema plus a tombstone column at the end.
		// Column indices for data columns are the same, so FilterInfo constraints work as-is.
		// The overlay module will interpret the constraints correctly.
		return filterInfo;
	}

	/**
	 * Queries the overlay table and converts rows to MergeEntry format.
	 *
	 * Uses the same FilterInfo as the underlying query so both streams are in the same order.
	 * For secondary index scans, the sort key includes both the index key and primary key.
	 */
	private async *queryOverlayAsMergeEntries(
		overlay: VirtualTable,
		filterInfo: FilterInfo,
		indexInfo: IndexScanInfo
	): AsyncGenerator<MergeEntry> {
		if (!overlay.query) {
			return;
		}

		const pkIndices = this.getPrimaryKeyIndices();
		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);

		// Query overlay with the same filter constraints
		for await (const overlayRow of overlay.query(filterInfo)) {
			const isTombstone = overlayRow[tombstoneIndex] === 1;
			const pk = pkIndices.map(i => overlayRow[i]);

			// Build sort key based on index type
			const sortKey = this.buildSortKey(overlayRow, pkIndices, indexInfo);

			if (isTombstone) {
				yield createTombstone(pk, sortKey);
			} else {
				// Remove the tombstone column from the row before yielding
				const dataRow = overlayRow.slice(0, tombstoneIndex);
				yield createMergeEntry(dataRow, pk, sortKey);
			}
		}
	}

	/**
	 * Builds the sort key for a row based on the index being scanned.
	 *
	 * For primary key scans: sort key is the PK
	 * For secondary index scans: sort key is [indexKeyParts..., pkParts...]
	 */
	private buildSortKey(row: Row, pkIndices: number[], indexInfo: IndexScanInfo): SqlValue[] {
		if (indexInfo.type === 'primary') {
			return pkIndices.map(i => row[i]);
		}

		// Secondary index: combine index key columns with PK columns
		const indexKey = indexInfo.columnIndices.map(i => row[i]);
		const pk = pkIndices.map(i => row[i]);
		return [...indexKey, ...pk];
	}

	/**
	 * Builds the merge configuration using this table's key functions.
	 *
	 * For primary key scans: compare by PK
	 * For secondary index scans: compare by (indexKey, PK) using underlying's comparator
	 *
	 * @param indexInfo Which index is being scanned. Defaults to primary key scan.
	 */
	private buildMergeConfig(indexInfo: IndexScanInfo = { type: 'primary' }): MergeConfig {
		const pkIndices = this.getPrimaryKeyIndices();

		const extractPK = (row: Row) => pkIndices.map(i => row[i]);
		const comparePK = this.getComparePK();

		if (indexInfo.type === 'primary') {
			// Primary key scan - sort key equals PK
			return {
				extractPK,
				comparePK,
				// No need for separate sort key functions - defaults to PK
			};
		}

		// Secondary index scan - sort key is (indexKey, PK)
		const indexColIndices = indexInfo.columnIndices;
		const extractSortKey = (row: Row): SqlValue[] => {
			const indexKey = indexColIndices.map(i => row[i]);
			const pk = pkIndices.map(i => row[i]);
			return [...indexKey, ...pk];
		};

		// Try to use the underlying table's index comparator if available
		const indexComparator = this.underlyingTable.getIndexComparator?.(indexInfo.indexName);
		const compareSortKey = this.buildCompareSortKey(indexColIndices.length, comparePK, indexComparator);

		return {
			extractPK,
			comparePK,
			extractSortKey,
			compareSortKey,
		};
	}

	/**
	 * Gets the primary key comparator, preferring the underlying table's comparator.
	 */
	private getComparePK(): (a: SqlValue[], b: SqlValue[]) => number {
		// Use underlying table's comparator if available for consistent ordering
		if (this.underlyingTable.comparePrimaryKey) {
			return this.underlyingTable.comparePrimaryKey.bind(this.underlyingTable);
		}

		// Fallback to default comparator
		return (a: SqlValue[], b: SqlValue[]) => {
			for (let i = 0; i < a.length; i++) {
				const cmp = compareSqlValues(a[i], b[i]);
				if (cmp !== 0) return cmp;
			}
			return 0;
		};
	}

	/**
	 * Builds a sort key comparator for secondary index scans.
	 *
	 * Compares by index key columns first, then by PK columns.
	 */
	private buildCompareSortKey(
		indexKeyLength: number,
		comparePK: (a: SqlValue[], b: SqlValue[]) => number,
		_indexComparator?: (a: SqlValue, b: SqlValue) => number
	): (a: SqlValue[], b: SqlValue[]) => number {
		return (a: SqlValue[], b: SqlValue[]) => {
			// Compare index key portion first
			for (let i = 0; i < indexKeyLength; i++) {
				const cmp = compareSqlValues(a[i], b[i]);
				if (cmp !== 0) return cmp;
			}

			// Index keys equal - compare PK portion
			const pkA = a.slice(indexKeyLength);
			const pkB = b.slice(indexKeyLength);
			return comparePK(pkA, pkB);
		};
	}

	/**
	 * Gets the index of the tombstone column in overlay rows.
	 */
	private getTombstoneColumnIndex(overlay: VirtualTable): number {
		const schema = overlay.tableSchema;
		if (!schema) {
			throw new Error('Overlay table has no schema');
		}
		const idx = schema.columnIndexMap.get(this.tombstoneColumn.toLowerCase());
		if (idx === undefined) {
			throw new Error(`Tombstone column '${this.tombstoneColumn}' not found in overlay schema`);
		}
		return idx;
	}

	/**
	 * Gets the primary key column indices from the underlying table schema.
	 */
	getPrimaryKeyIndices(): number[] {
		const schema = this.tableSchema;
		if (!schema) return [];
		return schema.primaryKeyDefinition.map(pkDef => pkDef.index);
	}

	// ==================== Write Operations ====================

	/**
	 * Performs INSERT, UPDATE, or DELETE on the overlay.
	 * Changes are not visible to underlying until commit.
	 *
	 * The overlay is created lazily on first write, using schema from the underlying table.
	 */
	async update(args: UpdateArgs): Promise<UpdateResult> {
		// Ensure connection is registered for transaction coordination
		await this.ensureConnection();

		// Lazily create overlay on first write
		const overlay = await this.ensureOverlay();

		// Mark that we have changes
		this.setHasChanges(true);

		const { operation, values, oldKeyValues } = args;
		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);

		switch (operation) {
			case 'insert': {
				// Insert into overlay with tombstone = 0
				const overlayRow = [...(values ?? []), 0]; // Append tombstone = 0
				const result = await overlay.update({
					...args,
					values: overlayRow,
				});
				// Strip tombstone from result
				if (isUpdateOk(result) && result.row) {
					return { status: 'ok', row: result.row.slice(0, tombstoneIndex) };
				}
				return result;
			}

			case 'update': {
				// For updates, we need to handle the case where the row exists in:
				// 1. Overlay only (previous insert) - update the overlay row
				// 2. Underlying only - insert into overlay with new values
				// 3. Both (previous update) - update the overlay row

				// First, try to find in overlay
				const pkIndices = this.getPrimaryKeyIndices();
				const targetPK = oldKeyValues ?? (values ? pkIndices.map(i => values[i]) : undefined);

				if (!targetPK || !values) {
					throw new Error('UPDATE requires oldKeyValues or values with primary key');
				}

				// Check if row exists in overlay
				const existsInOverlay = await this.rowExistsInOverlay(overlay, targetPK);

				if (existsInOverlay) {
					// Update existing overlay row
					const overlayRow = [...values, 0]; // tombstone = 0
					// oldKeyValues should only contain PK columns, not tombstone
					const result = await overlay.update({
						...args,
						values: overlayRow,
						oldKeyValues: targetPK,
					});
					// Strip tombstone from result
					if (isUpdateOk(result) && result.row) {
						return { status: 'ok', row: result.row.slice(0, tombstoneIndex) };
					}
					return result;
				} else {
					// Insert new overlay row (shadows underlying)
					const overlayRow = [...values, 0];
					const result = await overlay.update({
						operation: 'insert',
						values: overlayRow,
						onConflict: args.onConflict,
					});
					// Strip tombstone from result
					if (isUpdateOk(result) && result.row) {
						return { status: 'ok', row: result.row.slice(0, tombstoneIndex) };
					}
					return result;
				}
			}

			case 'delete': {
				// For deletes, insert a tombstone into overlay
				const pkIndices = this.getPrimaryKeyIndices();
				const targetPK = oldKeyValues ?? (values ? pkIndices.map(i => values[i]) : undefined);

				if (!targetPK) {
					throw new Error('DELETE requires oldKeyValues or values with primary key');
				}

				// Check if row exists in overlay
				const existsInOverlay = await this.rowExistsInOverlay(overlay, targetPK);

				if (existsInOverlay) {
					// Check if it's already a tombstone
					const overlayRow = await this.getOverlayRow(overlay, targetPK);
					if (overlayRow) {
						const isTombstone = overlayRow[tombstoneIndex] === 1;
						if (isTombstone) {
							// Already deleted, nothing to do
							return { status: 'ok' };
						}
						// Convert to tombstone by updating the tombstone flag
						const tombstoneRow = [...overlayRow.slice(0, tombstoneIndex), 1];
						// oldKeyValues should only contain PK columns, not the full row
						await overlay.update({
							operation: 'update',
							values: tombstoneRow,
							oldKeyValues: targetPK,
							onConflict: args.onConflict,
						});
					}
				} else {
					// Insert tombstone to shadow underlying row
					// Build a minimal row with PK values and tombstone = 1
					const schema = this.tableSchema;
					if (!schema) throw new Error('No table schema');

					const tombstoneRow: SqlValue[] = new Array(schema.columns.length + 1).fill(null);
					pkIndices.forEach((colIdx, i) => {
						tombstoneRow[colIdx] = targetPK[i];
					});
					tombstoneRow[tombstoneIndex] = 1; // Set tombstone flag

					await overlay.update({
						operation: 'insert',
						values: tombstoneRow,
						onConflict: args.onConflict,
					});
				}

				return { status: 'ok' };
			}

			default:
				throw new Error(`Unknown operation: ${operation}`);
		}
	}

	/**
	 * Checks if a row with the given primary key exists in the overlay.
	 */
	private async rowExistsInOverlay(overlay: VirtualTable, pk: SqlValue[]): Promise<boolean> {
		const row = await this.getOverlayRow(overlay, pk);
		return row !== undefined;
	}

	/**
	 * Gets a row from the overlay by primary key.
	 */
	private async getOverlayRow(overlay: VirtualTable, pk: SqlValue[]): Promise<Row | undefined> {
		if (!overlay.query) return undefined;

		const pkIndices = this.getPrimaryKeyIndices();
		const mergeConfig = this.buildMergeConfig();

		// Scan overlay looking for matching PK
		// This is inefficient but correct; optimization can use index later
		for await (const row of overlay.query(this.createFullScanFilterInfo())) {
			const rowPK = pkIndices.map(i => row[i]);
			if (mergeConfig.comparePK(rowPK, pk) === 0) {
				return row;
			}
		}
		return undefined;
	}

	/**
	 * Creates a FilterInfo for a full table scan (no constraints).
	 */
	private createFullScanFilterInfo(): FilterInfo {
		return {
			idxNum: 0,
			idxStr: null,
			constraints: [],
			args: [],
			indexInfoOutput: {
				nConstraint: 0,
				aConstraint: [],
				nOrderBy: 0,
				aOrderBy: [],
				colUsed: 0n,
				aConstraintUsage: [],
				idxNum: 0,
				idxStr: null,
				orderByConsumed: false,
				estimatedCost: 1000000,
				estimatedRows: 1000000n,
				idxFlags: 0,
			},
		};
	}

	// ==================== Transaction Lifecycle ====================

	async begin(): Promise<void> {
		await this.underlyingTable.begin?.();
		await this.overlayTable?.begin?.();
	}

	async sync(): Promise<void> {
		await this.underlyingTable.sync?.();
		await this.overlayTable?.sync?.();
	}

	async commit(): Promise<void> {
		const overlay = this.overlayTable;
		if (this.hasChanges && overlay) {
			await this.flushOverlayToUnderlying(overlay);
		}
		await this.underlyingTable.commit?.();
		await this.clearOverlay();
	}

	/**
	 * Flushes all overlay changes to the underlying table.
	 * Called during commit to persist changes.
	 *
	 * This method manages the underlying table's transaction lifecycle independently
	 * to ensure that flushed data is committed and won't be rolled back by subsequent
	 * transaction rollbacks.
	 */
	private async flushOverlayToUnderlying(overlay: VirtualTable): Promise<void> {
		if (!overlay.query) return;

		const tombstoneIndex = this.getTombstoneColumnIndex(overlay);
		const pkIndices = this.getPrimaryKeyIndices();

		// Collect all overlay entries first
		const overlayEntries: { row: Row; isTombstone: boolean; pk: SqlValue[]; dataRow: Row }[] = [];
		for await (const overlayRow of overlay.query(this.createFullScanFilterInfo())) {
			const isTombstone = overlayRow[tombstoneIndex] === 1;
			const pk = pkIndices.map(i => overlayRow[i]);
			const dataRow = overlayRow.slice(0, tombstoneIndex);
			overlayEntries.push({ row: overlayRow, isTombstone, pk, dataRow });
		}

		if (overlayEntries.length === 0) return;

		// Begin a transaction on the underlying table for the flush
		await this.underlyingTable.begin?.();

		try {
			// Apply all overlay entries to underlying
			for (const entry of overlayEntries) {
				if (entry.isTombstone) {
					// Delete from underlying
					await this.underlyingTable.update({
						operation: 'delete',
						values: undefined,
						oldKeyValues: entry.pk,
					});
				} else {
					// Check if row exists in underlying to decide insert vs update
					const existsInUnderlying = await this.rowExistsInUnderlying(entry.pk);

					if (existsInUnderlying) {
						await this.underlyingTable.update({
							operation: 'update',
							values: entry.dataRow,
							oldKeyValues: entry.pk,
						});
					} else {
						await this.underlyingTable.update({
							operation: 'insert',
							values: entry.dataRow,
						});
					}
				}
			}

			// Commit the underlying table's transaction
			await this.underlyingTable.commit?.();
		} catch (error) {
			// Rollback underlying on error
			await this.underlyingTable.rollback?.();
			throw error;
		}
	}

	/**
	 * Checks if a row with the given primary key exists in the underlying table.
	 */
	private async rowExistsInUnderlying(pk: SqlValue[]): Promise<boolean> {
		if (!this.underlyingTable.query) return false;

		const pkIndices = this.getPrimaryKeyIndices();
		const mergeConfig = this.buildMergeConfig();

		for await (const row of this.underlyingTable.query(this.createFullScanFilterInfo())) {
			const rowPK = pkIndices.map(i => row[i]);
			if (mergeConfig.comparePK(rowPK, pk) === 0) {
				return true;
			}
		}
		return false;
	}

	async rollback(): Promise<void> {
		await this.underlyingTable.rollback?.();
		await this.clearOverlay();
	}

	/**
	 * Clears the connection-scoped overlay and resets state.
	 */
	private async clearOverlay(): Promise<void> {
		const state = this.getOverlayState();
		if (!state) return;

		const overlay = state.overlayTable;
		if (overlay.query) {
			const pkIndices = this.getPrimaryKeyIndices();

			// Collect all PKs first to avoid modifying while iterating
			const pksToDelete: SqlValue[][] = [];
			for await (const row of overlay.query(this.createFullScanFilterInfo())) {
				// Extract just the PK values (same columns as underlying table)
				const pk = pkIndices.map(i => row[i]);
				pksToDelete.push(pk);
			}

			// Delete each row from overlay by PK
			for (const pk of pksToDelete) {
				await overlay.update({
					operation: 'delete',
					values: undefined,
					oldKeyValues: pk,
				});
			}
		}

		// Clear the connection overlay state
		this.isolationModule.clearConnectionOverlay(this.db, this.schemaName, this.tableName);
	}

	// ==================== Savepoints ====================

	async savepoint(index: number): Promise<void> {
		await this.underlyingTable.savepoint?.(index);
		await this.overlayTable?.savepoint?.(index);
	}

	async release(index: number): Promise<void> {
		await this.underlyingTable.release?.(index);
		await this.overlayTable?.release?.(index);
	}

	async rollbackTo(index: number): Promise<void> {
		await this.underlyingTable.rollbackTo?.(index);
		await this.overlayTable?.rollbackTo?.(index);
	}

	// ==================== Schema Operations ====================

	async disconnect(): Promise<void> {
		// Don't disconnect overlay or underlying - they're connection-scoped/shared
	}

	async rename(newName: string): Promise<void> {
		await this.underlyingTable.rename?.(newName);
	}

	async alterSchema(changeInfo: SchemaChangeInfo): Promise<void> {
		// DDL bypasses overlay, goes directly to underlying
		await this.underlyingTable.alterSchema?.(changeInfo);
		// Update our schema reference
		this.tableSchema = this.underlyingTable.tableSchema;
		// Clear any existing overlay - it will be recreated with new schema on next write
		this.isolationModule.clearConnectionOverlay(this.db, this.schemaName, this.tableName);
	}

	async createIndex(indexInfo: IndexSchema): Promise<void> {
		await this.underlyingTable.createIndex?.(indexInfo);
		// Update schema reference
		this.tableSchema = this.underlyingTable.tableSchema;
		// If overlay exists, add index to it too
		await this.overlayTable?.createIndex?.(indexInfo);
	}

	async dropIndex(indexName: string): Promise<void> {
		await this.underlyingTable.dropIndex?.(indexName);
		// Update schema reference
		this.tableSchema = this.underlyingTable.tableSchema;
		await this.overlayTable?.dropIndex?.(indexName);
	}

	// ==================== Internal Helpers ====================

	/**
	 * Gets the underlying table for direct access (testing/debugging).
	 * @internal
	 */
	getUnderlyingTable(): VirtualTable {
		return this.underlyingTable;
	}

	/**
	 * Gets the overlay table for direct access (testing/debugging).
	 * Returns undefined if overlay hasn't been created yet.
	 * @internal
	 */
	getOverlayTable(): VirtualTable | undefined {
		return this.overlayTable;
	}

	/**
	 * Returns whether there are pending uncommitted changes.
	 */
	hasPendingChanges(): boolean {
		return this.hasChanges;
	}

	/**
	 * Gets the tombstone column name.
	 * @internal
	 */
	getTombstoneColumn(): string {
		return this.tombstoneColumn;
	}

	// ==================== IsolatedTableCallback Implementation ====================

	/**
	 * Called by IsolatedConnection when the database commits.
	 * Flushes overlay to underlying and clears overlay.
	 */
	async onConnectionCommit(): Promise<void> {
		const overlay = this.overlayTable;
		if (this.hasChanges && overlay) {
			await this.flushOverlayToUnderlying(overlay);
		}
		await this.clearOverlay();
	}

	/**
	 * Called by IsolatedConnection when the database rolls back.
	 * Clears overlay without flushing.
	 */
	async onConnectionRollback(): Promise<void> {
		await this.clearOverlay();
	}

	/**
	 * Called by IsolatedConnection when a savepoint is created.
	 */
	async onConnectionSavepoint(index: number): Promise<void> {
		await this.overlayTable?.savepoint?.(index);
	}

	/**
	 * Called by IsolatedConnection when a savepoint is released.
	 */
	async onConnectionReleaseSavepoint(index: number): Promise<void> {
		await this.overlayTable?.release?.(index);
	}

	/**
	 * Called by IsolatedConnection when rolling back to a savepoint.
	 */
	async onConnectionRollbackToSavepoint(index: number): Promise<void> {
		await this.overlayTable?.rollbackTo?.(index);
	}
}
