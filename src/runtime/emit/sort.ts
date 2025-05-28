import type { SortNode } from '../../planner/nodes/sort.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode, emitCallFromPlan } from '../emitters.js';
import { type Row, type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { BTree } from 'inheritree';
import { compareSqlValues } from '../../util/comparison.js';
import type { SortKey } from '../../planner/nodes/sort.js';

/**
 * Represents a sort entry in our BTree
 */
interface SortEntry {
	sortKey: SqlValue[];  // Composite sort key values
	sequence: number;     // For stable sort
	originalRow: Row;     // The original row data
}

export function emitSort(plan: SortNode, ctx: EmissionContext): Instruction {
	const sourceInstruction = emitPlanNode(plan.source, ctx);
	const keyFunctions = plan.sortKeys.map(key => emitCallFromPlan(key.expression, ctx));

	async function* run(ctx: RuntimeContext, source: AsyncIterable<Row>, ...keyFuncs: Array<(ctx: RuntimeContext) => SqlValue | Promise<SqlValue>>): AsyncIterable<Row> {
		// Create a BTree for sorting with compound key comparison
		const sortBTree = createSortBTree(plan.sortKeys);
		let sequenceNumber = 0;

		try {
			// Phase 1: Insert all rows into the sort BTree
			for await (const sourceRow of source) {
				// Set up context for this row - the source relation should be available for column references
				ctx.context.set(plan.source, () => sourceRow);

				try {
					// Evaluate all sort key expressions for this row
					const keyPromises = keyFuncs.map(func => func(ctx));
					const keys = await Promise.all(keyPromises);

					// Transform sort keys to handle DESC and NULL ordering
					const transformedKeys = keys.map((key, index) =>
						transformSortKey(key, plan.sortKeys[index])
					);

					// Create sort entry
					const sortEntry: SortEntry = {
						sortKey: transformedKeys,
						sequence: sequenceNumber++,
						originalRow: sourceRow
					};

					// Insert into the sort BTree
					sortBTree.insert(sortEntry);
				} finally {
					// Clean up context for this row
					ctx.context.delete(plan.source);
				}
			}

			// Phase 2: Iterate the BTree in sorted order
			// The BTree will yield entries in ascending order by our composite sort key
			for (const path of sortBTree.ascending(sortBTree.first())) {
				const entry = sortBTree.at(path)!;
				yield entry.originalRow;
			}

		} finally {
			// BTree will be garbage collected automatically
		}
	}

	return {
		params: [sourceInstruction, ...keyFunctions],
		run: run as any,
		note: `btree_sort(${plan.sortKeys.length} keys)`
	};
}

/**
 * Creates a BTree optimized for sorting with compound key comparison.
 * The key is extracted from the SortEntry and includes transformed sort values + sequence.
 */
function createSortBTree(sortKeys: readonly SortKey[]): BTree<SqlValue[], SortEntry> {
	// Key extraction function - extracts the composite sort key from a SortEntry
	const keyFromEntry = (entry: SortEntry): SqlValue[] => {
		// Composite key: [sortKey0, sortKey1, ..., sortKeyN, sequence]
		return [...entry.sortKey, entry.sequence];
	};

	// Comparison function for composite sort keys
	const compareKeys = (a: SqlValue[], b: SqlValue[]): number => {
		const minLength = Math.min(a.length, b.length);

		for (let i = 0; i < minLength; i++) {
			// All comparisons use BINARY collation since we've already transformed the keys
			const comparison = compareSqlValues(a[i], b[i], 'BINARY');
			if (comparison !== 0) {
				return comparison;
			}
		}

		// If all compared elements are equal, longer array comes after shorter
		return a.length - b.length;
	};

	return new BTree<SqlValue[], SortEntry>(keyFromEntry, compareKeys);
}

function transformSortKey(key: SqlValue, sortKey: SortKey): SqlValue {
	// Handle NULL values first according to NULLS FIRST/LAST directive
	if (key === null) {
		const nullsFirst = sortKey.nulls !== 'last'; // Default is NULLS FIRST
		if (sortKey.direction === 'desc') {
			// For DESC: NULLS FIRST means nulls sort as largest values, NULLS LAST means smallest
			return nullsFirst ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER;
		} else {
			// For ASC: NULLS FIRST means nulls sort as smallest values, NULLS LAST means largest
			return nullsFirst ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
		}
	}

	// For DESC direction, we need to invert the sort order
	if (sortKey.direction === 'desc') {
		if (typeof key === 'number') {
			// For numbers, negate them
			return -key;
		} else if (typeof key === 'bigint') {
			// For bigints, negate them
			return -key;
		} else if (typeof key === 'string') {
			// For strings, we'll use a more sophisticated approach
			// Create a lexicographically inverted string
			return invertString(key);
		} else if (typeof key === 'boolean') {
			// For booleans, invert them
			return !key;
		} else if (key instanceof Uint8Array) {
			// For binary data, create inverted bytes
			return invertBytes(key);
		}
	}

	// For ASC direction or unsupported types, return as-is
	return key;
}

/**
 * Creates a lexicographically inverted string for DESC sorting.
 * This transforms each character to its complement within the Unicode range.
 */
function invertString(str: string): string {
	let inverted = '';
	for (let i = 0; i < str.length; i++) {
		const charCode = str.charCodeAt(i);
		// Invert within the Unicode Basic Multilingual Plane (0x0000 to 0xFFFF)
		const invertedCode = 0xFFFF - charCode;
		inverted += String.fromCharCode(invertedCode);
	}
	return inverted;
}

/**
 * Creates inverted bytes for DESC sorting of binary data.
 */
function invertBytes(bytes: Uint8Array): Uint8Array {
	const inverted = new Uint8Array(bytes.length);
	for (let i = 0; i < bytes.length; i++) {
		inverted[i] = 255 - bytes[i];
	}
	return inverted;
}
