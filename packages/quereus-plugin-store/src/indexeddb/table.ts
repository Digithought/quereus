/**
 * IndexedDB Virtual Table implementation.
 */

import { VirtualTable, IndexConstraintOp, ConflictResolution, QuereusError, ConstraintError, StatusCode, type Database, type TableSchema, type Row, type FilterInfo, type SqlValue, type VirtualTableConnection } from '@quereus/quereus';
import type { UpdateArgs } from '@quereus/quereus';
import type { IndexedDBModule, IndexedDBModuleConfig } from './module.js';
import type { IndexedDBStore } from './store.js';
import type { StoreEventEmitter } from '../common/events.js';
import { TransactionCoordinator } from '../common/transaction.js';
import { IndexedDBConnection } from './connection.js';
import {
  buildDataKey,
  buildTableScanBounds,
  buildIndexKey,
  buildMetaKey,
  serializeRow,
  deserializeRow,
  serializeStats,
  deserializeStats,
  type EncodeOptions,
  type TableStats,
} from '../common/index.js';

/** Number of mutations before persisting statistics. */
const STATS_FLUSH_INTERVAL = 100;

/**
 * IndexedDB-backed virtual table.
 */
export class IndexedDBTable extends VirtualTable {
  private indexeddbModule: IndexedDBModule;
  private config: IndexedDBModuleConfig;
  private store: IndexedDBStore | null = null;
  private coordinator: TransactionCoordinator | null = null;
  private connection: IndexedDBConnection | null = null;
  private encodeOptions: EncodeOptions;
  private ddlSaved = false;

  // Statistics tracking
  private cachedStats: TableStats | null = null;
  private mutationCount = 0;
  private statsFlushPending = false;
  private pendingStatsDelta = 0;

  constructor(
    db: Database,
    indexeddbModule: IndexedDBModule,
    tableSchema: TableSchema,
    config: IndexedDBModuleConfig,
    _eventEmitter?: StoreEventEmitter, // Now routed through coordinator
    isConnected = false
  ) {
    super(db, indexeddbModule, tableSchema.schemaName, tableSchema.name);
    this.indexeddbModule = indexeddbModule;
    this.tableSchema = tableSchema;
    this.config = config;
    this.encodeOptions = { collation: config.collation || 'NOCASE' };
    this.ddlSaved = isConnected; // DDL already exists if connecting to existing table
  }

  /**
   * Ensure the store is open and DDL is persisted.
   */
  private async ensureStore(): Promise<IndexedDBStore> {
    if (!this.store) {
      const tableKey = `${this.schemaName}.${this.tableName}`.toLowerCase();
      this.store = await this.indexeddbModule.getStore(tableKey, this.config);

      // Save DDL on first access (only for newly created tables)
      if (!this.ddlSaved && this.tableSchema) {
        await this.indexeddbModule.saveTableDDL(this.tableSchema);
        this.ddlSaved = true;
      }
    }
    return this.store;
  }

  /**
   * Ensure the coordinator is available and connection is registered.
   */
  private async ensureCoordinator(): Promise<TransactionCoordinator> {
    if (!this.coordinator) {
      const tableKey = `${this.schemaName}.${this.tableName}`.toLowerCase();
      this.coordinator = await this.indexeddbModule.getCoordinator(tableKey, this.config);

      // Register callbacks for transaction lifecycle
      this.coordinator.registerCallbacks({
        onCommit: () => this.applyPendingStats(),
        onRollback: () => this.discardPendingStats(),
      });
    }

    // Ensure connection is registered with database
    if (!this.connection) {
      this.connection = new IndexedDBConnection(this.tableName, this.coordinator);

      // Register with the database for transaction management
      const dbInternal = this.db as unknown as {
        registerConnection(conn: VirtualTableConnection): Promise<void>;
      };
      await dbInternal.registerConnection(this.connection);
    }

    return this.coordinator;
  }

  /** Apply pending stats on commit. */
  private applyPendingStats(): void {
    if (this.pendingStatsDelta === 0) return;

    if (!this.cachedStats) {
      this.cachedStats = { rowCount: 0, updatedAt: Date.now() };
    }
    this.cachedStats.rowCount = Math.max(0, this.cachedStats.rowCount + this.pendingStatsDelta);
    this.cachedStats.updatedAt = Date.now();
    this.mutationCount += Math.abs(this.pendingStatsDelta);
    this.pendingStatsDelta = 0;

    // Schedule lazy flush if needed
    if (this.mutationCount >= STATS_FLUSH_INTERVAL && !this.statsFlushPending) {
      this.statsFlushPending = true;
      queueMicrotask(() => this.flushStats());
    }
  }

