/**
 * Cross-tab synchronization using BroadcastChannel API.
 *
 * Propagates DataChangeEvent across browser tabs sharing the same origin.
 */

import type { DataChangeEvent, StoreEventEmitter } from '@quereus/plugin-store';

/** Channel name prefix for Quereus store broadcasts. */
const CHANNEL_PREFIX = 'quereus-store:';

/**
 * Message format for cross-tab broadcasts.
 */
interface BroadcastMessage {
  type: 'data-change';
  event: DataChangeEvent & { remote?: boolean };
}

/**
 * Cross-tab synchronization for IndexedDB stores.
 *
 * Listens for local data changes and broadcasts them to other tabs.
 * Receives broadcasts from other tabs and emits them locally.
 */
export class CrossTabSync {
  private channel: BroadcastChannel | null = null;
  private eventEmitter: StoreEventEmitter;
  private databaseName: string;
  private unsubscribe: (() => void) | null = null;

  constructor(databaseName: string, eventEmitter: StoreEventEmitter) {
    this.databaseName = databaseName;
    this.eventEmitter = eventEmitter;
  }

  /**
   * Start cross-tab synchronization.
   * Safe to call in non-browser environments (no-op).
   */
  start(): void {
    // Check if BroadcastChannel is available (browser environment)
    if (typeof BroadcastChannel === 'undefined') {
      return;
    }

    const channelName = `${CHANNEL_PREFIX}${this.databaseName}`;
    this.channel = new BroadcastChannel(channelName);

    // Listen for messages from other tabs
    this.channel.onmessage = (event: MessageEvent<BroadcastMessage>) => {
      this.handleMessage(event.data);
    };

    // Subscribe to local data changes to broadcast them
    this.unsubscribe = this.eventEmitter.onDataChange((event) => {
      // Don't re-broadcast events that came from other tabs
      if ((event as DataChangeEvent & { remote?: boolean }).remote) {
        return;
      }
      this.broadcast(event);
    });
  }

  /**
   * Stop cross-tab synchronization and clean up resources.
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.channel) {
      this.channel.close();
      this.channel = null;
    }
  }

  /**
   * Broadcast a data change event to other tabs.
   */
  private broadcast(event: DataChangeEvent): void {
    if (!this.channel) {
      return;
    }

    const message: BroadcastMessage = {
      type: 'data-change',
      event: { ...event },
    };

    try {
      this.channel.postMessage(message);
    } catch (e) {
      // Serialization errors (e.g., if Row contains non-cloneable data)
      console.warn('Failed to broadcast data change:', e);
    }
  }

  /**
   * Handle a message received from another tab.
   */
  private handleMessage(message: BroadcastMessage): void {
    if (message.type !== 'data-change') {
      return;
    }

    // Mark as remote to prevent re-broadcast
    const remoteEvent: DataChangeEvent & { remote: boolean } = {
      ...message.event,
      remote: true,
    };

    // Emit locally so listeners are notified
    this.eventEmitter.emitDataChange(remoteEvent);
  }
}

