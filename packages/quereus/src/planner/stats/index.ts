/**
 * Statistics provider abstraction for the Quereus optimizer
 * Provides cardinality estimates and selectivity information for cost-based optimization
 */

import type { ScalarPlanNode } from '../nodes/plan-node.js';
import type { TableSchema } from '../../schema/table.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('optimizer:stats');

/**
 * Statistics provider interface for optimizer
 */
export interface StatsProvider {
	/**
	 * Get estimated row count for a base table
	 * @param table Table schema
	 * @returns Estimated row count, or undefined if unknown
	 */
	tableRows(table: TableSchema): number | undefined;

	/**
	 * Get selectivity estimate for a predicate on a table
	 * @param table Table schema
	 * @param predicate Predicate expression
	 * @returns Selectivity factor (0.0 to 1.0), or undefined if unknown
	 */
	selectivity(table: TableSchema, predicate: ScalarPlanNode): number | undefined;

	/**
	 * Get join selectivity estimate
	 * @param leftTable Left table schema
	 * @param rightTable Right table schema
	 * @param joinCondition Join condition
	 * @returns Join selectivity factor, or undefined if unknown
	 */
	joinSelectivity?(leftTable: TableSchema, rightTable: TableSchema, joinCondition: ScalarPlanNode): number | undefined;

	/**
	 * Get number of distinct values for a column
	 * @param table Table schema
	 * @param columnName Column name
	 * @returns Estimated distinct values, or undefined if unknown
	 */
	distinctValues?(table: TableSchema, columnName: string): number | undefined;

	/**
	 * Get index selectivity information
	 * @param table Table schema
	 * @param indexName Index name (if applicable)
	 * @param predicate Predicate expression
	 * @returns Index selectivity factor, or undefined if unknown
	 */
	indexSelectivity?(table: TableSchema, indexName: string, predicate: ScalarPlanNode): number | undefined;
}

/**
 * Naive statistics provider using simple heuristics
 * Used as fallback when no better statistics are available
 */
export class NaiveStatsProvider implements StatsProvider {
	constructor(
		private readonly defaultTableRows: number = 1000,
		private readonly defaultSelectivity: number = 0.3
	) {
		log('Created naive stats provider (defaultRows: %d, defaultSelectivity: %f)',
			defaultTableRows, defaultSelectivity);
	}

	tableRows(table: TableSchema): number | undefined {
		// Use table's estimated rows if available, otherwise use default
		const estimate = table.estimatedRows ?? this.defaultTableRows;
		log('Table %s estimated rows: %d (source: %s)',
			table.name, estimate, table.estimatedRows ? 'schema' : 'default');
		return estimate;
	}

	selectivity(table: TableSchema, predicate: ScalarPlanNode): number | undefined {
		// Simple heuristics based on predicate type
		const selectivity = this.estimatePredicateSelectivity(predicate);
		log('Predicate selectivity for %s: %f', predicate.nodeType, selectivity);
		return selectivity;
	}

	joinSelectivity(leftTable: TableSchema, rightTable: TableSchema, _joinCondition: ScalarPlanNode): number | undefined {
		// Default join selectivity based on table sizes
		const leftRows = this.tableRows(leftTable) ?? this.defaultTableRows;
		const rightRows = this.tableRows(rightTable) ?? this.defaultTableRows;

		// Simple heuristic: smaller table determines selectivity
		const selectivity = 1.0 / Math.max(leftRows, rightRows, 10);
		log('Join selectivity between %s and %s: %f', leftTable.name, rightTable.name, selectivity);
		return Math.min(0.5, selectivity);
	}

	distinctValues(table: TableSchema, columnName: string): number | undefined {
		const totalRows = this.tableRows(table);
		if (!totalRows) return undefined;

		// Heuristic: assume moderate cardinality (50% distinct values)
		const distinct = Math.max(1, Math.floor(totalRows * 0.5));
		log('Distinct values for %s.%s: %d', table.name, columnName, distinct);
		return distinct;
	}

