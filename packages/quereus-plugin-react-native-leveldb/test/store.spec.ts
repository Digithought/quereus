/**
 * Tests for React Native LevelDB store implementation.
 *
 * Uses a mock LevelDB implementation to test the store without
 * requiring the actual react-native-leveldb native module.
 */

import { expect } from 'chai';
import { ReactNativeLevelDBStore, type LevelDB, type LevelDBIterator } from '../src/store.js';

/**
 * Mock LevelDB implementation for testing.
 * Simulates react-native-leveldb's synchronous API.
 */
class MockLevelDB implements LevelDB {
	private data = new Map<string, ArrayBuffer>();
	private closed = false;

	put(key: ArrayBuffer, value: ArrayBuffer): void {
		this.checkOpen();
		this.data.set(this.keyToString(key), this.copyBuffer(value));
	}

	getBuffer(key: ArrayBuffer): ArrayBuffer | null {
		this.checkOpen();
		const value = this.data.get(this.keyToString(key));
		return value ? this.copyBuffer(value) : null;
	}

	delete(key: ArrayBuffer): void {
		this.checkOpen();
		this.data.delete(this.keyToString(key));
	}

	close(): void {
		this.closed = true;
	}

	newIterator(): LevelDBIterator {
		this.checkOpen();
		return new MockLevelDBIterator(this.data);
	}

	private checkOpen(): void {
		if (this.closed) {
			throw new Error('Database is closed');
		}
	}

	private keyToString(key: ArrayBuffer): string {
		return Array.from(new Uint8Array(key)).join(',');
	}

	private copyBuffer(buffer: ArrayBuffer): ArrayBuffer {
		const copy = new ArrayBuffer(buffer.byteLength);
		new Uint8Array(copy).set(new Uint8Array(buffer));
		return copy;
	}
}

/**
 * Mock iterator for testing.
 */
class MockLevelDBIterator implements LevelDBIterator {
	private entries: Array<{ key: ArrayBuffer; value: ArrayBuffer }> = [];
	private index = -1;
	private closed = false;

	constructor(data: Map<string, ArrayBuffer>) {
		// Convert map to sorted array of entries
		for (const [keyStr, value] of data) {
			const keyParts = keyStr.split(',').map(Number);
			const key = new ArrayBuffer(keyParts.length);
			new Uint8Array(key).set(keyParts);
			this.entries.push({ key, value });
		}
		// Sort by key bytes
		this.entries.sort((a, b) => {
			const aBytes = new Uint8Array(a.key);
			const bBytes = new Uint8Array(b.key);
			const minLen = Math.min(aBytes.length, bBytes.length);
			for (let i = 0; i < minLen; i++) {
				if (aBytes[i] !== bBytes[i]) {
					return aBytes[i] - bBytes[i];
				}
			}
			return aBytes.length - bBytes.length;
		});
	}

	valid(): boolean {
		return !this.closed && this.index >= 0 && this.index < this.entries.length;
	}

	seek(key: ArrayBuffer): void {
		this.checkOpen();
		const targetBytes = new Uint8Array(key);
		this.index = this.entries.findIndex(entry => {
			const entryBytes = new Uint8Array(entry.key);
			return this.compareBytes(entryBytes, targetBytes) >= 0;
		});
		if (this.index === -1) {
			this.index = this.entries.length; // Past end
		}
	}

	seekToFirst(): void {
		this.checkOpen();
		this.index = this.entries.length > 0 ? 0 : -1;
	}

	seekToLast(): void {
		this.checkOpen();
		this.index = this.entries.length > 0 ? this.entries.length - 1 : -1;
	}

	next(): void {
		this.checkOpen();
		this.index++;
	}

	prev(): void {
		this.checkOpen();
		this.index--;
	}

	keyBuf(): ArrayBuffer {
		this.checkOpen();
		if (!this.valid()) throw new Error('Iterator not valid');
		return this.entries[this.index].key;
	}

	valueBuf(): ArrayBuffer {
		this.checkOpen();
		if (!this.valid()) throw new Error('Iterator not valid');
		return this.entries[this.index].value;
	}

	close(): void {
		this.closed = true;
	}

	private checkOpen(): void {
		if (this.closed) {
			throw new Error('Iterator is closed');
		}
	}

	private compareBytes(a: Uint8Array, b: Uint8Array): number {
		const minLen = Math.min(a.length, b.length);
		for (let i = 0; i < minLen; i++) {
			if (a[i] !== b[i]) {
				return a[i] - b[i];
			}
		}
		return a.length - b.length;
	}
}

