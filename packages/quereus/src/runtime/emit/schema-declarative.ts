import type { EmissionContext } from '../emission-context.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { createLogger } from '../../common/logger.js';
import { PlanNodeType } from '../../planner/nodes/plan-node-type.js';
import { StatusCode, type Row } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import * as AST from '../../parser/ast.js';

const log = createLogger('runtime:emit:declare');

function simpleInstruction(note: string, fn: (rctx: RuntimeContext) => AsyncIterable<Row> | Row | void): Instruction {
  const run: InstructionRun = (rctx: RuntimeContext) => {
    const out = fn(rctx);
    if (!out) return [] as Row;
    if (typeof out === 'object' && out !== null && Symbol.asyncIterator in (out as any)) return out as AsyncIterable<Row>;
    return out as Row;
  };
  return { note, params: [], run };
}

export function emitDeclareSchema(_plan: any, _ctx: EmissionContext): Instruction {
  async function* run(_rctx: RuntimeContext): AsyncIterable<Row> {
    yield ['ok'];
  }
  return { params: [], run, note: 'declare schema' };
}

export function emitDiffSchema(_plan: any, _ctx: EmissionContext): Instruction {
  async function* run(_rctx: RuntimeContext): AsyncIterable<Row> {
    yield ['[]'];
  }
  return { params: [], run, note: 'diff schema' };
}

export function emitApplySchema(_plan: any, _ctx: EmissionContext): Instruction {
  async function* run(_rctx: RuntimeContext): AsyncIterable<Row> {
    yield ['ok'];
  }
  return { params: [], run, note: 'apply schema' };
}

export function emitExplainSchema(_plan: any, _ctx: EmissionContext): Instruction {
  async function* run(_rctx: RuntimeContext): AsyncIterable<Row> {
    yield ['hash:0'];
  }
  return { params: [], run, note: 'explain schema' };
}

