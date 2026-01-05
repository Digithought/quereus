/**
 * Reactive event types and emitter for schema and data changes.
 */

import type { Row, SqlValue, VTableEventEmitter, VTableDataChangeEvent, VTableSchemaChangeEvent } from '@quereus/quereus';

/**
 * Schema change event types.
 */
export interface SchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index';
  schemaName: string;
  objectName: string;
  ddl?: string;
  /** True if this event originated from sync (remote replica) or cross-tab. */
  remote?: boolean;
}

/**
 * Data change event types.
 */
export interface DataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  schemaName: string;
  tableName: string;
  /** Primary key values. Alias: pk */
  key?: SqlValue[];
  /** Primary key values. Alias: key */
  pk?: SqlValue[];
  oldRow?: Row;
  newRow?: Row;
  /** Column names that were changed (for update events). */
  changedColumns?: string[];
  /** True if this event originated from sync (remote replica) or cross-tab. */
  remote?: boolean;
}

/**
 * Event listener types.
 */
export type SchemaChangeListener = (event: SchemaChangeEvent) => void;
export type DataChangeListener = (event: DataChangeEvent) => void;

/**
 * Key for identifying a pending remote schema event.
 */
interface PendingRemoteSchemaEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index';
  schemaName: string;
  objectName: string;
}

/**
 * Simple event emitter for store events.
 * Implements VTableEventEmitter for compatibility with core vtab event system.
 */
export class StoreEventEmitter implements VTableEventEmitter {
	private schemaListeners: Set<SchemaChangeListener> = new Set();
	private dataListeners: Set<DataChangeListener> = new Set();
	private batchedDataEvents: DataChangeEvent[] = [];
	private isBatching = false;
	/**
	 * Pending remote schema events that should be marked as remote when they arrive.
	 * Uses a Map with stringified key for O(1) lookup.
	 */
	private pendingRemoteSchemaEvents: Map<string, number> = new Map();

  /**
   * Subscribe to schema change events.
   * @returns Unsubscribe function.
   */
  onSchemaChange(listener: SchemaChangeListener): () => void {
    this.schemaListeners.add(listener);
    return () => this.schemaListeners.delete(listener);
  }

  /**
   * Subscribe to data change events.
   * @returns Unsubscribe function.
   */
  onDataChange(listener: DataChangeListener): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  /**
   * Emit a schema change event.
   * If the event matches a pending remote event, it's automatically marked as remote.
   */
  emitSchemaChange(event: SchemaChangeEvent): void {
    // Check if this event matches a pending remote event
    const key = this.makeSchemaEventKey(event);
    const pendingCount = this.pendingRemoteSchemaEvents.get(key);
    if (pendingCount !== undefined && pendingCount > 0) {
      // Mark as remote and decrement the pending count
      event = { ...event, remote: true };
      if (pendingCount === 1) {
        this.pendingRemoteSchemaEvents.delete(key);
      } else {
        this.pendingRemoteSchemaEvents.set(key, pendingCount - 1);
      }
    }

    for (const listener of this.schemaListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Schema change listener error:', e);
      }
    }
  }

  /**
   * Create a unique key for a schema event signature.
   */
  private makeSchemaEventKey(event: PendingRemoteSchemaEvent): string {
    return `${event.type}:${event.objectType}:${event.schemaName.toLowerCase()}:${event.objectName.toLowerCase()}`;
  }

  /**
   * Register an expected remote schema event.
   * When a matching event is emitted, it will be automatically marked as remote.
   * Uses reference counting to handle concurrent applies of the same event type.
   */
  expectRemoteSchemaEvent(event: PendingRemoteSchemaEvent): void {
    const key = this.makeSchemaEventKey(event);
    const current = this.pendingRemoteSchemaEvents.get(key) ?? 0;
    this.pendingRemoteSchemaEvents.set(key, current + 1);
  }

  /**
   * Clear an expected remote schema event (e.g., if the operation failed).
   */
  clearExpectedRemoteSchemaEvent(event: PendingRemoteSchemaEvent): void {
    const key = this.makeSchemaEventKey(event);
    const current = this.pendingRemoteSchemaEvents.get(key);
    if (current !== undefined && current > 0) {
      if (current === 1) {
        this.pendingRemoteSchemaEvents.delete(key);
      } else {
        this.pendingRemoteSchemaEvents.set(key, current - 1);
      }
    }
  }

  /**
   * Emit a data change event.
   * If batching is active, queues the event for later emission.
   */
  emitDataChange(event: DataChangeEvent): void {
    if (this.isBatching) {
      this.batchedDataEvents.push(event);
      return;
    }

    for (const listener of this.dataListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Data change listener error:', e);
      }
    }
  }

  /**
   * Start batching data change events.
   * Events will be queued until flush() or discard() is called.
   */
  startBatch(): void {
    this.isBatching = true;
    this.batchedDataEvents = [];
  }

  /**
   * Flush batched data change events to listeners.
   */
  flushBatch(): void {
    this.isBatching = false;
    const events = this.batchedDataEvents;
    this.batchedDataEvents = [];

    for (const event of events) {
      for (const listener of this.dataListeners) {
        try {
          listener(event);
        } catch (e) {
          console.error('Data change listener error:', e);
        }
      }
    }
  }

  /**
   * Discard batched data change events (e.g., on rollback).
   */
  discardBatch(): void {
    this.isBatching = false;
    this.batchedDataEvents = [];
  }

	/**
	 * Check if there are any listeners registered.
	 */
	hasListeners(): boolean {
		return this.schemaListeners.size > 0 || this.dataListeners.size > 0;
	}

	/**
	 * Check if there are any data listeners registered (VTableEventEmitter compatibility).
	 */
	hasDataListeners(): boolean {
		return this.dataListeners.size > 0;
	}

	/**
	 * Check if there are any schema listeners registered (VTableEventEmitter compatibility).
	 */
	hasSchemaListeners(): boolean {
		return this.schemaListeners.size > 0;
	}

	/**
	 * Remove all listeners.
	 */
	removeAllListeners(): void {
		this.schemaListeners.clear();
		this.dataListeners.clear();
		this.batchedDataEvents = [];
		this.isBatching = false;
	}
}

