/**
 * Built-in conflict resolver strategies.
 */

import { compareHLC } from '../clock/hlc.js';
import type { ConflictResolver } from './protocol.js';

/** Higher HLC wins; site ID breaks ties (same as the default LWW fast-path). */
export const lwwResolver: ConflictResolver = (ctx) =>
	compareHLC(ctx.remoteHlc, ctx.localHlc) > 0 ? 'remote' : 'local';

/** Local value always wins (target-wins). */
export const localWinsResolver: ConflictResolver = () => 'local';

/** Remote value always wins (source-wins). */
export const remoteWinsResolver: ConflictResolver = () => 'remote';