describe('ReactNativeLevelDBStore', () => {
	let store: ReactNativeLevelDBStore;
	let mockDb: MockLevelDB;

	beforeEach(() => {
		mockDb = new MockLevelDB();
		store = ReactNativeLevelDBStore.create(mockDb);
	});

	afterEach(async () => {
		await store.close();
	});

	describe('Basic operations', () => {
		it('should put and get a value', async () => {
			const key = new Uint8Array([1, 2, 3]);
			const value = new Uint8Array([4, 5, 6]);

			await store.put(key, value);
			const result = await store.get(key);

			expect(result).to.deep.equal(value);
		});

		it('should return undefined for non-existent key', async () => {
			const key = new Uint8Array([1, 2, 3]);
			const result = await store.get(key);

			expect(result).to.be.undefined;
		});

		it('should delete a key', async () => {
			const key = new Uint8Array([1, 2, 3]);
			const value = new Uint8Array([4, 5, 6]);

			await store.put(key, value);
			await store.delete(key);
			const result = await store.get(key);

			expect(result).to.be.undefined;
		});

		it('should check if key exists with has()', async () => {
			const key = new Uint8Array([10, 20, 30]);
			const value = new Uint8Array([40, 50, 60]);

			expect(await store.has(key)).to.be.false;
			await store.put(key, value);
			expect(await store.has(key)).to.be.true;
		});

		it('should overwrite existing values', async () => {
			const key = new Uint8Array([1, 2, 3]);
			const value1 = new Uint8Array([4, 5, 6]);
			const value2 = new Uint8Array([7, 8, 9]);

			await store.put(key, value1);
			await store.put(key, value2);
			const result = await store.get(key);

			expect(result).to.deep.equal(value2);
		});
	});

	describe('Iteration', () => {
		beforeEach(async () => {
			// Insert test data
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			await store.put(new Uint8Array([3]), new Uint8Array([30]));
			await store.put(new Uint8Array([4]), new Uint8Array([40]));
			await store.put(new Uint8Array([5]), new Uint8Array([50]));
		});

		it('should iterate all entries in order', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate()) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(5);
			expect(entries[0].key[0]).to.equal(1);
			expect(entries[4].key[0]).to.equal(5);
		});

		it('should iterate with gte bound', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ gte: new Uint8Array([3]) })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(3);
			expect(entries[0].key[0]).to.equal(3);
		});

		it('should iterate with lt bound', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ lt: new Uint8Array([3]) })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(2);
			expect(entries[1].key[0]).to.equal(2);
		});

		it('should iterate with gt bound (exclusive)', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ gt: new Uint8Array([2]) })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(3);
			expect(entries[0].key[0]).to.equal(3);
		});

		it('should iterate with lte bound (inclusive)', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ lte: new Uint8Array([3]) })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(3);
			expect(entries[2].key[0]).to.equal(3);
		});

		it('should iterate in reverse', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ reverse: true })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(5);
			expect(entries[0].key[0]).to.equal(5);
			expect(entries[4].key[0]).to.equal(1);
		});

		it('should respect limit', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ limit: 2 })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(2);
		});

		it('should combine gte and lt bounds', async () => {
			const entries: Array<{ key: Uint8Array; value: Uint8Array }> = [];
			for await (const entry of store.iterate({ gte: new Uint8Array([2]), lt: new Uint8Array([4]) })) {
				entries.push(entry);
			}

			expect(entries.length).to.equal(2);
			expect(entries[0].key[0]).to.equal(2);
			expect(entries[1].key[0]).to.equal(3);
		});
	});

	describe('Batch operations', () => {
		it('should execute batch put operations', async () => {
			const batch = store.batch();
			batch.put(new Uint8Array([1]), new Uint8Array([10]));
			batch.put(new Uint8Array([2]), new Uint8Array([20]));
			batch.put(new Uint8Array([3]), new Uint8Array([30]));
			await batch.write();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(await store.get(new Uint8Array([3]))).to.deep.equal(new Uint8Array([30]));
		});

		it('should execute batch delete operations', async () => {
			await store.put(new Uint8Array([100]), new Uint8Array([10]));
			await store.put(new Uint8Array([101]), new Uint8Array([20]));

			const batch = store.batch();
			batch.delete(new Uint8Array([100]));
			batch.delete(new Uint8Array([101]));
			await batch.write();

			expect(await store.has(new Uint8Array([100]))).to.be.false;
			expect(await store.has(new Uint8Array([101]))).to.be.false;
		});

		it('should clear batch operations', async () => {
			const batch = store.batch();
			batch.put(new Uint8Array([1]), new Uint8Array([10]));
			batch.clear();
			await batch.write();

			expect(await store.has(new Uint8Array([1]))).to.be.false;
		});
	});

	describe('Approximate count', () => {
		it('should return count of all entries', async () => {
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			await store.put(new Uint8Array([3]), new Uint8Array([30]));

			const count = await store.approximateCount();
			expect(count).to.equal(3);
		});

		it('should return count within range', async () => {
			await store.put(new Uint8Array([1]), new Uint8Array([10]));
			await store.put(new Uint8Array([2]), new Uint8Array([20]));
			await store.put(new Uint8Array([3]), new Uint8Array([30]));
			await store.put(new Uint8Array([4]), new Uint8Array([40]));

			const count = await store.approximateCount({ gte: new Uint8Array([2]), lt: new Uint8Array([4]) });
			expect(count).to.equal(2);
		});
	});

	describe('Error handling', () => {
		it('should throw when operating on closed store', async () => {
			await store.close();

			try {
				await store.get(new Uint8Array([1]));
				expect.fail('Should have thrown');
			} catch (e) {
				expect((e as Error).message).to.include('closed');
			}
		});
	});
});

