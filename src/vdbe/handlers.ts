import type { Handler } from './handler-types';
import { Opcode } from './opcodes';
import { SqliteError } from '../common/errors';
import { StatusCode } from '../common/types';
import * as Core from './instructions/core';
import * as Compare from './instructions/compare';
import * as Arith from './instructions/arith';
import * as Bitwise from './instructions/bitwise';
import * as Subroutine from './instructions/subroutine';
import * as Cursor from './instructions/cursor';
import * as Types from './instructions/types';
import * as Func from './instructions/function';
import * as Aggregate from './instructions/aggregate';
import * as Ephemeral from './instructions/ephemeral';
import * as Sort from './instructions/sort';
import * as VTab from './instructions/vtab';
import * as Schema from './instructions/schema';
import * as Seek from './instructions/seek';

/**
 * Table of handlers for each opcode
 * This provides a fast lookup for execution and avoids the large switch statement
 */
export const handlers: Handler[] = new Array(256);

// Initialize with fallback handler that throws
for (let i = 0; i < handlers.length; i++) {
	handlers[i] = (ctx, inst) => {
		throw new SqliteError(`Unsupported opcode: ${Opcode[inst.opcode] || inst.opcode}`, StatusCode.INTERNAL);
	};
}

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

