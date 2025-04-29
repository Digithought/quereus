import type { SqlValue } from '../../common/types.js';

/** Key type used in B-Trees (primary key or index key part) */
export type BTreeKey = SqlValue | SqlValue[];

/** Represents a row stored in the MemoryTable */
export type MemoryTableRow = Record<string, SqlValue> & {
	/** Internal row identifier */
	readonly _rowid_: bigint;
};

// --- Re-export types needed by other modules ---
// These might be defined elsewhere but are central to the memory table structure

/** Represents a unique symbol for marking deletions in layers */
export declare const DELETED: unique symbol;

/** Key used in modification trees (Primary Key or [Secondary Index Key, rowid]) */
export type ModificationKey = BTreeKey | [BTreeKey, bigint];

/** Represents a deleted entry in a modification tree */
export interface DeletionMarker {
	_marker_: typeof DELETED;
	_key_: ModificationKey; // The key of the deleted item
	_rowid_?: bigint;       // The rowid of the deleted item (often redundant for secondary key mods)
}

/** Value stored in modification trees (either a full row or a deletion marker) */
export type ModificationValue = MemoryTableRow | DeletionMarker;

/** Type guard to check if a value is a DeletionMarker */
export function isDeletionMarker(value: any): value is DeletionMarker {
	return typeof value === 'object' && value !== null && '_marker_' in value && value._marker_ === DELETED;
}


// --- Configuration types (Keep as is) ---

/**
 * Interface for index specification used in MemoryTable creation and index operations.
 * This is public-facing and different from the internal IndexSchema used by the schema system.
 */
export interface IndexSpec {
	name?: string;
	columns: ReadonlyArray<{ index: number; desc: boolean; collation?: string }>;
	unique?: boolean;
}

/**
 * Configuration options for MemoryTable creation
 */
export interface MemoryTableConfig {
	columns: ReadonlyArray<{
		name: string;
		type: string;
		collation?: string;
	}>;
	primaryKey?: ReadonlyArray<{ index: number; desc: boolean }>;
	indexes?: ReadonlyArray<IndexSpec>;
	checkConstraints?: ReadonlyArray<{
		expr: string;
		trigger: 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL';
	}>;
	readOnly?: boolean;
}