	indexSelectivity(table: TableSchema, indexName: string, predicate: ScalarPlanNode): number | undefined {
		// Index selectivity is generally better than table scan
		const baseSelecivity = this.selectivity(table, predicate) ?? this.defaultSelectivity;
		const indexSelectivity = baseSelecivity * 0.8; // 20% improvement with index
		log('Index %s selectivity: %f (base: %f)', indexName, indexSelectivity, baseSelecivity);
		return indexSelectivity;
	}

	private estimatePredicateSelectivity(predicate: ScalarPlanNode): number {
		// Simple heuristics based on node type
		switch (predicate.nodeType) {
			case 'BinaryOp':
				// More selective for equality, less for ranges
				return 0.1; // Equality-like operations
			case 'In':
				return 0.2; // IN clauses
			case 'Between':
				return 0.25; // Range queries
			case 'Like':
				return 0.3; // Pattern matching
			case 'IsNull':
			case 'IsNotNull':
				return 0.1; // NULL checks are usually selective
			default:
				return this.defaultSelectivity;
		}
	}
}

/**
 * Statistics provider that delegates to virtual table modules
 * Allows VTab modules to provide their own statistics
 */
export class VTabStatsProvider implements StatsProvider {
	constructor(
		private readonly fallback: StatsProvider = new NaiveStatsProvider()
	) {
		log('Created VTab stats provider with fallback');
	}

	tableRows(table: TableSchema): number | undefined {
		// Try to get stats from VTab module if it supports it
		if (table.vtabModule && typeof table.vtabModule === 'object' && 'getTableStats' in table.vtabModule) {
			try {
				const stats = (table.vtabModule as any).getTableStats?.(table);
				if (stats?.rowCount !== undefined) {
					log('Got row count from VTab module for %s: %d', table.name, stats.rowCount);
					return stats.rowCount;
				}
			} catch (error) {
				log('Error getting VTab stats for %s: %s', table.name, error);
			}
		}

		// Fall back to default provider
		return this.fallback.tableRows(table);
	}

	selectivity(table: TableSchema, predicate: ScalarPlanNode): number | undefined {
		// Try VTab module selectivity
		if (table.vtabModule && typeof table.vtabModule === 'object' && 'getSelectivity' in table.vtabModule) {
			try {
				const selectivity = (table.vtabModule as any).getSelectivity?.(table, predicate);
				if (selectivity !== undefined) {
					log('Got selectivity from VTab module for %s: %f', table.name, selectivity);
					return selectivity;
				}
			} catch (error) {
				log('Error getting VTab selectivity for %s: %s', table.name, error);
			}
		}

		// Fall back to default provider
		return this.fallback.selectivity(table, predicate);
	}

	joinSelectivity(leftTable: TableSchema, rightTable: TableSchema, joinCondition: ScalarPlanNode): number | undefined {
		return this.fallback.joinSelectivity?.(leftTable, rightTable, joinCondition);
	}

	distinctValues(table: TableSchema, columnName: string): number | undefined {
		return this.fallback.distinctValues?.(table, columnName);
	}

	indexSelectivity(table: TableSchema, indexName: string, predicate: ScalarPlanNode): number | undefined {
		return this.fallback.indexSelectivity?.(table, indexName, predicate);
	}
}

/**
 * Default statistics provider instance
 */
export const defaultStatsProvider = new NaiveStatsProvider();

/**
 * VTab-aware statistics provider instance
 */
export const vtabStatsProvider = new VTabStatsProvider();

/**
 * Create a custom statistics provider
 */
export function createStatsProvider(
	tableRowsMap?: Map<string, number>,
	selectivityMap?: Map<string, number>
): StatsProvider {
	return new class implements StatsProvider {
		tableRows(table: TableSchema): number | undefined {
			return tableRowsMap?.get(table.name) ?? defaultStatsProvider.tableRows(table);
		}

		selectivity(table: TableSchema, predicate: ScalarPlanNode): number | undefined {
			const key = `${table.name}:${predicate.nodeType}`;
			return selectivityMap?.get(key) ?? defaultStatsProvider.selectivity(table, predicate);
		}
	};
}