  /** Discard pending stats on rollback. */
  private discardPendingStats(): void {
    this.pendingStatsDelta = 0;
  }

  /**
   * Create a new connection for transaction support.
   */
  async createConnection(): Promise<VirtualTableConnection> {
    await this.ensureCoordinator();
    return this.connection!;
  }

  /**
   * Get the current connection.
   */
  getConnection(): VirtualTableConnection | undefined {
    return this.connection ?? undefined;
  }

  /**
   * Extract primary key values from a row.
   */
  private extractPK(row: Row): SqlValue[] {
    const schema = this.tableSchema!;
    return schema.primaryKeyDefinition.map(pk => row[pk.index]);
  }

  /**
   * Query the table with optional filters.
   */
  async *query(filterInfo: FilterInfo): AsyncIterable<Row> {
    const store = await this.ensureStore();
    const schema = this.tableSchema!;

    // Check if we can use PK-based access
    const pkAccess = this.analyzePKAccess(filterInfo);

    if (pkAccess.type === 'point') {
      // Point lookup by PK
      const key = buildDataKey(
        schema.schemaName,
        schema.name,
        pkAccess.values!,
        this.encodeOptions
      );
      const value = await store.get(key);
      if (value) {
        const row = deserializeRow(value);
        if (this.matchesFilters(row, filterInfo)) {
          yield row;
        }
      }
      return;
    }

    if (pkAccess.type === 'range') {
      // Range scan on PK
      yield* this.scanPKRange(store, pkAccess, filterInfo);
      return;
    }

    // Full table scan
    const bounds = buildTableScanBounds(schema.schemaName, schema.name);
    for await (const entry of store.iterate(bounds)) {
      const row = deserializeRow(entry.value);
      if (this.matchesFilters(row, filterInfo)) {
        yield row;
      }
    }
  }

  /**
   * Analyze filter info to determine PK access pattern.
   */
  private analyzePKAccess(filterInfo: FilterInfo): PKAccessPattern {
    const schema = this.tableSchema!;
    const pkColumns = schema.primaryKeyDefinition.map(pk => pk.index);

    if (pkColumns.length === 0) {
      return { type: 'scan' };
    }

    // Check for equality on all PK columns
    const eqValues: SqlValue[] = new Array(pkColumns.length);
    let allEq = true;

    for (let i = 0; i < pkColumns.length; i++) {
      const pkColIdx = pkColumns[i];
      // Find constraint with matching column and EQ operator
      const eqConstraintEntry = filterInfo.constraints?.find(
        c => c.constraint.iColumn === pkColIdx && c.constraint.op === IndexConstraintOp.EQ
      );
      if (eqConstraintEntry && eqConstraintEntry.argvIndex > 0) {
        // Get the value from args (argvIndex is 1-based)
        eqValues[i] = filterInfo.args[eqConstraintEntry.argvIndex - 1];
      } else {
        allEq = false;
        break;
      }
    }

    if (allEq) {
      return { type: 'point', values: eqValues };
    }

    // Check for range constraints on first PK column
    const firstPkCol = pkColumns[0];
    const rangeOps = [IndexConstraintOp.LT, IndexConstraintOp.LE, IndexConstraintOp.GT, IndexConstraintOp.GE];
    const rangeConstraints = filterInfo.constraints?.filter(
      c => c.constraint.iColumn === firstPkCol && rangeOps.includes(c.constraint.op)
    ) || [];

    if (rangeConstraints.length > 0) {
      return {
        type: 'range',
        columnIndex: firstPkCol,
        constraints: rangeConstraints.map(c => ({
          columnIndex: c.constraint.iColumn,
          op: c.constraint.op,
          value: c.argvIndex > 0 ? filterInfo.args[c.argvIndex - 1] : undefined,
        })),
      };
    }

    return { type: 'scan' };
  }

  /**
   * Scan a range of PK values.
   */
  private async *scanPKRange(
    store: IndexedDBStore,
    _access: PKAccessPattern,
    filterInfo: FilterInfo
  ): AsyncIterable<Row> {
    const schema = this.tableSchema!;
    const bounds = buildTableScanBounds(schema.schemaName, schema.name);

    // TODO: Refine bounds based on range constraints
    // For now, do a full scan with filter
    for await (const entry of store.iterate(bounds)) {
      const row = deserializeRow(entry.value);
      if (this.matchesFilters(row, filterInfo)) {
        yield row;
      }
    }
  }

