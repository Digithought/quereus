/**
 * LevelDB-based KVStore implementation for React Native.
 *
 * Uses react-native-leveldb for LevelDB bindings on iOS/Android.
 * Keys and values are stored as binary ArrayBuffers.
 */

import type { KVStore, KVEntry, WriteBatch, IterateOptions } from '@quereus/store';

/**
 * Type definition for react-native-leveldb database.
 * We use a minimal interface to avoid hard dependency on the package types.
 *
 * react-native-leveldb provides synchronous, blocking APIs which are
 * significantly faster than alternatives like AsyncStorage.
 */
export interface LevelDB {
	/**
	 * Put a key-value pair.
	 */
	put(key: ArrayBuffer, value: ArrayBuffer): void;

	/**
	 * Get a value by key.
	 * @returns The value as ArrayBuffer, or null if not found.
	 */
	getBuffer(key: ArrayBuffer): ArrayBuffer | null;

	/**
	 * Delete a key.
	 */
	delete(key: ArrayBuffer): void;

	/**
	 * Close the database.
	 */
	close(): void;

	/**
	 * Create a new iterator for range scans.
	 */
	newIterator(): LevelDBIterator;
}

/**
 * Type definition for react-native-leveldb iterator.
 */
export interface LevelDBIterator {
	/**
	 * Check if the iterator points to a valid entry.
	 */
	valid(): boolean;

	/**
	 * Move to the first entry >= the given key.
	 */
	seek(key: ArrayBuffer): void;

	/**
	 * Move to the first entry.
	 */
	seekToFirst(): void;

	/**
	 * Move to the last entry.
	 */
	seekToLast(): void;

	/**
	 * Move to the next entry.
	 */
	next(): void;

	/**
	 * Move to the previous entry.
	 */
	prev(): void;

	/**
	 * Get the current key.
	 */
	keyBuf(): ArrayBuffer;

	/**
	 * Get the current value.
	 */
	valueBuf(): ArrayBuffer;

	/**
	 * Close the iterator.
	 */
	close(): void;
}

/**
 * Factory function type for opening a LevelDB database.
 * Should be react-native-leveldb's LevelDB.open().
 */
export type LevelDBOpenFn = (name: string, createIfMissing: boolean, errorIfExists: boolean) => LevelDB;

/**
 * Options for creating a React Native LevelDB store.
 */
export interface ReactNativeLevelDBStoreOptions {
	/** The LevelDB database instance. */
	db: LevelDB;
}

/**
 * LevelDB implementation of KVStore for React Native.
 *
 * Keys and values are stored as ArrayBuffers. LevelDB provides correct
 * lexicographic byte ordering for range scans.
 */
export class ReactNativeLevelDBStore implements KVStore {
	private db: LevelDB;
	private closed = false;

	constructor(options: ReactNativeLevelDBStoreOptions) {
		this.db = options.db;
	}

	/**
	 * Create a store with the given LevelDB instance.
	 */
	static create(db: LevelDB): ReactNativeLevelDBStore {
		return new ReactNativeLevelDBStore({ db });
	}

	/**
	 * Open a store using the provided open function.
	 */
	static open(
		openFn: LevelDBOpenFn,
		name: string,
		options?: { createIfMissing?: boolean; errorIfExists?: boolean }
	): ReactNativeLevelDBStore {
		const db = openFn(
			name,
			options?.createIfMissing ?? true,
			options?.errorIfExists ?? false
		);
		return new ReactNativeLevelDBStore({ db });
	}

	async get(key: Uint8Array): Promise<Uint8Array | undefined> {
		this.checkOpen();
		const result = this.db.getBuffer(toArrayBuffer(key));
		return result === null ? undefined : toUint8Array(result);
	}

	async put(key: Uint8Array, value: Uint8Array): Promise<void> {
		this.checkOpen();
		this.db.put(toArrayBuffer(key), toArrayBuffer(value));
	}

	async delete(key: Uint8Array): Promise<void> {
		this.checkOpen();
		this.db.delete(toArrayBuffer(key));
	}

	async has(key: Uint8Array): Promise<boolean> {
		this.checkOpen();
		const result = this.db.getBuffer(toArrayBuffer(key));
		return result !== null;
	}

	async *iterate(options?: IterateOptions): AsyncIterable<KVEntry> {
		this.checkOpen();

		const iterator = this.db.newIterator();
		try {
			const entries = this.collectEntries(iterator, options);
			for (const entry of entries) {
				yield entry;
			}
		} finally {
			iterator.close();
		}
	}

