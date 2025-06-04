import type { CacheNode } from '../../planner/nodes/cache-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import type { Row } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';
import { emitCallFromPlan } from '../emitters.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('runtime:emit:cache');

/**
 * A reusable async iterable that can be iterated multiple times
 */
class CachedIterable implements AsyncIterable<Row> {
	constructor(private rows: Row[]) {}

	async *[Symbol.asyncIterator](): AsyncIterator<Row> {
		log('Serving %d rows from cache', this.rows.length);
		for (const row of this.rows) {
			yield row;
		}
	}
}

/**
 * Emits a smart cache instruction that materializes input on first iteration
 * and serves subsequent iterations from cached results.
 */
export function emitCache(plan: CacheNode, ctx: EmissionContext): Instruction {
	// Cache state persists across calls to this instruction
	let cachedResult: CachedIterable | null = null;
	let cacheAbandoned = false;

	async function run(rctx: RuntimeContext, sourceCallback: (innerCtx: RuntimeContext) => AsyncIterable<Row>): Promise<AsyncIterable<Row>> {
		// If we already have cached data, return it
		if (cachedResult) {
			return cachedResult;
		}

		// If we previously abandoned caching due to threshold, just stream
		if (cacheAbandoned) {
			log('Cache abandoned due to previous threshold exceed, streaming directly');
			return sourceCallback(rctx);
		}

		// First time - pipeline results while building cache
		return {
			async *[Symbol.asyncIterator]() {
				log('Building cache with threshold %d while pipelining', plan.threshold);
				const cache: Row[] = [];
				let rowCount = 0;
				let thresholdExceeded = false;

				// Get source iterator and pipeline while caching
				const sourceIterable = sourceCallback(rctx);
				for await (const row of sourceIterable) {
					// Always yield the row immediately (pipelining)
					yield row;

					// Try to cache if we haven't exceeded threshold
					if (!thresholdExceeded) {
						if (rowCount < plan.threshold) {
							// Cache the row (deep copy to avoid reference issues)
							cache.push([...row] as Row);
							rowCount++;
						} else {
							// Hit threshold - dump cache and abandon caching
							log('Cache threshold %d exceeded at row %d, dumping cache and continuing to pipeline',
								plan.threshold, rowCount);
							cache.length = 0; // Clear the cache
							thresholdExceeded = true;
							cacheAbandoned = true;
						}
					}
				}

				// If we finished without exceeding threshold, cache is ready
				if (!thresholdExceeded) {
					log('Cache built successfully with %d rows', cache.length);
					cachedResult = new CachedIterable(cache);
				}
			}
		};
	}

	const sourceInstruction = emitCallFromPlan(plan.source, ctx);

	return {
		params: [sourceInstruction],
		run,
		note: `cache(${plan.strategy}, threshold=${plan.threshold})`
	};
}
