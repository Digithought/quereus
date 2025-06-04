import type { TableSchema, PrimaryKeyColumnDefinition } from '../../../schema/table.js';
import type { Row, SqlValue } from '../../../common/types.js';
import type { BTreeKeyForPrimary } from '../types.js';
import { compareSqlValues } from '../../../util/comparison.js';
import { QuereusError } from '../../../common/errors.js';
import { StatusCode } from '../../../common/types.js';

/**
 * Result of creating primary key functions for a given schema
 */
export interface PrimaryKeyFunctions {
	extractFromRow: (row: Row) => BTreeKeyForPrimary;
	compare: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary) => number;
}

/**
 * Creates optimized primary key extraction and comparison functions for a given table schema.
 * This centralizes the logic that was previously duplicated across BaseLayer and TransactionLayer.
 */
export function createPrimaryKeyFunctions(schema: TableSchema): PrimaryKeyFunctions {
	const pkDefinition = schema.primaryKeyDefinition
		// Use all columns if no primary key is defined (that's different from an empty primary key)
		// This is an important design change and documented deviation from SQLite behavior, and not something we want to change
		?? schema.columns.map((col, index) => ({ index, collation: col.collation || 'BINARY' }));

	if (pkDefinition.length === 0) {
		return createSingletonPrimaryKeyFunctions();
	} else if (pkDefinition.length === 1) {
		return createSingleColumnPrimaryKeyFunctions(pkDefinition[0]);
	} else {
		return createCompositeColumnPrimaryKeyFunctions(pkDefinition);
	}
}

/**
 * Creates functions for tables with empty primary keys (zero or one rows possible)
 */
function createSingletonPrimaryKeyFunctions(): PrimaryKeyFunctions {
	return {
		extractFromRow: (row: Row): BTreeKeyForPrimary => {
			return [];
		},
		compare: (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary): number => {
			return 0;	// Always equal
		}
	};
}

/**
 * Creates functions for single-column primary keys (optimized path)
 */
function createSingleColumnPrimaryKeyFunctions(
	columnDef: PrimaryKeyColumnDefinition
): PrimaryKeyFunctions {
	const pkColIndex = columnDef.index;
	const collation = columnDef.collation || 'BINARY';
	const descMultiplier = columnDef.desc ? -1 : 1;

	const extractFromRow = (row: Row): BTreeKeyForPrimary => {
		if (!row || !Array.isArray(row)) {
			throw new QuereusError(
				`Primary key extraction requires a valid row array, got: ${typeof row}`,
				StatusCode.INTERNAL
			);
		}
		if (pkColIndex < 0 || pkColIndex >= row.length) {
			throw new QuereusError(
				`PK index ${pkColIndex} is out of bounds for row length ${row.length}`,
				StatusCode.INTERNAL
			);
		}
		return row[pkColIndex];
	};

	const compare = (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary): number => {
		return compareSqlValues(a as SqlValue, b as SqlValue, collation) * descMultiplier;
	};

	return { extractFromRow, compare };
}

/**
 * Creates functions for composite (multi-column) primary keys
 */
function createCompositeColumnPrimaryKeyFunctions(
	pkDefinition: ReadonlyArray<PrimaryKeyColumnDefinition>
): PrimaryKeyFunctions {
	const extractFromRow = (row: Row): BTreeKeyForPrimary => {
		if (!row || !Array.isArray(row)) {
			throw new QuereusError(
				`Primary key extraction requires a valid row array, got: ${typeof row}`,
				StatusCode.INTERNAL
			);
		}
		return pkDefinition.map(def => {
			if (def.index < 0 || def.index >= row.length) {
				throw new QuereusError(
					`PK index ${def.index} is out of bounds for row length ${row.length}`,
					StatusCode.INTERNAL
				);
			}
			return row[def.index];
		});
	};

	const compare = (a: BTreeKeyForPrimary, b: BTreeKeyForPrimary): number => {
		const arrA = a as SqlValue[];
		const arrB = b as SqlValue[];

		for (let i = 0; i < pkDefinition.length; i++) {
			if (i >= arrA.length || i >= arrB.length) {
				return arrA.length - arrB.length;
			}

			const def = pkDefinition[i];
			const comparison = compareSqlValues(arrA[i], arrB[i], def.collation || 'BINARY');

			if (comparison !== 0) {
				return def.desc ? -comparison : comparison;
			}
		}

		return 0;
	};

	return { extractFromRow, compare };
}

/**
 * Builds a primary key from key values and a primary key definition.
 * Used for constructing keys from old key values in UPDATE/DELETE operations.
 */
export function buildPrimaryKeyFromValues(
	keyValues: Row,
	pkDefinition: ReadonlyArray<PrimaryKeyColumnDefinition>
): BTreeKeyForPrimary {
	if (pkDefinition.length === 0) {
		throw new QuereusError("Cannot build primary key: no primary key definition.", StatusCode.INTERNAL);
	}

	if (keyValues.length !== pkDefinition.length) {
		throw new QuereusError(
			`Key value count mismatch. Expected ${pkDefinition.length}, got ${keyValues.length}.`,
			StatusCode.INTERNAL
		);
	}

	return pkDefinition.length === 1 ? keyValues[0] : keyValues;
}
