import { expect } from 'chai';
import { VdbeRuntime } from '../src/vdbe/runtime.js';
import { type VdbeInstruction, createInstruction, type P4FuncDef } from '../src/vdbe/instruction.js';
import { Opcode } from '../src/vdbe/opcodes.js';
import { Database } from '../src/core/database.js';
import { Statement } from '../src/core/statement.js';
import { StatusCode, type SqlValue } from '../src/common/types.js';
import type { VdbeProgram } from '../src/vdbe/program.js';
import type { SqliterContext } from '../src/func/context.js';
import type { FunctionSchema } from '../src/schema/function.js';
import { FunctionFlags } from '../src/common/constants.js';
import { SqliterError } from '../src/common/errors.js';

/* ------------------------------------------------------------------
   Helper utilities (consider refactoring to shared utils)
-------------------------------------------------------------------*/

function createTestProgram(db: Database, instructions: VdbeInstruction[], numCursors = 0, numMemCells = 15): VdbeProgram {
    return {
        instructions: Object.freeze([
            createInstruction(Opcode.Init, 0, 1, 0), // Start execution at PC=1
            ...instructions,
            createInstruction(Opcode.Halt, StatusCode.OK, 0, 0) // Halt at the end
        ]),
        numMemCells: numMemCells,
        numCursors: numCursors,
        constants: [],
        parameters: new Map(),
        columnNames: [],
        sql: 'AGGREGATION_TEST',
    };
}

async function runTestProgram(db: Database, program: VdbeProgram, expectedSteps = 1) {
    const stmt = new Statement(db, program.sql, program);
    const runtime = new VdbeRuntime(stmt, program);
    let steps = 0;
    let finalStatus: StatusCode = StatusCode.ERROR;

    try {
        // Adjust loop condition slightly to ensure Halt is always reached if expected
        while (steps < expectedSteps + 3) {
            const status = await runtime.run();
            if (runtime.done || runtime.error) {
                finalStatus = runtime.error?.code ?? status;
                break; // Exit loop immediately when done or error
            }
            if (status === StatusCode.ROW) {
                // For aggregation tests, ROW shouldn't occur unless testing ResultRow here
                 console.warn('Unexpected ROW status in aggregation opcode test');
                 // Decide how to handle: throw or continue? For now, continue.
            }
            steps++;
            if (steps > program.instructions.length + 10) { // Increased safety break
                throw new Error(`VDBE test exceeded expected steps (${expectedSteps}) + safety margin`);
            }
        }
        // If loop finishes without break (runtime not done/error), check final state
        if (!runtime.done && !runtime.error) {
             console.warn(`runTestProgram loop finished by steps (${steps}) but runtime not done/error. PC=${runtime.pc}`);
             // Attempt one more run to catch potential final status from Halt
             const lastStatus = await runtime.run();
             // Ensure runtime.error has code property before accessing
             finalStatus = runtime.error && typeof runtime.error === 'object' && 'code' in runtime.error
                 ? (runtime.error as SqliterError).code
                 : lastStatus;
        } else if (runtime.done && finalStatus === StatusCode.ERROR) {
            // If runtime is done but we didn't capture status via break, assume OK from Halt
            finalStatus = StatusCode.OK;
        }
    } catch (e) {
        console.error('>>> runTestProgram caught error:', e); // Add logging
        if (e instanceof Error) runtime.error = e as any;
        finalStatus = (e as any).code ?? StatusCode.ERROR;
    }
    return { runtime, finalStatus };
}

/* ------------------------------------------------------------------ */

// --- Test Aggregate Function Definition ---
interface SumContext {
    sum: number;
    count: number;
}

const testAggSum: FunctionSchema = {
    name: 'TEST_SUM',
    numArgs: 1,
    flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC,
    xStep: (ctx: SqliterContext, args: readonly SqlValue[]) => {
        let aggCtx = ctx.getAggregateContext<SumContext>();
        if (!aggCtx) {
            aggCtx = { sum: 0, count: 0 }; // Initialize
        }
        const value = args[0];
        if (typeof value === 'number') {
            aggCtx.sum += value;
            aggCtx.count += 1;
            ctx.setAggregateContext(aggCtx);
        }
    },
    xFinal: (ctx: SqliterContext) => {
        const aggCtx = ctx.getAggregateContext<SumContext>();
        if (aggCtx?.count && aggCtx.count > 0) {
            ctx.resultDouble(aggCtx.sum);
        } else {
            ctx.resultNull();
        }
    },
};
// ---------------------------------------\

