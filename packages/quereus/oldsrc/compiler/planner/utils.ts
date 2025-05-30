/**
 * Generates a stable, unique ID for a relation based on the set of
 * contributing base table cursors.
 *
 * @param cursorIds Set of cursor indices.
 * @returns A unique string identifier.
 */
export function generateRelationId(cursorIds: ReadonlySet<number>): string {
	// Sort cursor IDs numerically for stability
	const sortedIds = [...cursorIds].sort((a, b) => a - b);
	return `rel({${sortedIds.join(',')}})`;
}
