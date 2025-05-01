import { expect } from 'chai';
import { VdbeRuntime } from '../src/vdbe/runtime.js';
import { type VdbeInstruction, createInstruction, type P4FuncDef } from '../src/vdbe/instruction.js';
import { Opcode } from '../src/vdbe/opcodes.js';
import { Database } from '../src/core/database.js';
import { Statement } from '../src/core/statement.js';
import { StatusCode, type SqlValue } from '../src/common/types.js';
import type { VdbeProgram } from '../src/vdbe/program.js';
import type { FunctionContext } from '../src/func/context.js';
import type { FunctionSchema } from '../src/schema/function.js';
import { FunctionFlags } from '../src/common/constants.js';
import type { SqliteContext } from '../src/func/context.js';
import { SqliteError } from '../src/common/errors.js';

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
        sql: 'COMPLEX_TEST',
    };
}

async function runTestProgram(db: Database, program: VdbeProgram, expectedSteps = 1) {
    const stmt = new Statement(db, program.sql, program);
    const runtime = new VdbeRuntime(stmt, program);
    let steps = 0;
    let finalStatus: StatusCode = StatusCode.ERROR;

    try {
        while (steps < expectedSteps + 2) { // Allow Init + Halt
            const status = await runtime.run();
            if (runtime.done || runtime.error) {
                finalStatus = runtime.error?.code ?? status;
                break;
            }
            if (status === StatusCode.ROW) {
                throw new Error('Unexpected ROW result during opcode test');
            }
            steps++;
            if (steps > program.instructions.length + 5) {
                throw new Error(`VDBE test exceeded expected steps (${expectedSteps})`);
            }
        }
    } catch (e) {
        console.error('>>> runTestProgram caught error:', e); // Add logging
        if (e instanceof Error) runtime.error = e as any;
        finalStatus = (e as any).code ?? StatusCode.ERROR;
    }
    return { runtime, finalStatus };
}

/* ------------------------------------------------------------------ */

// --- Test Function Definition ---
const testFuncUpper: FunctionSchema = {
    name: 'TEST_UPPER',
    numArgs: 1,
    flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC,
    xFunc: (ctx: SqliteContext, args: readonly SqlValue[]) => {
        const input = args[0];
        if (typeof input === 'string') {
            ctx.resultText(input.toUpperCase());
        } else {
            ctx.resultNull();
        }
    },
};

const testFuncAdd: FunctionSchema = {
    name: 'TEST_ADD',
    numArgs: 2,
    flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC,
    xFunc: (ctx: SqliteContext, args: readonly SqlValue[]) => {
        const a = args[0];
        const b = args[1];
        if (typeof a === 'number' && typeof b === 'number') {
            ctx.resultDouble(a + b);
        } else {
            ctx.resultNull();
        }
    },
};

// --- Test Aggregate Function Definition ---
// interface SumContext {
//     sum: number;
//     count: number;
// }

// const testAggSum: FunctionSchema = {
//     name: 'TEST_SUM',
//     numArgs: 1,
//     flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC,
//     xStep: (ctx: SqliteContext, args: readonly SqlValue[]) => {
//         let aggCtx = ctx.getAggregateContext<SumContext>();
//         if (!aggCtx) {
//             aggCtx = { sum: 0, count: 0 }; // Initialize
//         }
//         const value = args[0];
//         if (typeof value === 'number') {
//             aggCtx.sum += value;
//             aggCtx.count += 1;
//             ctx.setAggregateContext(aggCtx);
//         }
//     },
//     xFinal: (ctx: SqliteContext) => {
//         const aggCtx = ctx.getAggregateContext<SumContext>();
//         if (aggCtx?.count && aggCtx.count > 0) {
//             ctx.resultDouble(aggCtx.sum);
//         } else {
//             ctx.resultNull();
//         }
//     },
// };
// ---------------------------------------