  /**
   * Check if a row matches the filter constraints.
   */
  private matchesFilters(row: Row, filterInfo: FilterInfo): boolean {
    if (!filterInfo.constraints || filterInfo.constraints.length === 0) {
      return true;
    }

    for (const constraintEntry of filterInfo.constraints) {
      const { constraint, argvIndex } = constraintEntry;
      if (constraint.iColumn < 0 || argvIndex <= 0) {
        continue;
      }

      const rowValue = row[constraint.iColumn];
      const filterValue = filterInfo.args[argvIndex - 1];

      if (!this.compareValues(rowValue, constraint.op, filterValue)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Compare two values according to an operator.
   */
  private compareValues(a: SqlValue, op: IndexConstraintOp, b: SqlValue): boolean {
    if (a === null || b === null) {
      return op === IndexConstraintOp.EQ ? a === b : false;
    }

    switch (op) {
      case IndexConstraintOp.EQ: return a === b || (typeof a === 'string' && typeof b === 'string' &&
        this.config.collation === 'NOCASE' && a.toLowerCase() === b.toLowerCase());
      case IndexConstraintOp.NE: return a !== b;
      case IndexConstraintOp.LT: return a < b;
      case IndexConstraintOp.LE: return a <= b;
      case IndexConstraintOp.GT: return a > b;
      case IndexConstraintOp.GE: return a >= b;
      default: return true;
    }
  }

  /**
   * Perform an update operation (INSERT, UPDATE, DELETE).
   */
  async update(args: UpdateArgs): Promise<Row | undefined> {
    const store = await this.ensureStore();
    const coordinator = await this.ensureCoordinator();
    const inTransaction = coordinator.isInTransaction();
    const schema = this.tableSchema!;
    const { operation, values, oldKeyValues } = args;

    switch (operation) {
      case 'insert': {
        if (!values) throw new QuereusError('INSERT requires values', StatusCode.MISUSE);
        const pk = this.extractPK(values);
        const key = buildDataKey(schema.schemaName, schema.name, pk, this.encodeOptions);

        // Check for existing row (for conflict handling)
        const existing = await store.get(key);
        if (existing && args.onConflict !== ConflictResolution.REPLACE) {
          throw new ConstraintError('UNIQUE constraint failed: primary key');
        }

        // Route through coordinator or direct write
        if (inTransaction) {
          coordinator.put(key, serializeRow(values));
        } else {
          await store.put(key, serializeRow(values));
        }

        // Update secondary indexes
        await this.updateSecondaryIndexes(store, null, values, pk, inTransaction);

        // Track statistics (only count as new if not replacing)
        if (!existing) {
          this.trackMutation(+1, inTransaction);
        }

        // Emit event (queued if in transaction)
        coordinator.queueEvent({
          type: 'insert',
          schemaName: schema.schemaName,
          tableName: schema.name,
          key: pk,
          newRow: values,
        });

        return values;
      }

      case 'update': {
        if (!values || !oldKeyValues) throw new QuereusError('UPDATE requires values and oldKeyValues', StatusCode.MISUSE);
        const oldPk = this.extractPK(oldKeyValues);
        const newPk = this.extractPK(values);
        const oldKey = buildDataKey(schema.schemaName, schema.name, oldPk, this.encodeOptions);
        const newKey = buildDataKey(schema.schemaName, schema.name, newPk, this.encodeOptions);

        // Get old row for index updates
        const oldRowData = await store.get(oldKey);
        const oldRow = oldRowData ? deserializeRow(oldRowData) : null;

        // Delete old key if PK changed
        if (!this.keysEqual(oldPk, newPk)) {
          if (inTransaction) {
            coordinator.delete(oldKey);
          } else {
            await store.delete(oldKey);
          }
        }

        // Write new row
        if (inTransaction) {
          coordinator.put(newKey, serializeRow(values));
        } else {
          await store.put(newKey, serializeRow(values));
        }

        // Update secondary indexes
        await this.updateSecondaryIndexes(store, oldRow, values, newPk, inTransaction);

        // Emit event (queued if in transaction)
        coordinator.queueEvent({
          type: 'update',
          schemaName: schema.schemaName,
          tableName: schema.name,
          key: newPk,
          oldRow: oldRow || undefined,
          newRow: values,
        });

        return values;
      }

      case 'delete': {
        if (!oldKeyValues) throw new QuereusError('DELETE requires oldKeyValues', StatusCode.MISUSE);
        const pk = this.extractPK(oldKeyValues);
        const key = buildDataKey(schema.schemaName, schema.name, pk, this.encodeOptions);

        // Get old row for index cleanup
        const oldRowData = await store.get(key);
        const oldRow = oldRowData ? deserializeRow(oldRowData) : null;

        // Delete
        if (inTransaction) {
          coordinator.delete(key);
        } else {
          await store.delete(key);
        }

        // Remove from secondary indexes
        if (oldRow) {
          await this.updateSecondaryIndexes(store, oldRow, null, pk, inTransaction);
          // Track statistics
          this.trackMutation(-1, inTransaction);
        }

        // Emit event (queued if in transaction)
        coordinator.queueEvent({
          type: 'delete',
          schemaName: schema.schemaName,
          tableName: schema.name,
          key: pk,
          oldRow: oldRow || undefined,
        });

        return undefined;
      }

      default:
        throw new QuereusError(`Unknown operation: ${operation}`, StatusCode.MISUSE);
    }
  }

  /**
   * Update secondary indexes after a row change.
   */
  private async updateSecondaryIndexes(
    store: IndexedDBStore,
    oldRow: Row | null,
    newRow: Row | null,
    pk: SqlValue[],
    inTransaction = false
  ): Promise<void> {
    const schema = this.tableSchema!;
    const indexes = schema.indexes || [];
    const coordinator = this.coordinator;

    for (const index of indexes) {
      const indexCols = index.columns.map(c => c.index);

      // Remove old index entry
      if (oldRow) {
        const oldIndexValues = indexCols.map(i => oldRow[i]);
        const oldIndexKey = buildIndexKey(
          schema.schemaName,
          schema.name,
          index.name,
          oldIndexValues,
          pk,
          this.encodeOptions
        );
        if (inTransaction && coordinator) {
          coordinator.delete(oldIndexKey);
        } else {
          await store.delete(oldIndexKey);
        }
      }

      // Add new index entry
      if (newRow) {
        const newIndexValues = indexCols.map(i => newRow[i]);
        const newIndexKey = buildIndexKey(
          schema.schemaName,
          schema.name,
          index.name,
          newIndexValues,
          pk,
          this.encodeOptions
        );
        // Index value is empty - we just need the key for lookups
        if (inTransaction && coordinator) {
          coordinator.put(newIndexKey, new Uint8Array(0));
        } else {
          await store.put(newIndexKey, new Uint8Array(0));
        }
      }
    }
  }

  /**
   * Check if two PK arrays are equal.
   */
  private keysEqual(a: SqlValue[], b: SqlValue[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /**
   * Disconnect from the store.
   */
  async disconnect(): Promise<void> {
    // Flush any pending stats before disconnecting
    if (this.mutationCount > 0 && this.store) {
      await this.flushStats();
    }
    // Store is managed by the module, not the table
    this.store = null;
  }

  /**
   * Get the table configuration.
   */
  getConfig(): IndexedDBModuleConfig {
    return this.config;
  }

  /**
   * Get the table schema.
   */
  getSchema(): TableSchema {
    return this.tableSchema!;
  }

  /**
   * Get the current estimated row count.
   * Returns cached value, loading from storage if needed.
   */
  async getEstimatedRowCount(): Promise<number> {
    if (this.cachedStats) {
      return this.cachedStats.rowCount;
    }

    const store = await this.ensureStore();
    const schema = this.tableSchema!;
    const statsKey = buildMetaKey('stats', schema.schemaName, schema.name);
    const statsData = await store.get(statsKey);

    if (statsData) {
      this.cachedStats = deserializeStats(statsData);
      return this.cachedStats.rowCount;
    }

    // No stats yet, return 0
    return 0;
  }

  /**
   * Track a mutation and schedule lazy stats persistence.
   */
  private trackMutation(delta: number, inTransaction = false): void {
    if (inTransaction) {
      // Buffer during transaction - stats will be applied at commit
      this.pendingStatsDelta += delta;
      return;
    }

    if (!this.cachedStats) {
      this.cachedStats = { rowCount: 0, updatedAt: Date.now() };
    }

    this.cachedStats.rowCount = Math.max(0, this.cachedStats.rowCount + delta);
    this.cachedStats.updatedAt = Date.now();
    this.mutationCount++;

    // Schedule lazy flush after threshold
    if (this.mutationCount >= STATS_FLUSH_INTERVAL && !this.statsFlushPending) {
      this.statsFlushPending = true;
      queueMicrotask(() => this.flushStats());
    }
  }

  /**
   * Flush statistics to persistent storage.
   */
  private async flushStats(): Promise<void> {
    this.statsFlushPending = false;
    this.mutationCount = 0;

    if (!this.cachedStats || !this.store) {
      return;
    }

    const schema = this.tableSchema!;
    const statsKey = buildMetaKey('stats', schema.schemaName, schema.name);
    await this.store.put(statsKey, serializeStats(this.cachedStats));
  }
}

/**
 * PK access pattern analysis result.
 */
interface PKAccessPattern {
  type: 'point' | 'range' | 'scan';
  values?: SqlValue[];
  columnIndex?: number;
  constraints?: Array<{ columnIndex: number; op: IndexConstraintOp; value?: SqlValue }>;
}
