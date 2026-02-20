import type { RuntimeContext } from './types.js';
import type { RowDescriptor, RowGetter } from '../planner/nodes/plan-node.js';
import type { SqlValue, Row } from '../common/types.js';
import { QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { createLogger } from '../common/logger.js';

const ctxLog = createLogger('runtime:context');
const ctxLookupLog = createLogger('runtime:context:lookup');

/**
 * A mutable slot for efficient row context management in streaming operations.
 * Avoids per-row Map mutations while maintaining context safety.
 */
export interface RowSlot {
	/** Replace the current row (cheap field write) */
	set(row: Row): void;
	/** Tear down (removes descriptor from context) */
	close(): void;
}

/**
 * Create a row slot for efficient streaming context management.
 * The slot installs a context entry once and updates it by reference.
 * Perfect for scan/join/window operations that process many rows.
 */
export function createRowSlot(
	rctx: RuntimeContext,
	descriptor: RowDescriptor
): RowSlot {
	// Internal boxed reference - one allocation per slot
	const ref = { current: undefined as Row | undefined };

	// Install only once
	rctx.context.set(descriptor, () => ref.current!);
	if (ctxLog.enabled && rctx.contextTracker) {
		rctx.contextTracker.addContext(descriptor, 'createRowSlot');
	}

	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('CREATE slot with attrs=[%s]', attrs.join(','));

	return {
		set(row: Row) {
			ref.current = row;
		},
		close() {
			rctx.context.delete(descriptor);
			if (ctxLog.enabled && rctx.contextTracker) {
				rctx.contextTracker.removeContext(descriptor);
			}
			ctxLog('CLOSE slot with attrs=[%s]', attrs.join(','));
		}
	};
}

/**
 * Resolve an attribute ID to its column value in the current context.
 * Searches from newest (innermost) to oldest (outermost) scope.
 */
export function resolveAttribute(rctx: RuntimeContext, attributeId: number, columnName?: string): SqlValue {
	// Iterate newest → oldest so the most recently pushed scope wins
	const contextsReversed = Array.from(rctx.context.entries()).reverse();

	ctxLookupLog('LOOKUP column %s (attr#%d) in %d contexts', columnName || '?', attributeId, contextsReversed.length);

	for (const [descriptor, rowGetter] of contextsReversed) {
		const columnIndex = descriptor[attributeId];
		if (columnIndex !== undefined) {
			const row = rowGetter();
			if (Array.isArray(row) && columnIndex < row.length) {
				ctxLookupLog('FOUND column %s at index %d in row', columnName || '?', columnIndex);
				return row[columnIndex];
			}
		}
	}

	// Log available attributes for debugging
	if (ctxLookupLog.enabled) {
		ctxLookupLog('Available contexts:');
		for (const [descriptor, _] of contextsReversed) {
			const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
			ctxLookupLog('  - Descriptor with attrs=[%s]', attrs.join(','));
		}

		// Log current plan execution stack if available
		if (rctx.planStack && rctx.planStack.length > 0) {
			const currentNode = rctx.planStack[rctx.planStack.length - 1];
			ctxLookupLog('LOOKUP FAILED in node %s id=%d', currentNode.nodeType, currentNode.id);
			ctxLookupLog('Execution stack: %s',
				rctx.planStack.map(n => `${n.nodeType}#${n.id}`).join(' → '));
		}
	}

	throw new QuereusError(
		`No row context found for column ${columnName || `attr#${attributeId}`}. The column reference must be evaluated within the context of its source relation.`,
		StatusCode.ERROR
	);
}

/**
 * Look up a specific column by descriptor and index.
 * Useful when you already know which descriptor contains the column.
 */
export function lookupColumn(rctx: RuntimeContext, descriptor: RowDescriptor, columnIndex: number): SqlValue | undefined {
	const rowGetter = rctx.context.get(descriptor);
	if (!rowGetter) {
		ctxLookupLog('LOOKUP by index %d - no context found', columnIndex);
		return undefined;
	}

	const row = rowGetter();
	if (Array.isArray(row) && columnIndex < row.length) {
		ctxLookupLog('LOOKUP by index %d - found value', columnIndex);
		return row[columnIndex];
	}
	ctxLookupLog('LOOKUP by index %d - index out of bounds', columnIndex);
	return undefined;
}

/**
 * Execute an async function with a temporary row context (Map.set + Map.delete).
 *
 * Useful for **one-off** evaluations such as constraint checks and DML context
 * setup where a full {@link createRowSlot} lifecycle is unnecessary.
 */
export async function withAsyncRowContext<T>(
	rctx: RuntimeContext,
	descriptor: RowDescriptor,
	rowGetter: RowGetter,
	fn: () => T | Promise<T>
): Promise<T> {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('PUSH async context with attrs=[%s]', attrs.join(','));

	rctx.context.set(descriptor, rowGetter);
	if (ctxLog.enabled && rctx.contextTracker) {
		rctx.contextTracker.addContext(descriptor, 'withAsyncRowContext');
	}
	try {
		return await fn();
	} finally {
		rctx.context.delete(descriptor);
		if (ctxLog.enabled && rctx.contextTracker) {
			rctx.contextTracker.removeContext(descriptor);
		}
		ctxLog('POP async context with attrs=[%s]', attrs.join(','));
	}
}

/**
 * Execute a synchronous function with a temporary row context (Map.set + Map.delete).
 *
 * Useful for **one-off** evaluations where a full {@link createRowSlot}
 * lifecycle is unnecessary.
 */
export function withRowContext<T>(
	rctx: RuntimeContext,
	descriptor: RowDescriptor,
	rowGetter: RowGetter,
	fn: () => T
): T {
	const attrs = Object.keys(descriptor).filter(k => descriptor[parseInt(k)] !== undefined);
	ctxLog('PUSH context with attrs=[%s]', attrs.join(','));

	rctx.context.set(descriptor, rowGetter);
	if (ctxLog.enabled && rctx.contextTracker) {
		rctx.contextTracker.addContext(descriptor, 'withRowContext');
	}
	try {
		return fn();
	} finally {
		rctx.context.delete(descriptor);
		if (ctxLog.enabled && rctx.contextTracker) {
			rctx.contextTracker.removeContext(descriptor);
		}
		ctxLog('POP context with attrs=[%s]', attrs.join(','));
	}
}