describe('VDBE Aggregation Opcode Tests', () => {
    let db: Database;

    beforeEach(() => {
        db = new Database();
        db.registerFunction(testAggSum);
    });

    afterEach(async () => {
        await db.close();
    });

    // Core Aggregation (AggStep, AggFinal)

    describe('Core Aggregation Opcodes', () => {
        const rContext = 0; // Register holding accumulator for AggFinal
        const rArg = 2;
        const rKey = 3;
        const rResult = 4;
        const rAccumulator = 5; // Register for raw accumulator value

        const key1 = 'groupA';
        const key2 = 'groupB'; // Used in iteration test only currently
        const funcDef = testAggSum;
        const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: 1 };

        it('AggStep should update context, AggFinal should calculate result', async () => {
            const program = createTestProgram(db, [
                /* 1*/ createInstruction(Opcode.String8, 0, rKey, 0, 0), // key1
                /* 2*/ createInstruction(Opcode.Integer, 10, rArg),
                /* 3*/ createInstruction(Opcode.AggStep, rContext, rArg, rKey, p4), // Group A, val 10
                /* 4*/ createInstruction(Opcode.Integer, 20, rArg),
                /* 5*/ createInstruction(Opcode.AggStep, rContext, rArg, rKey, p4), // Group A, val 20
                /* 6*/ createInstruction(Opcode.String8, 0, rKey, 0, 0), // key1 again
                /* 7*/ createInstruction(Opcode.AggGetAccumulatorByKey, rKey, rAccumulator, 0), // Get Acc for key1 -> rAccumulator=R[5]
                /* 8*/ createInstruction(Opcode.AggFinal, rAccumulator, 0, rResult, p4), // Finalize R[5] -> rResult=R[4]
            ]);
            (program.constants as any[]).push(key1); // Only key1 needed here
            // Steps: Init + Str + Int + Step + Int + Step + Str + GetAcc + Final + Halt = 10
            const { runtime, finalStatus } = await runTestProgram(db, program, 9);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rResult)).to.equal(30); // 10 + 20
        });

        it('AggGetContext should load context for a key', async () => {
            const program = createTestProgram(db, [
                /* 1*/ createInstruction(Opcode.String8, 0, rKey, 0, 0), // key1
                /* 2*/ createInstruction(Opcode.Integer, 15, rArg),
                /* 3*/ createInstruction(Opcode.AggStep, rContext, rArg, rKey, p4),
                /* 4*/ createInstruction(Opcode.AggGetContext, rAccumulator, rKey, 0), // P1=dest=rAcc(5), P2=key=rKey(3)
                /* 5*/ createInstruction(Opcode.AggFinal, rAccumulator, 0, rResult, p4), // P1=acc=R[5] -> rResult=R[4]
            ]);
            (program.constants as any[]).push(key1);
            // Steps: Init + Str + Int + Step + GetCtx + Final + Halt = 7
            const { runtime, finalStatus } = await runTestProgram(db, program, 6);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rResult)).to.equal(15);
        });

        it('AggGetAccumulatorByKey should retrieve the raw accumulator', async () => {
             const program = createTestProgram(db, [
                /* 1*/ createInstruction(Opcode.String8, 0, rKey, 0, 0), // key1
                /* 2*/ createInstruction(Opcode.Integer, 10, rArg),
                /* 3*/ createInstruction(Opcode.AggStep, rContext, rArg, rKey, p4),
                /* 4*/ createInstruction(Opcode.Integer, 20, rArg),
                /* 5*/ createInstruction(Opcode.AggStep, rContext, rArg, rKey, p4),
                /* 6*/ createInstruction(Opcode.AggGetAccumulatorByKey, rKey, rAccumulator, 0), // Get Acc for key=R[3] -> rAccumulator=R[5]
            ]);
            (program.constants as any[]).push(key1);
            // Steps: Init + Str + Int + Step + Int + Step + GetAcc + Halt = 8
            const { runtime, finalStatus } = await runTestProgram(db, program, 7);
            expect(finalStatus).to.equal(StatusCode.OK);
            const accumulator = runtime.getMem(rAccumulator);
            expect(accumulator).to.deep.equal({ sum: 30, count: 2 });
        });
    });

    describe('Aggregation Iteration Opcodes', () => {
        const rAggKeyReg = 2; // Holds key from AggKey
        const rArg = 3;
        const rContextReg = 0; // Passed to AggStep, usually ignored
        const rKeyOut = 4;     // Holds key from AggKey
        const rContextOut = 5; // Holds accumulator from AggContext
        const rResult = 7;     // Holds final result from AggFinal

        const key1 = 'groupA';
        const key2 = 'groupB';
        const funcDef = testAggSum;
        const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: 1 };

        it('AggIterate, AggNext, AggKey, AggContext, AggReset should iterate results', async () => {
            const loopStartAddr = 10;
            const eofAddr = 16;
            // Registers to store results from each iteration
            const rKey1 = 8; const rResult1 = 9;
            const rKey2 = 10; const rResult2 = 11;
            const rLoopCount = 12; // To verify loop runs twice
            const rCurrentAccumulator = 13; // For AggGetAccumulatorByKey

            const program = createTestProgram(db, [
                 // --- Setup Phase (Populate aggregate contexts) ---
                /* 1*/ createInstruction(Opcode.String8, 0, rAggKeyReg, 0, 0), // key1
                /* 2*/ createInstruction(Opcode.Integer, 10, rArg),
                /* 3*/ createInstruction(Opcode.AggStep, rContextReg, rArg, rAggKeyReg, p4),
                /* 4*/ createInstruction(Opcode.Integer, 20, rArg),
                /* 5*/ createInstruction(Opcode.AggStep, rContextReg, rArg, rAggKeyReg, p4), // key1: {sum:30, count:2}
                /* 6*/ createInstruction(Opcode.String8, 0, rAggKeyReg, 0, 1), // key2
                /* 7*/ createInstruction(Opcode.Integer, 5, rArg),
                /* 8*/ createInstruction(Opcode.AggStep, rContextReg, rArg, rAggKeyReg, p4), // key2: {sum:5, count:1}
                 // --- Iteration Phase ---
                /* 9*/ createInstruction(Opcode.AggIterate),
                /*10 loopStart*/ createInstruction(Opcode.AggNext, 0, eofAddr),
                /*11*/ createInstruction(Opcode.AggKey, 0, rKeyOut),     // Get current key
                /*12*/ createInstruction(Opcode.AggContext, 0, rContextOut), // Get current accumulator
                /*13*/ createInstruction(Opcode.AggGetAccumulatorByKey, rKeyOut, rCurrentAccumulator, 0), // Get Acc by key
                /*14*/ createInstruction(Opcode.AggFinal, rContextOut, 0, rResult, p4), // Compute final value
                // --- Store results based on loop count ---
                /*15*/ createInstruction(Opcode.IfZero, rLoopCount, 18), // If count=0 (first loop), jump to store1
                /*16*/ createInstruction(Opcode.SCopy, rKeyOut, rKey2),    // Second loop: store key2
                /*17*/ createInstruction(Opcode.SCopy, rResult, rResult2), // Second loop: store result2
                /*18*/ createInstruction(Opcode.Add, rLoopCount, rLoopCount, rLoopCount, {type:'int', value: 1}), // Increment loop count ++
                /*19*/ createInstruction(Opcode.Goto, 0, 22),             // Jump past store1
                /*20 Store1 */ createInstruction(Opcode.SCopy, rKeyOut, rKey1),    // First loop: store key1
                /*21*/ createInstruction(Opcode.SCopy, rResult, rResult1), // First loop: store result1
                /*22 EndIf */ createInstruction(Opcode.Goto, 0, loopStartAddr), // Loop back
                /*23 eof */ createInstruction(Opcode.AggReset), // Reset after iteration
                 /*24*/ // Halt OK
            ], 0, 20); // Allocate more registers
            (program.constants as any[]).push(key1); // const[0]
            (program.constants as any[]).push(key2); // const[1]

            // Calculate expected steps carefully
            // Init(1) + Setup(8) + Iterate(1)
            // Loop 1: Next(1)+Key(1)+Ctx(1)+GetAccByKey(1)+Final(1)+IfZero(1)+StoreKey1(1)+StoreRes1(1)+Add(1)+Goto(1)+GotoLoop(1) = 11
            // Loop 2: Next(1)+Key(1)+Ctx(1)+GetAccByKey(1)+Final(1)+IfZero(1)+StoreKey2(1)+StoreRes2(1)+Add(1)+Goto(1)+GotoLoop(1) = 11
            // Final Next(1) + Reset(1) + Halt(1) = 3
            // Total = 1+8+1+11+11+3 = 35 steps => expectedSteps = 34
            const { runtime, finalStatus } = await runTestProgram(db, program, 34);
            expect(finalStatus).to.equal(StatusCode.OK);

             const aggMap = (runtime as any).aggregateContexts as Map<string, any>;
             expect(aggMap).to.exist;
             expect(aggMap.size).to.equal(0); // Check Reset worked
             expect((runtime as any).aggregateIterator).to.be.null;

             // Check the stored results (order might depend on Map iteration order)
             const key1Val = runtime.getMem(rKey1);
             const res1Val = runtime.getMem(rResult1);
             const key2Val = runtime.getMem(rKey2);
             const res2Val = runtime.getMem(rResult2);

             if (key1Val === key1) {
                 expect(res1Val).to.equal(30); // key1 -> 10+20=30
                 expect(key2Val).to.equal(key2);
                 expect(res2Val).to.equal(5);  // key2 -> 5
             } else {
                 expect(key1Val).to.equal(key2);
                 expect(res1Val).to.equal(5);
                 expect(key2Val).to.equal(key1);
                 expect(res2Val).to.equal(30);
             }
        });
    });
});