	private collectEntries(iterator: LevelDBIterator, options?: IterateOptions): KVEntry[] {
		const entries: KVEntry[] = [];
		const limit = options?.limit;
		const reverse = options?.reverse ?? false;

		// Position the iterator at the start
		if (reverse) {
			if (options?.lte) {
				iterator.seek(toArrayBuffer(options.lte));
				// If we seeked past, go back
				if (!iterator.valid()) {
					iterator.seekToLast();
				} else {
					// Check if current key is > lte (need to go back)
					const currentKey = toUint8Array(iterator.keyBuf());
					if (compareBytes(currentKey, options.lte) > 0) {
						iterator.prev();
					}
				}
			} else if (options?.lt) {
				iterator.seek(toArrayBuffer(options.lt));
				// Go to previous since lt is exclusive
				if (iterator.valid()) {
					iterator.prev();
				} else {
					iterator.seekToLast();
				}
			} else {
				iterator.seekToLast();
			}
		} else {
			if (options?.gte) {
				iterator.seek(toArrayBuffer(options.gte));
			} else if (options?.gt) {
				iterator.seek(toArrayBuffer(options.gt));
				// Skip if current key equals gt (exclusive)
				if (iterator.valid()) {
					const currentKey = toUint8Array(iterator.keyBuf());
					if (compareBytes(currentKey, options.gt) === 0) {
						iterator.next();
					}
				}
			} else {
				iterator.seekToFirst();
			}
		}

		// Collect entries
		while (iterator.valid()) {
			if (limit !== undefined && entries.length >= limit) {
				break;
			}

			const key = toUint8Array(iterator.keyBuf());
			const value = toUint8Array(iterator.valueBuf());

			// Check bounds
			if (!reverse) {
				if (options?.lt && compareBytes(key, options.lt) >= 0) break;
				if (options?.lte && compareBytes(key, options.lte) > 0) break;
			} else {
				if (options?.gt && compareBytes(key, options.gt) <= 0) break;
				if (options?.gte && compareBytes(key, options.gte) < 0) break;
			}

			entries.push({ key, value });

			if (reverse) {
				iterator.prev();
			} else {
				iterator.next();
			}
		}

		return entries;
	}

	batch(): WriteBatch {
		this.checkOpen();
		return new ReactNativeLevelDBWriteBatch(this);
	}

	async close(): Promise<void> {
		if (!this.closed) {
			this.closed = true;
			this.db.close();
		}
	}

	async approximateCount(options?: IterateOptions): Promise<number> {
		this.checkOpen();
		// LevelDB doesn't have a native count, so we iterate and count
		let count = 0;
		for await (const _ of this.iterate(options)) {
			count++;
		}
		return count;
	}

	private checkOpen(): void {
		if (this.closed) {
			throw new Error('ReactNativeLevelDBStore is closed');
		}
	}

	/**
	 * Execute a batch of operations.
	 * Called by ReactNativeLevelDBWriteBatch.
	 */
	executeBatch(ops: Array<{ type: 'put'; key: Uint8Array; value: Uint8Array } | { type: 'delete'; key: Uint8Array }>): void {
		this.checkOpen();
		// react-native-leveldb operations are synchronous, so we execute directly
		for (const op of ops) {
			if (op.type === 'put') {
				this.db.put(toArrayBuffer(op.key), toArrayBuffer(op.value));
			} else {
				this.db.delete(toArrayBuffer(op.key));
			}
		}
	}
}

/**
 * WriteBatch implementation for React Native LevelDB.
 */
class ReactNativeLevelDBWriteBatch implements WriteBatch {
	private store: ReactNativeLevelDBStore;
	private ops: Array<{ type: 'put'; key: Uint8Array; value: Uint8Array } | { type: 'delete'; key: Uint8Array }> = [];

	constructor(store: ReactNativeLevelDBStore) {
		this.store = store;
	}

	put(key: Uint8Array, value: Uint8Array): void {
		this.ops.push({ type: 'put', key, value });
	}

	delete(key: Uint8Array): void {
		this.ops.push({ type: 'delete', key });
	}

	async write(): Promise<void> {
		if (this.ops.length > 0) {
			this.store.executeBatch(this.ops);
			this.ops = [];
		}
	}

	clear(): void {
		this.ops = [];
	}
}

// ============================================================================
// Binary conversion utilities
// ============================================================================

/**
 * Convert Uint8Array to ArrayBuffer.
 */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	// Create a new ArrayBuffer copy to handle views into SharedArrayBuffer
	const copy = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(copy).set(bytes);
	return copy;
}

/**
 * Convert ArrayBuffer to Uint8Array.
 */
function toUint8Array(data: ArrayBuffer): Uint8Array {
	return new Uint8Array(data);
}

/**
 * Compare two Uint8Arrays lexicographically.
 * @returns Negative if a < b, 0 if equal, positive if a > b.
 */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const minLength = Math.min(a.length, b.length);
	for (let i = 0; i < minLength; i++) {
		if (a[i] !== b[i]) {
			return a[i] - b[i];
		}
	}
	return a.length - b.length;
}

