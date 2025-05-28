import type { BTreeKey } from '../types.js';
import type { Row } from '../../../common/types.js';
import type { BTree } from 'inheritree';

/**
 * A mutation-safe iterator for BTree that automatically handles tree mutations
 * by storing the current key and reopening the path when needed.
 */
export class MutationSafeIterator<K extends BTreeKey, V> {
	private currentKey: K | null = null;
	private isExhausted = false;
	private readonly isAscending: boolean;

	constructor(
		private readonly tree: BTree<K, V>, // BTree from inherited class
		private readonly ascending: boolean = true
	) {
		this.isAscending = ascending;
	}

	async* iterate(): AsyncIterable<V> {
		// Start iteration
		let path = this.isAscending ? this.tree.first() : this.tree.last();
		if (!path) return; // Empty tree

		while (path && !this.isExhausted) {
			try {
				const value = this.tree.at(path);
				if (value) {
					// Store the current key for potential path recovery
					this.currentKey = this.extractKey(value);
					yield value;
				}

				// Try to advance to the next position
				const iterator = this.isAscending ? this.tree.ascending(path) : this.tree.descending(path);
				const next = iterator.next();
				if (next.done) {
					this.isExhausted = true;
					break;
				}
				path = next.value;
			} catch (error) {
				// Check if this is a path invalidation error
				if (this.isPathInvalidationError(error)) {
					// Recover by finding the current key and continuing from there
					path = this.recoverPath();
					if (!path) {
						this.isExhausted = true;
						break;
					}
				} else {
					throw error; // Re-throw other errors
				}
			}
		}
	}

	private isPathInvalidationError(error: any): boolean {
		return error &&
			   typeof error.message === 'string' &&
			   error.message.includes('Path is invalid due to mutation of the tree');
	}

	private recoverPath(): any | null {
		if (!this.currentKey) return null;

		try {
			// Find the current key in the tree
			const foundPath = this.tree.find(this.currentKey);
			if (!foundPath) {
				// Key was deleted, find the next key in the iteration direction
				return this.findNextKeyAfterDeletion();
			}

			// Advance one position from the found key
			const iterator = this.isAscending ? this.tree.ascending(foundPath) : this.tree.descending(foundPath);
			const next = iterator.next();
			return next.done ? null : next.value;
		} catch {
			// If recovery fails, try to find the next available key
			return this.findNextKeyAfterDeletion();
		}
	}

	private findNextKeyAfterDeletion(): any | null {
		if (!this.currentKey) return null;

		// For ascending iteration, find the smallest key greater than currentKey
		// For descending iteration, find the largest key smaller than currentKey
		const startPath = this.isAscending ? this.tree.first() : this.tree.last();
		if (!startPath) return null;

		const iterator = this.isAscending ? this.tree.ascending(startPath) : this.tree.descending(startPath);

		for (const path of iterator) {
			const value = this.tree.at(path);
			if (!value) continue;

			const key = this.extractKey(value);
			const comparison = this.compareKeys(key, this.currentKey);

			if (this.isAscending && comparison > 0) {
				return path;
			} else if (!this.isAscending && comparison < 0) {
				return path;
			}
		}

		return null; // No more keys in the iteration direction
	}

	private extractKey(value: V): K {
		// For Row values, we need to extract the primary key
		// This is a simplified implementation - in practice, we'd need
		// the key extraction function passed in
		if (Array.isArray(value)) {
			// Assume first column is the primary key for simplicity
			return (value as any)[0] as K;
		}
		return value as any as K;
	}

	private compareKeys(a: K, b: K): number {
		// Simple comparison - in practice, we'd use the proper comparator
		if (a == null && b == null) return 0;
		if (a == null) return -1;
		if (b == null) return 1;
		if (a < b) return -1;
		if (a > b) return 1;
		return 0;
	}
}

/**
 * Creates a mutation-safe async iterator for a BTree by collecting all keys first,
 * then iterating through them safely.
 */
export async function* createMutationSafeIterator<K extends BTreeKey, V>(
	tree: any,
	ascending: boolean = true,
	keyExtractor?: (value: V) => K,
	keyComparator?: (a: K, b: K) => number
): AsyncIterable<V> {
	// First, collect all keys from the tree to avoid path invalidation issues
	const keys: K[] = [];

	try {
		const startPath = ascending ? tree.first() : tree.last();
		if (!startPath) return; // Empty tree

		const iterator = ascending ? tree.ascending(startPath) : tree.descending(startPath);
		for (const path of iterator) {
			const value = tree.at(path);
			if (value) {
				const key = keyExtractor ? keyExtractor(value) :
							 Array.isArray(value) ? (value as any)[0] as K : value as any as K;
				keys.push(key);
			}
		}
	} catch (error: any) {
		// If we can't collect keys due to mutation, fall back to simple iteration
		// This might still fail, but it's better than an infinite loop
		if (error &&
			typeof error.message === 'string' &&
			error.message.includes('Path is invalid due to mutation of the tree')) {

			// Try a simple get-based approach for small trees
			return yield* fallbackSimpleIteration(tree, ascending);
		}
		throw error;
	}

	// Now iterate through the collected keys safely
	for (const key of keys) {
		try {
			const value = tree.get(key);
			if (value) {
				yield value;
			}
		} catch (error: any) {
			// If a specific key lookup fails, just skip it
			// This can happen if the key was deleted between collection and access
			continue;
		}
	}
}

async function* fallbackSimpleIteration<V>(
	tree: any,
	ascending: boolean
): AsyncIterable<V> {
	// Simple fallback that tries to iterate without path recovery
	// This is less robust but avoids infinite loops
	try {
		const startPath = ascending ? tree.first() : tree.last();
		if (!startPath) return;

		// Collect a limited number of values to avoid memory issues
		const values: V[] = [];
		const maxValues = 1000; // Limit to prevent memory issues
		let count = 0;

		const iterator = ascending ? tree.ascending(startPath) : tree.descending(startPath);
		for (const path of iterator) {
			if (count >= maxValues) break;

			const value = tree.at(path);
			if (value) {
				values.push(value);
				count++;
			}
		}

		// Yield the collected values
		for (const value of values) {
			yield value;
		}
	} catch {
		// If even the fallback fails, just return empty
		return;
	}
}
