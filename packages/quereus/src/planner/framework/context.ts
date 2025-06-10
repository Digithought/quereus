/**
 * Optimizer context that wraps Optimizer with StatsProvider and other utilities
 * Provides unified interface for optimization rules
 */

import type { Optimizer } from '../optimizer.js';
import type { StatsProvider } from '../stats/index.js';
import type { OptimizerTuning } from '../optimizer-tuning.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('optimizer:framework:context');

/**
 * Context object passed to optimization rules
 * Contains all the utilities and data sources rules need
 */
export interface OptContext {
	/** The optimizer instance */
	readonly optimizer: Optimizer;

	/** Statistics provider for cardinality and selectivity estimates */
	readonly stats: StatsProvider;

	/** Optimizer tuning parameters */
	readonly tuning: OptimizerTuning;

	/** Current optimization phase */
	readonly phase: 'rewrite' | 'impl';

	/** Rule application depth (for detecting infinite recursion) */
	readonly depth: number;

	/** Additional context data that rules can use */
	readonly context: Map<string, any>;
}

/**
 * Implementation of optimization context
 */
export class OptimizationContext implements OptContext {
	readonly context = new Map<string, any>();

	constructor(
		public readonly optimizer: Optimizer,
		public readonly stats: StatsProvider,
		public readonly tuning: OptimizerTuning,
		public readonly phase: 'rewrite' | 'impl' = 'rewrite',
		public readonly depth: number = 0
	) {
		log('Created optimization context (phase: %s, depth: %d)', phase, depth);
	}

	/**
	 * Create a new context for a different phase
	 */
	withPhase(phase: 'rewrite' | 'impl'): OptimizationContext {
		return new OptimizationContext(
			this.optimizer,
			this.stats,
			this.tuning,
			phase,
			this.depth
		);
	}

	/**
	 * Create a new context with incremented depth
	 */
	withIncrementedDepth(): OptimizationContext {
		if (this.depth >= this.tuning.maxOptimizationDepth) {
			throw new Error(`Maximum optimization depth exceeded: ${this.depth}`);
		}

		return new OptimizationContext(
			this.optimizer,
			this.stats,
			this.tuning,
			this.phase,
			this.depth + 1
		);
	}

	/**
	 * Create a new context with additional context data
	 */
	withContext(key: string, value: any): OptimizationContext {
		const newContext = new OptimizationContext(
			this.optimizer,
			this.stats,
			this.tuning,
			this.phase,
			this.depth
		);

		// Copy existing context
		for (const [k, v] of this.context) {
			newContext.context.set(k, v);
		}

		// Add new context
		newContext.context.set(key, value);

		return newContext;
	}

	/**
	 * Get context value
	 */
	getContext<T>(key: string): T | undefined {
		return this.context.get(key) as T | undefined;
	}

	/**
	 * Check if context has a key
	 */
	hasContext(key: string): boolean {
		return this.context.has(key);
	}

	/**
	 * Set context value (mutates current context)
	 */
	setContext(key: string, value: any): void {
		this.context.set(key, value);
	}

	/**
	 * Remove context value (mutates current context)
	 */
	deleteContext(key: string): boolean {
		return this.context.delete(key);
	}

	/**
	 * Clear all context data (mutates current context)
	 */
	clearContext(): void {
		this.context.clear();
	}

	/**
	 * Get a snapshot of all context data
	 */
	getContextSnapshot(): Record<string, any> {
		const snapshot: Record<string, any> = {};
		for (const [key, value] of this.context) {
			snapshot[key] = value;
		}
		return snapshot;
	}
}

/**
 * Factory function to create optimization context
 */
export function createOptContext(
	optimizer: Optimizer,
	stats: StatsProvider,
	tuning: OptimizerTuning,
	phase: 'rewrite' | 'impl' = 'rewrite'
): OptContext {
	return new OptimizationContext(optimizer, stats, tuning, phase);
}

/**
 * Type guard to check if an object is an OptContext
 */
export function isOptContext(obj: any): obj is OptContext {
	return obj &&
		typeof obj === 'object' &&
		'optimizer' in obj &&
		'stats' in obj &&
		'tuning' in obj &&
		'phase' in obj &&
		'depth' in obj &&
		'context' in obj;
}
