import { createLogger } from '../common/logger.js';

const log = createLogger('schema:change-events');

/**
 * Represents a schema change event.
 */
export interface SchemaChangeEvent {
	type: 'table_added' | 'table_removed' | 'table_modified' |
	      'function_added' | 'function_removed' | 'function_modified' |
	      'module_added' | 'module_removed' | 'collation_added' | 'collation_removed';
	schemaName?: string;
	objectName: string;
	oldObject?: any;
	newObject?: any;
}

/**
 * Function that handles schema change events.
 */
export type SchemaChangeListener = (event: SchemaChangeEvent) => void;

/**
 * Manages schema change listeners and notifications.
 */
export class SchemaChangeNotifier {
	private listeners = new Set<SchemaChangeListener>();

	/**
	 * Adds a schema change listener.
	 * @returns A function to unsubscribe the listener.
	 */
	addListener(listener: SchemaChangeListener): () => void {
		this.listeners.add(listener);
		log('Added schema change listener, total listeners: %d', this.listeners.size);
		return () => this.removeListener(listener);
	}

	/**
	 * Removes a schema change listener.
	 */
	removeListener(listener: SchemaChangeListener): void {
		const removed = this.listeners.delete(listener);
		if (removed) {
			log('Removed schema change listener, total listeners: %d', this.listeners.size);
		}
	}

	/**
	 * Notifies all listeners of a schema change event.
	 */
	notifyChange(event: SchemaChangeEvent): void {
		log('Notifying %d listeners of schema change: %s %s',
			this.listeners.size, event.type, event.objectName);

		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (error) {
				log('Error in schema change listener: %s', error);
			}
		}
	}

	/**
	 * Gets the number of active listeners.
	 */
	getListenerCount(): number {
		return this.listeners.size;
	}

	/**
	 * Clears all listeners.
	 */
	clearListeners(): void {
		const count = this.listeners.size;
		this.listeners.clear();
		log('Cleared all %d schema change listeners', count);
	}
}
