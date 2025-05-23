import type { SqlValue } from '../../common/types.js';
import type { Row } from '../../common/types.js';

/** Key type used in B-Trees (primary key or index key part) */
export type BTreeKey = SqlValue | SqlValue[];

/** Alias for BTreeKey when explicitly referring to a primary key. */
export type BTreeKeyForPrimary = BTreeKey;

/** Alias for BTreeKey when explicitly referring to a key of a secondary index. */
export type BTreeKeyForIndex = BTreeKey;

/** Represents an entry in a MemoryIndex BTree, mapping an IndexKey to an array of PrimaryKeys */
export interface MemoryIndexEntry {
	indexKey: BTreeKeyForIndex;
	primaryKeys: BTreeKeyForPrimary[];
}

/** Represents a deleted entry in a modification tree, keyed by its primary key. */
export interface DeletionMarker {
	_marker_: typeof DELETED;
	_key_: BTreeKeyForPrimary; // The primary key of the deleted item
}

/**
 * A unique symbol used within TransactionLayer modification trees
 * to explicitly mark a primary key as deleted within that specific layer.
 */
export const DELETED = Symbol('_DELETED_');

/** Type guard to check if a value is a DeletionMarker */
export function isDeletionMarker(value: any): value is DeletionMarker {
	return typeof value === 'object' && value !== null && '_marker_' in value && value._marker_ === DELETED;
}

/** Value stored in primary modification trees (either a full row or a deletion marker for that PK) */
export type PrimaryModificationValue = Row | DeletionMarker;

/**
 * Configuration options for MemoryTable creation
 */
export interface MemoryTableConfig {
	readOnly?: boolean;
}
