import type { RowIdRow } from '../../../common/types.js';
import type { ModificationKey } from './interface.js';

/**
 * Internal interface for cursors that navigate the layer chain for MemoryTable.
 * These are effectively replaced by async iterator logic in the new model,
 * but are needed temporarily to resolve linter errors in other files during refactoring.
 */
export interface LayerCursorInternal {
	next(): Promise<void>;
	getCurrentRowObject(): RowIdRow | null;
	getCurrentModificationKey(): ModificationKey | null;
	isEof(): boolean;
	close(): void;
	// plan?: ScanPlan; // Added to satisfy MemoryTableCursor usage if needed, review if it should be here
}
