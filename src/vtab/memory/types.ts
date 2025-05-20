import type { RowIdRow, SqlValue } from '../../common/types.js';

/** Key type used in B-Trees (primary key or index key part) */
export type BTreeKey = SqlValue | SqlValue[];

/** Key used in modification trees (Primary Key or [Secondary Index Key, rowid]) */
export type ModificationKey = BTreeKey | [BTreeKey, bigint];

/** Represents a deleted entry in a modification tree */
export interface DeletionMarker {
	_marker_: typeof DELETED;
	_key_: ModificationKey; // The key of the deleted item
	_rowid_: bigint;       // The rowid of the deleted item (now non-optional)
}

/**
 * A unique symbol used within TransactionLayer modification trees
 * to explicitly mark a key (and thus the corresponding row) as deleted
 * within that specific layer.
 */
export const DELETED = Symbol('_DELETED_');

/** Type guard to check if a value is a DeletionMarker */
export function isDeletionMarker(value: any): value is DeletionMarker {
	return typeof value === 'object' && value !== null && '_marker_' in value && value._marker_ === DELETED;
}

/** Value stored in modification trees (either a full row tuple or a deletion marker) */
export type ModificationValue = RowIdRow | DeletionMarker;

/**
 * Configuration options for MemoryTable creation
 */
export interface MemoryTableConfig {
	readOnly?: boolean;
}