describe('VDBE Complex Opcode Tests', () => {
    let db: Database;

    beforeEach(() => {
        db = new Database();
        // Register test functions for this suite
        db.registerFunction(testFuncUpper);
        db.registerFunction(testFuncAdd);
        // db.registerFunction(testAggSum); // Removed from here
    });

    afterEach(async () => {
        await db.close();
    });

    // ------------------------------------------------------------------
    // Function Calls
    // ------------------------------------------------------------------

    describe('Opcode.Function', () => {
        // Function <contextReg> <argStartReg> <resultReg>
        // P4 = { type: 'funcdef', funcDef: FunctionSchema, nArgs: number }
        const rContext = 0; // UDF context usually stored at 0
        const rArgsStart = 2;
        const rResult = rArgsStart + 2; // Place result after args

        it('should call a simple function (TEST_UPPER)', async () => {
            const inputStr = 'hello';
            const funcDef = testFuncUpper;
            const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: 1 };

            const program = createTestProgram(db, [
                createInstruction(Opcode.String8, 0, rArgsStart, 0, 0), // Load arg "hello"
                createInstruction(Opcode.Function, rContext, rArgsStart, rResult, p4),
            ]);
            (program.constants as any[]).push(inputStr);

            const { runtime, finalStatus } = await runTestProgram(db, program, 2);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rResult)).to.equal('HELLO');
        });

        it('should call a function with multiple arguments (TEST_ADD)', async () => {
             const funcDef = testFuncAdd;
             const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: 2 };

             const program = createTestProgram(db, [
                createInstruction(Opcode.Integer, 10, rArgsStart),     // Arg 1
                createInstruction(Opcode.Integer, 5, rArgsStart + 1), // Arg 2
                createInstruction(Opcode.Function, rContext, rArgsStart, rResult, p4),
            ]);

            const { runtime, finalStatus } = await runTestProgram(db, program, 3);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rResult)).to.equal(15);
        });

        it('function should handle NULL input gracefully', async () => {
            const funcDef = testFuncUpper;
            const p4: P4FuncDef = { type: 'funcdef', funcDef, nArgs: 1 };

            const program = createTestProgram(db, [
                createInstruction(Opcode.Null, 0, rArgsStart), // Load arg NULL
                createInstruction(Opcode.Function, rContext, rArgsStart, rResult, p4),
            ]);

            const { runtime, finalStatus } = await runTestProgram(db, program, 2);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rResult)).to.be.null; // TEST_UPPER returns null for non-string
        });
    });

    // ------------------------------------------------------------------
    // Misc Control / Result / Constraint
    // ------------------------------------------------------------------

    describe('Opcode.Once', () => {
        // Once <jumpTarget>
        const targetAddr = 4; // Jump target (Halt)
        const rCounter = 2;

        it('should execute the block only once across multiple runs of the same statement', async () => {
            const program = createTestProgram(db, [
                /* 1 */ createInstruction(Opcode.Integer, 0, rCounter),
                /* 2 */ createInstruction(Opcode.Once, 0, targetAddr + 1, 0), // Target is Halt (addr 4 relative, 5 absolute)
                /* 3 */ createInstruction(Opcode.Integer, 1, rCounter), // Set counter = 1 instead of Add
                /* 4 */ createInstruction(Opcode.Halt, StatusCode.OK, 0, 0, "Normal Halt"), // Need explicit Halt here
                /* 5 */ // Halt target for Once jump is implicit final Halt
            ]);

            const stmt = new Statement(db, program.sql, program);
            const runtime = new VdbeRuntime(stmt, program);

            // --- First Run ---
            let steps = 0;
            let status: StatusCode = StatusCode.ERROR;
            while (steps++ < 5) { // Init, Int, Once, Add, Halt(OK)
                status = await runtime.run();
                if (runtime.done) break;
            }
            expect(status).to.equal(StatusCode.OK);
            expect(runtime.getMem(rCounter)).to.equal(1);
            expect(runtime.done).to.be.true;

            // --- Reset Runtime for Second Run (keeping statement state) ---
            await runtime.reset(); // Resets PC, stack, done flag, etc.
            runtime.clearAppliedBindings(); // Allow re-applying (though none here)

            // --- Second Run ---
            steps = 0;
            status = StatusCode.ERROR;
            try {
                while (steps++ < 5) { // Init, Int, Once(jumps to Halt), Halt(OK)
                    status = await runtime.run();
                    if (runtime.done) break;
                }
            } catch (e) {
                console.error('>>> Once test (second run) caught error:', e);
                if (e instanceof SqliteError) {
                     status = e.code as StatusCode;
                }
            }
            expect(status).to.equal(StatusCode.OK);
            expect(runtime.getMem(rCounter)).to.equal(0); // Counter should NOT have been incremented
            expect(runtime.done).to.be.true;
        });
    });

    describe('Opcode.ConstraintViolation', () => {
        it('should halt execution with CONSTRAINT error and message', async () => {
            const errorMsg = "My Constraint Failed";
            const program = createTestProgram(db, [
                createInstruction(Opcode.ConstraintViolation, 0, 0, 0, errorMsg),
            ]);
            const { runtime, finalStatus } = await runTestProgram(db, program, 1);
            expect(finalStatus).to.equal(StatusCode.CONSTRAINT);
            expect(runtime.error).to.exist;
            expect(runtime.error?.message).to.contain(errorMsg);
            expect(runtime.error?.code).to.equal(StatusCode.CONSTRAINT);
        });
    });

    describe('Opcode.ResultRow', () => {
        // ResultRow <startReg> <count>
        const rDataStart = 2;
        const count = 3;

        it('should yield a result row and increment PC', async () => {
            const program = createTestProgram(db, [
                /* 1 */ createInstruction(Opcode.Integer, 10, rDataStart),
                /* 2 */ createInstruction(Opcode.String8, 0, rDataStart + 1, 0, 0), // "res"
                /* 3 */ createInstruction(Opcode.Null, 0, rDataStart + 2),
                /* 4 */ createInstruction(Opcode.ResultRow, rDataStart, count),
                /* 5 */ // Halt
            ]);
            (program.constants as any[]).push('res');

            // Run until ROW is yielded
            const stmt = new Statement(db, program.sql, program);
            const runtime = new VdbeRuntime(stmt, program);

            const rowStatus = await runtime.run(); // ResultRow

            expect(rowStatus).to.equal(StatusCode.ROW);
            expect(runtime.hasYielded).to.be.false; // Should be reset by runtime
            expect(runtime.done).to.be.false;
            expect(runtime.pc).to.equal(5); // PC should be at Halt

            // Continue execution to Halt
            let finalStatus: StatusCode | undefined = undefined;
            try {
                finalStatus = await runtime.run(); // Execute Halt
            } catch (e) {
                console.error('>>> ResultRow Test: Error during final runtime.run():', e);
                if (e instanceof SqliteError) finalStatus = e.code as StatusCode;
                else finalStatus = StatusCode.ERROR; // Assign generic error if not SqliteError
            }
            console.log('>>> ResultRow Test: finalStatus received:', finalStatus, 'Expected:', StatusCode.OK);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.done).to.be.true;
        });
    });

    describe('Opcode.CollSeq', () => {
        // CollSeq <destReg> <collationName>
        const rDest = 2;
        const collName = 'TEST_COLL';
        const dummyCollFunc = (a: string, b: string) => 0;

        beforeEach(() => {
            db.registerCollation(collName, dummyCollFunc);
        });

        it('should load collation sequence object into register', async () => {
            const program = createTestProgram(db, [
                createInstruction(Opcode.CollSeq, 0, rDest, 0, collName),
            ]);
            const { runtime, finalStatus } = await runTestProgram(db, program, 1);
            expect(finalStatus).to.equal(StatusCode.OK);
            const result = runtime.getMem(rDest);
            expect(result).to.equal(collName); // Expect the name string
        });

         it('should load NULL if collation sequence not found', async () => {
            const program = createTestProgram(db, [
                createInstruction(Opcode.CollSeq, 0, rDest, 0, 'NON_EXISTENT_COLL'),
            ]);
            const { runtime, finalStatus } = await runTestProgram(db, program, 1);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rDest)).to.be.null;
        });
    });
});
