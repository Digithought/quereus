/**
 * Schema-change staleness tracking for materialized views.
 *
 * Phase 1 materialized views are manual full-refresh: source mutations do NOT
 * update an MV until `REFRESH MATERIALIZED VIEW`. But a *schema* change to a
 * source table (drop / alter) can break the MV body entirely. This manager
 * subscribes to schema-change events and marks any MV whose body reads a
 * modified/removed source as `stale`. The next reference re-validates the body
 * (and errors with the staleness diagnostic on an incompatible change); the
 * next successful refresh clears the flag.
 *
 * Mirrors {@link import('./database-assertions.js').AssertionEvaluator}'s
 * schema-subscription lifecycle.
 */

import type { SchemaManager } from '../schema/manager.js';
import type { SchemaChangeEvent } from '../schema/change-events.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('core:materialized-views');

export class MaterializedViewManager {
	private unsubscribeSchemaChanges: (() => void) | null = null;

	constructor(private readonly schemaManager: SchemaManager) {
		this.subscribeToSchemaChanges();
	}

	private subscribeToSchemaChanges(): void {
		const notifier = this.schemaManager.getChangeNotifier();
		this.unsubscribeSchemaChanges = notifier.addListener((event: SchemaChangeEvent) => {
			if (event.type !== 'table_removed' && event.type !== 'table_modified') return;
			const changed = `${event.schemaName}.${event.objectName}`.toLowerCase();
			for (const mv of this.schemaManager.getAllMaterializedViews()) {
				if (mv.stale) continue;
				if (mv.sourceTables.includes(changed)) {
					mv.stale = true;
					log('Marked materialized view %s.%s stale due to %s on %s', mv.schemaName, mv.name, event.type, changed);
				}
			}
		});
	}

	dispose(): void {
		if (this.unsubscribeSchemaChanges) {
			this.unsubscribeSchemaChanges();
			this.unsubscribeSchemaChanges = null;
		}
	}
}
