/**
 * Reactive event types and emitter for schema and data changes.
 */

import type { Row, SqlValue } from '@quereus/quereus';

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
  key: SqlValue[];
  oldRow?: Row;
  newRow?: Row;
  /** True if this event originated from another browser tab (IndexedDB only). */
  remote?: boolean;
}

/**
 * Event listener types.
 */
export type SchemaChangeListener = (event: SchemaChangeEvent) => void;
export type DataChangeListener = (event: DataChangeEvent) => void;

/**
 * Simple event emitter for store events.
 */
export class StoreEventEmitter {
  private schemaListeners: Set<SchemaChangeListener> = new Set();
  private dataListeners: Set<DataChangeListener> = new Set();
  private batchedDataEvents: DataChangeEvent[] = [];
  private isBatching = false;

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
   */
  emitSchemaChange(event: SchemaChangeEvent): void {
    for (const listener of this.schemaListeners) {
      try {
        listener(event);
      } catch (e) {
        console.error('Schema change listener error:', e);
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
   * Remove all listeners.
   */
  removeAllListeners(): void {
    this.schemaListeners.clear();
    this.dataListeners.clear();
    this.batchedDataEvents = [];
    this.isBatching = false;
  }
}

