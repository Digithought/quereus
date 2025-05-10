import type { Handler } from './handler-types.js';
import { Opcode } from './opcodes.js';
import { SqliterError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import * as Core from './instructions/core.js';
import * as Compare from './instructions/compare.js';
import * as Arith from './instructions/arith.js';
import * as Bitwise from './instructions/bitwise.js';
import * as Subroutine from './instructions/subroutine.js';
import * as Cursor from './instructions/cursor.js';
import * as Types from './instructions/types.js';
import * as Func from './instructions/function.js';
import * as Aggregate from './instructions/aggregate.js';
import * as Ephemeral from './instructions/ephemeral.js';
import * as Sort from './instructions/sort.js';
import * as VTab from './instructions/vtab.js';
import * as Schema from './instructions/schema.js';
import * as Seek from './instructions/seek.js';

/**
 * Table of handlers for each opcode.
 * Provides fast lookup for execution and avoids large switch statements.
 */
export const handlers: Handler[] = new Array(256);

// Initialize with fallback handler that throws for unsupported opcodes
for (let i = 0; i < handlers.length; i++) {
	handlers[i] = (ctx, inst) => {
		throw new SqliterError(`Unsupported opcode: ${Opcode[inst.opcode] || inst.opcode}`, StatusCode.INTERNAL);
	};
}

// Register handlers from each module
Core.registerHandlers(handlers);
Compare.registerHandlers(handlers);
Arith.registerHandlers(handlers);
Bitwise.registerHandlers(handlers);
Subroutine.registerHandlers(handlers);
Cursor.registerHandlers(handlers);
Types.registerHandlers(handlers);
Func.registerHandlers(handlers);
Aggregate.registerHandlers(handlers);
Ephemeral.registerHandlers(handlers);
Sort.registerHandlers(handlers);
VTab.registerHandlers(handlers);
Schema.registerHandlers(handlers);
Seek.registerHandlers(handlers);

