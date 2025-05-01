import { expect } from 'chai';
import { VdbeRuntime } from '../src/vdbe/runtime.js';
import { type VdbeInstruction, createInstruction } from '../src/vdbe/instruction.js';
import { Opcode } from '../src/vdbe/opcodes.js';
import { Database } from '../src/core/database.js';
import { Statement } from '../src/core/statement.js';
import { StatusCode } from '../src/common/types.js';
import type { VdbeProgram } from '../src/vdbe/program.js';

// Helper function to create a minimal VDBE program
function createTestProgram(db: Database, instructions: VdbeInstruction[]): VdbeProgram {
	return {
		instructions: Object.freeze([
			createInstruction(Opcode.Init, 0, 1, 0), // Start execution at PC=1
			...instructions,
			createInstruction(Opcode.Halt, StatusCode.OK, 0, 0) // Halt at the end
		]),
		numMemCells: 10, // Allocate a few registers for tests
		numCursors: 0,   // No cursors needed for these basic tests yet
		constants: [], // Start with empty constants, tests can add
		parameters: new Map(),
		columnNames: [],
		sql: 'TEST',
	};
}

// Helper to run a program and get the final state or error
async function runTestProgram(db: Database, program: VdbeProgram, expectedSteps = 1) {
	const stmt = new Statement(db, program.sql, program);
	const runtime = new VdbeRuntime(stmt, program);
	let steps = 0;
	let finalStatus: StatusCode = StatusCode.ERROR; // Default to error

	try {
		while (steps < expectedSteps + 1) { // Allow one extra step for Halt
			const status = await runtime.run();
			if (runtime.done || runtime.error) {
				finalStatus = runtime.error?.code ?? status;
				break;
			}
			if (status === StatusCode.ROW) {
				// For opcode tests, we don't expect rows yet
				throw new Error(`Unexpected ROW result during opcode test`);
			}
			steps++;
			if (steps > program.instructions.length + 5) { // Safety break
				throw new Error(`VDBE test exceeded expected steps (${expectedSteps})`);
			}
		}
	} catch (e) {
		console.error("Error during VDBE test run:", e);
		if (e instanceof Error) runtime.error = e as any; // Capture error
		finalStatus = (e as any).code ?? StatusCode.ERROR;
	}

	return { runtime, finalStatus };
}

describe('VDBE Opcode Tests', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database(); // Create a fresh DB for each test
	});

	afterEach(async () => {
		await db.close();
	});

	it('Opcode.Integer should load an integer into a register', async () => {
		// Compiler usage: Integer <value> <targetReg> 0
		const targetReg = 2; // Locals start at offset 2
		const value = 42;
		const program = createTestProgram(db, [
			createInstruction(Opcode.Integer, value, targetReg, 0, null, 0, "Load 42 into R[2]"),
		]);

		const { runtime, finalStatus } = await runTestProgram(db, program, 1);

		expect(finalStatus).to.equal(StatusCode.OK);
		expect(runtime.getMem(targetReg)).to.equal(value);
	});

	it('Opcode.Null should load NULL into a register', async () => {
		// Compiler usage: Null 0 <targetReg> 0
		const targetReg = 3;
		const program = createTestProgram(db, [
			createInstruction(Opcode.Null, 0, targetReg, 0, null, 0, "Load NULL into R[3]"),
		]);

		const { runtime, finalStatus } = await runTestProgram(db, program, 1);

		expect(finalStatus).to.equal(StatusCode.OK);
		expect(runtime.getMem(targetReg)).to.be.null;
	});

	it('Opcode.SCopy should copy value between registers', async () => {
		// Compiler usage: SCopy <sourceReg> <destReg> 0
		const sourceReg = 2;
		const destReg = 3;
		const value = 99;
		const program = createTestProgram(db, [
			createInstruction(Opcode.Integer, value, sourceReg, 0, null, 0, "Load 99 into R[2]"),
			createInstruction(Opcode.SCopy, sourceReg, destReg, 0, null, 0, "Copy R[2] to R[3]"),
		]);

		const { runtime, finalStatus } = await runTestProgram(db, program, 2);

		expect(finalStatus).to.equal(StatusCode.OK);
		expect(runtime.getMem(destReg)).to.equal(value);
		expect(runtime.getMem(sourceReg)).to.equal(value); // Source should be unchanged
	});

	describe('Opcode.Add', () => {
		// Compiler usage: Add <leftReg> <rightReg> <destReg>
		const rLeft = 2;
		const rRight = 3;
		const rDest = 4;

		it('should add two integers', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 5, rLeft),
				createInstruction(Opcode.Integer, 7, rRight),
				createInstruction(Opcode.Add, rLeft, rRight, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(12);
		});

		it('should result in NULL if one operand is NULL', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 5, rLeft),
				createInstruction(Opcode.Null, 0, rRight),
				createInstruction(Opcode.Add, rLeft, rRight, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null;
		});

		// Based on compiler code, Add implicitly uses numeric affinity
		it('should apply numeric affinity (Integer + Real)', async () => {
			const realValue = 5.5;
            const program = createTestProgram(db, [
                createInstruction(Opcode.Integer, 7, rLeft),
                // Need Real opcode or constant load
                createInstruction(Opcode.Real, 0, rRight, 0, 0), // Use constant index 0 for P4
                createInstruction(Opcode.Add, rLeft, rRight, rDest),
            ]);
			// Manually add constant to the program object (cleaner way might be needed)
			(program.constants as any[]).push(realValue);
            const { runtime, finalStatus } = await runTestProgram(db, program, 3);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rDest)).to.equal(12.5);
        });

        it('should apply numeric affinity (Integer + String)', async () => {
			const strValue = "5";
            const program = createTestProgram(db, [
                createInstruction(Opcode.Integer, 7, rLeft),
                createInstruction(Opcode.String8, 0, rRight, 0, 0), // Use constant index 0 for P4
                createInstruction(Opcode.Add, rLeft, rRight, rDest),
            ]);
            (program.constants as any[]).push(strValue);
            const { runtime, finalStatus } = await runTestProgram(db, program, 3);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rDest)).to.equal(12);
        });

        it('should result in NULL if string affinity conversion fails', async () => {
			const strValue = "abc";
            const program = createTestProgram(db, [
                createInstruction(Opcode.Integer, 7, rLeft),
                createInstruction(Opcode.String8, 0, rRight, 0, 0), // Use constant index 0 for P4
                createInstruction(Opcode.Add, rLeft, rRight, rDest),
            ]);
            (program.constants as any[]).push(strValue);
            const { runtime, finalStatus } = await runTestProgram(db, program, 3);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rDest)).to.be.null;
        });

         it('should handle BigInt addition', async () => {
            const bigVal = BigInt("1000000000000000000"); // 10^18
            const intVal = 7;
            const program = createTestProgram(db, [
                createInstruction(Opcode.Int64, 0, rLeft, 0, 0), // Use constant index 0 for P4
                createInstruction(Opcode.Integer, intVal, rRight),
                createInstruction(Opcode.Add, rLeft, rRight, rDest),
            ]);
            (program.constants as any[]).push(bigVal);
            const { runtime, finalStatus } = await runTestProgram(db, program, 3);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rDest)).to.equal(bigVal + BigInt(intVal));
        });
	});

	// Add more tests for other simple opcodes (Subtract, Multiply, etc.) following the same pattern...

	describe('Opcode.Subtract', () => {
		// Compiler usage: Subtract <leftReg> <rightReg> <destReg> -> dest = right - left
		const rLeft = 2;
		const rRight = 3;
		const rDest = 4;

		it('should subtract two integers (R[right] - R[left])', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 5, rLeft),
				createInstruction(Opcode.Integer, 12, rRight),
				createInstruction(Opcode.Subtract, rLeft, rRight, rDest), // 12 - 5
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(7);
		});

		it('should result in NULL if an operand is NULL', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 5, rLeft),
				createInstruction(Opcode.Null, 0, rRight),
				createInstruction(Opcode.Subtract, rLeft, rRight, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null;
		});

        it('should handle BigInt subtraction', async () => {
            const bigVal = BigInt("1000000000000000000");
            const intVal = 7;
            const program = createTestProgram(db, [
                createInstruction(Opcode.Int64, 0, rRight, 0, 0), // Right operand (bigVal)
                createInstruction(Opcode.Integer, intVal, rLeft),      // Left operand (intVal)
                createInstruction(Opcode.Subtract, rLeft, rRight, rDest), // bigVal - intVal
            ]);
            (program.constants as any[]).push(bigVal);
            const { runtime, finalStatus } = await runTestProgram(db, program, 3);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rDest)).to.equal(bigVal - BigInt(intVal));
        });
	});

	describe('Opcode.Multiply', () => {
		const rLeft = 2;
		const rRight = 3;
		const rDest = 4;

		it('should multiply two integers', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 5, rLeft),
				createInstruction(Opcode.Integer, 7, rRight),
				createInstruction(Opcode.Multiply, rLeft, rRight, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(35);
		});

		it('should result in NULL if an operand is NULL', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 5, rLeft),
				createInstruction(Opcode.Null, 0, rRight),
				createInstruction(Opcode.Multiply, rLeft, rRight, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null;
		});

        it('should handle BigInt multiplication', async () => {
            const bigVal = BigInt("1000000000000000000");
            const intVal = 7;
            const program = createTestProgram(db, [
                createInstruction(Opcode.Int64, 0, rLeft, 0, 0),
                createInstruction(Opcode.Integer, intVal, rRight),
                createInstruction(Opcode.Multiply, rLeft, rRight, rDest),
            ]);
            (program.constants as any[]).push(bigVal);
            const { runtime, finalStatus } = await runTestProgram(db, program, 3);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rDest)).to.equal(bigVal * BigInt(intVal));
        });
	});

	describe('Opcode.Divide', () => {
		// Divide <divisorReg> <numeratorReg> <destReg> -> dest = numerator / divisor
		const rDivisor = 2;
		const rNumerator = 3;
		const rDest = 4;

		it('should divide two integers', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 4, rDivisor),
				createInstruction(Opcode.Integer, 20, rNumerator),
				createInstruction(Opcode.Divide, rDivisor, rNumerator, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(5);
		});

        it('should perform floating point division', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 4, rDivisor),
				createInstruction(Opcode.Integer, 21, rNumerator),
				createInstruction(Opcode.Divide, rDivisor, rNumerator, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(5.25);
		});

		it('should result in NULL if numerator is NULL', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 4, rDivisor),
				createInstruction(Opcode.Null, 0, rNumerator),
				createInstruction(Opcode.Divide, rDivisor, rNumerator, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null;
		});

		it('should result in NULL if divisor is NULL', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Null, 0, rDivisor),
				createInstruction(Opcode.Integer, 20, rNumerator),
				createInstruction(Opcode.Divide, rDivisor, rNumerator, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null;
		});

		it('should result in NULL if divisor is zero (integer)', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 0, rDivisor),
				createInstruction(Opcode.Integer, 20, rNumerator),
				createInstruction(Opcode.Divide, rDivisor, rNumerator, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null;
		});

        it('should result in NULL if divisor is zero (bigint)', async () => {
            const bigNumerator = BigInt(20);
            const program = createTestProgram(db, [
                createInstruction(Opcode.Integer, 0, rDivisor),
                createInstruction(Opcode.Int64, 0, rNumerator, 0, 0),
                createInstruction(Opcode.Divide, rDivisor, rNumerator, rDest),
            ]);
            (program.constants as any[]).push(bigNumerator);
            const { runtime, finalStatus } = await runTestProgram(db, program, 3);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rDest)).to.be.null;
        });
	});

    describe('Opcode.Remainder', () => {
		// Remainder <divisorReg> <numeratorReg> <destReg> -> dest = numerator % divisor
		const rDivisor = 2;
		const rNumerator = 3;
		const rDest = 4;

        it('should calculate remainder for integers', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 4, rDivisor),
				createInstruction(Opcode.Integer, 21, rNumerator),
				createInstruction(Opcode.Remainder, rDivisor, rNumerator, rDest), // 21 % 4
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(1);
		});

		it('should calculate remainder for BigInts', async () => {
            const bigNum = BigInt("1000000000000000021");
            const bigDiv = BigInt(4);
            const program = createTestProgram(db, [
                createInstruction(Opcode.Int64, 0, rDivisor, 0, 0),
                createInstruction(Opcode.Int64, 0, rNumerator, 0, 1),
                createInstruction(Opcode.Remainder, rDivisor, rNumerator, rDest),
            ]);
            (program.constants as any[]).push(bigDiv);
            (program.constants as any[]).push(bigNum);
            const { runtime, finalStatus } = await runTestProgram(db, program, 3);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rDest)).to.equal(bigNum % bigDiv); // Should be 1n
        });

        it('should result in NULL if divisor is zero', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 0, rDivisor),
				createInstruction(Opcode.Integer, 21, rNumerator),
				createInstruction(Opcode.Remainder, rDivisor, rNumerator, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null; // SQLite returns NULL on remainder by zero
		});

        it('should result in NULL if an operand is NULL', async () => {
			const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 4, rDivisor),
				createInstruction(Opcode.Null, 0, rNumerator),
				createInstruction(Opcode.Remainder, rDivisor, rNumerator, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null;
		});
    });

    describe('Opcode.Negative', () => {
        // Negative <sourceReg> <destReg>
        const rSrc = 2;
        const rDest = 3;

        it('should negate an integer', async () => {
            const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 42, rSrc),
				createInstruction(Opcode.Negative, rSrc, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 2);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(-42);
        });

        it('should negate a real number', async () => {
             const realValue = 42.5;
             const program = createTestProgram(db, [
                createInstruction(Opcode.Real, 0, rSrc, 0, 0),
				createInstruction(Opcode.Negative, rSrc, rDest),
			]);
             (program.constants as any[]).push(realValue);
			const { runtime, finalStatus } = await runTestProgram(db, program, 2);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(-42.5);
        });

        it('should negate a BigInt', async () => {
            const bigVal = BigInt("1000000000000000007");
            const program = createTestProgram(db, [
                createInstruction(Opcode.Int64, 0, rSrc, 0, 0),
				createInstruction(Opcode.Negative, rSrc, rDest),
			]);
            (program.constants as any[]).push(bigVal);
			const { runtime, finalStatus } = await runTestProgram(db, program, 2);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(-bigVal);
        });

        it('should result in NULL if operand is NULL', async () => {
            const program = createTestProgram(db, [
                createInstruction(Opcode.Null, 0, rSrc),
				createInstruction(Opcode.Negative, rSrc, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 2);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null;
        });

        it('should result in NULL if operand is non-numeric string', async () => {
            const strValue = "xyz";
            const program = createTestProgram(db, [
                createInstruction(Opcode.String8, 0, rSrc, 0, 0),
				createInstruction(Opcode.Negative, rSrc, rDest),
			]);
             (program.constants as any[]).push(strValue);
			const { runtime, finalStatus } = await runTestProgram(db, program, 2);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null; // Negation of non-numeric string -> NULL
        });
         it('should negate a numeric string', async () => {
            const strValue = "-123.5";
            const program = createTestProgram(db, [
                createInstruction(Opcode.String8, 0, rSrc, 0, 0),
				createInstruction(Opcode.Negative, rSrc, rDest),
			]);
             (program.constants as any[]).push(strValue);
			const { runtime, finalStatus } = await runTestProgram(db, program, 2);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(123.5);
        });
    });

	// --- Control Flow ---

	describe('Opcode.Goto', () => {
		it('should jump to the specified address', async () => {
			const rTest = 2;
			const targetAddr = 4; // Address of Halt
			const program = createTestProgram(db, [
				/* 1 */ createInstruction(Opcode.Integer, 1, rTest),
				/* 2 */ createInstruction(Opcode.Goto, 0, targetAddr, 0),
				/* 3 */ createInstruction(Opcode.Integer, 99, rTest), // This should be skipped
				/* 4 */ // Halt is automatically added at end
			]);
			// Expected steps: Init -> Integer -> Goto -> Halt = 3 instructions executed
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rTest)).to.equal(1); // Verify skipped instruction
			expect(runtime.pc).to.equal(targetAddr);
		});
	});

	describe('Opcode.IfTrue', () => {
		const rCond = 2;
		const rTest = 3;
		const targetAddr = 5; // Address of Halt

		it('should jump if condition register is true (1)', async () => {
			const program = createTestProgram(db, [
				/* 1 */ createInstruction(Opcode.Integer, 1, rCond),
				/* 2 */ createInstruction(Opcode.Integer, 1, rTest),
				/* 3 */ createInstruction(Opcode.IfTrue, rCond, targetAddr, 0),
				/* 4 */ createInstruction(Opcode.Integer, 99, rTest), // Skipped
				/* 5 */ // Halt
			]);
			// Expected steps: Init -> Int(1) -> Int(1) -> IfTrue (jumps) -> Halt = 4
			const { runtime, finalStatus } = await runTestProgram(db, program, 4);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rTest)).to.equal(1);
		});

		it('should not jump if condition register is false (0)', async () => {
			const program = createTestProgram(db, [
				/* 1 */ createInstruction(Opcode.Integer, 0, rCond),
				/* 2 */ createInstruction(Opcode.Integer, 1, rTest),
				/* 3 */ createInstruction(Opcode.IfTrue, rCond, targetAddr, 0),
				/* 4 */ createInstruction(Opcode.Integer, 99, rTest), // Executed
				/* 5 */ // Halt
			]);
			// Expected steps: Init -> Int(0) -> Int(1) -> IfTrue (no jump) -> Int(99) -> Halt = 5
			const { runtime, finalStatus } = await runTestProgram(db, program, 5);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rTest)).to.equal(99);
		});

		it('should not jump if condition register is NULL', async () => {
			const program = createTestProgram(db, [
				/* 1 */ createInstruction(Opcode.Null, 0, rCond),
				/* 2 */ createInstruction(Opcode.Integer, 1, rTest),
				/* 3 */ createInstruction(Opcode.IfTrue, rCond, targetAddr, 0),
				/* 4 */ createInstruction(Opcode.Integer, 99, rTest), // Executed
				/* 5 */ // Halt
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 5);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rTest)).to.equal(99);
		});
	});

	describe('Opcode.IfFalse', () => {
		const rCond = 2;
		const rTest = 3;
		const targetAddr = 5; // Address of Halt

		it('should jump if condition register is false (0)', async () => {
			const program = createTestProgram(db, [
				/* 1 */ createInstruction(Opcode.Integer, 0, rCond),
				/* 2 */ createInstruction(Opcode.Integer, 1, rTest),
				/* 3 */ createInstruction(Opcode.IfFalse, rCond, targetAddr, 0),
				/* 4 */ createInstruction(Opcode.Integer, 99, rTest), // Skipped
				/* 5 */ // Halt
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 4);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rTest)).to.equal(1);
		});

        it('should jump if condition register is NULL', async () => {
			const program = createTestProgram(db, [
				/* 1 */ createInstruction(Opcode.Null, 0, rCond),
				/* 2 */ createInstruction(Opcode.Integer, 1, rTest),
				/* 3 */ createInstruction(Opcode.IfFalse, rCond, targetAddr, 0),
				/* 4 */ createInstruction(Opcode.Integer, 99, rTest), // Skipped
				/* 5 */ // Halt
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 4);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rTest)).to.equal(1);
		});

		it('should not jump if condition register is true (1)', async () => {
			const program = createTestProgram(db, [
				/* 1 */ createInstruction(Opcode.Integer, 1, rCond),
				/* 2 */ createInstruction(Opcode.Integer, 1, rTest),
				/* 3 */ createInstruction(Opcode.IfFalse, rCond, targetAddr, 0),
				/* 4 */ createInstruction(Opcode.Integer, 99, rTest), // Executed
				/* 5 */ // Halt
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 5);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rTest)).to.equal(99);
		});
	});

    // --- Comparison Opcodes ---

	describe('Comparison Opcodes (Eq, Ne, Lt, Le, Gt, Ge)', () => {
		const rLeft = 2;
		const rRight = 3;
		const rDest = 4; // Not used by comparison jumps, but for clarity
        const targetAddr = 6; // Address of second Halt instruction
        const nextAddr = 4;   // Address after the comparison jump

		// Helper to create a comparison test program
		const createCompareTest = (opcode: Opcode, vLeft: any, vRight: any, jumpExpected: boolean) => {
			const consts: any[] = [];
			const inst: VdbeInstruction[] = [];
			const addValue = (val: any, reg: number) => {
				let p4: any = null;
				let opcodeToUse: Opcode | null = null;

				if (val === null) opcodeToUse = Opcode.Null;
				else if (typeof val === 'number' && Number.isInteger(val)) opcodeToUse = Opcode.Integer;
				else if (typeof val === 'number') { opcodeToUse = Opcode.Real; p4 = consts.length; consts.push(val); }
				else if (typeof val === 'string') { opcodeToUse = Opcode.String8; p4 = consts.length; consts.push(val); }
				else if (typeof val === 'bigint') { opcodeToUse = Opcode.Int64; p4 = consts.length; consts.push(val); }
				else throw new Error(`Unsupported type for comparison test: ${typeof val}`);

				if (opcodeToUse === Opcode.Null) {
					inst.push(createInstruction(Opcode.Null, 0, reg));
				} else if (opcodeToUse === Opcode.Integer) {
					inst.push(createInstruction(Opcode.Integer, val, reg));
				} else {
					inst.push(createInstruction(opcodeToUse!, 0, reg, 0, p4));
				}
			};

            // Instruction sequence:
            // 1: Init (added by createTestProgram)
            // 2: Load Left
            // 3: Load Right
            // 4: Compare Opcode (Jump to 6 if true)
            // 5: Halt INTERNAL (if no jump)
            // 6: Halt OK (if jump)
            // 7: Halt OK (added by createTestProgram - becomes unreachable)

			const targetAddrAfterInit = targetAddr -1; // Adjust target for final instruction list

			addValue(vLeft, rLeft); // Goes into final index 1
			addValue(vRight, rRight); // Goes into final index 2
			inst.push(createInstruction(opcode, rLeft, targetAddrAfterInit, rRight)); // Index 3, Jumps to final index 5
			inst.push(createInstruction(Opcode.Halt, StatusCode.INTERNAL, 0, 0)); // Index 4, Halt if NO jump
            inst.push(createInstruction(Opcode.Halt, StatusCode.OK, 0, 0)); // Index 5, Halt if jump happens

            // Pass the fully assembled instruction list (excluding Init/final Halt)
			const program = createTestProgram(db, inst);
			// Add constants to the mutable program object
			(program.constants as any[]).push(...consts);


			return program;
		};

		// Test cases for Eq
        [
            { left: 5, right: 5, jump: true, desc: 'Eq: 5 == 5' },
            { left: 5, right: 6, jump: false, desc: 'Eq: 5 == 6' },
            { left: 5, right: 5.0, jump: true, desc: 'Eq: 5 == 5.0' },
            { left: 5.1, right: 5.1, jump: true, desc: 'Eq: 5.1 == 5.1' },
            { left: "abc", right: "abc", jump: true, desc: 'Eq: "abc" == "abc"' },
            { left: "abc", right: "def", jump: false, desc: 'Eq: "abc" == "def"' },
            { left: BigInt(10), right: BigInt(10), jump: true, desc: 'Eq: 10n == 10n' },
            { left: BigInt(10), right: BigInt(11), jump: false, desc: 'Eq: 10n == 11n' },
            { left: null, right: null, jump: false, desc: 'Eq: null == null (is false)' }, // SQL NULL comparison
            { left: 5, right: null, jump: false, desc: 'Eq: 5 == null (is false)' },
        ].forEach(t => {
            it(t.desc, async () => {
                const program = createCompareTest(Opcode.Eq, t.left, t.right, t.jump);
                // Expected steps: Init, Load L, Load R, Compare, Halt = 4
                const { finalStatus } = await runTestProgram(db, program, 4);
                expect(finalStatus).to.equal(t.jump ? StatusCode.OK : StatusCode.INTERNAL);
            });
        });

        // Test cases for Ne
        [
            { left: 5, right: 6, jump: true, desc: 'Ne: 5 != 6' },
            { left: 5, right: 5, jump: false, desc: 'Ne: 5 != 5' },
             { left: null, right: null, jump: true, desc: 'Ne: null != null (is true)' }, // SQL NULL comparison
             { left: 5, right: null, jump: true, desc: 'Ne: 5 != null (is true)' },
        ].forEach(t => {
             it(t.desc, async () => {
                const program = createCompareTest(Opcode.Ne, t.left, t.right, t.jump);
                const { finalStatus } = await runTestProgram(db, program, 4);
                expect(finalStatus).to.equal(t.jump ? StatusCode.OK : StatusCode.INTERNAL);
            });
        });

		// Test cases for Lt
        [
            { left: 5, right: 6, jump: true, desc: 'Lt: 5 < 6' },
            { left: 5, right: 5, jump: false, desc: 'Lt: 5 < 5' },
            { left: 6, right: 5, jump: false, desc: 'Lt: 6 < 5' },
            { left: "abc", right: "def", jump: true, desc: 'Lt: "abc" < "def"' },
            { left: null, right: 5, jump: false, desc: 'Lt: null < 5 (is false)' }, // NULL comparisons are false
            { left: 5, right: null, jump: false, desc: 'Lt: 5 < null (is false)' },
        ].forEach(t => {
             it(t.desc, async () => {
                const program = createCompareTest(Opcode.Lt, t.left, t.right, t.jump);
                const { finalStatus } = await runTestProgram(db, program, 4);
                expect(finalStatus).to.equal(t.jump ? StatusCode.OK : StatusCode.INTERNAL);
            });
        });

        // Add similar tests for Le, Gt, Ge
        // Test cases for Le
        [
            { left: 5, right: 6, jump: true, desc: 'Le: 5 <= 6' },
            { left: 5, right: 5, jump: true, desc: 'Le: 5 <= 5' },
            { left: 6, right: 5, jump: false, desc: 'Le: 6 <= 5' },
            { left: null, right: 5, jump: false, desc: 'Le: null <= 5' },
        ].forEach(t => {
             it(t.desc, async () => {
                const program = createCompareTest(Opcode.Le, t.left, t.right, t.jump);
                const { finalStatus } = await runTestProgram(db, program, 4);
                expect(finalStatus).to.equal(t.jump ? StatusCode.OK : StatusCode.INTERNAL);
            });
        });

        // Test cases for Gt
        [
            { left: 6, right: 5, jump: true, desc: 'Gt: 6 > 5' },
            { left: 5, right: 5, jump: false, desc: 'Gt: 5 > 5' },
            { left: 5, right: 6, jump: false, desc: 'Gt: 5 > 6' },
            { left: null, right: 5, jump: false, desc: 'Gt: null > 5' },
        ].forEach(t => {
             it(t.desc, async () => {
                const program = createCompareTest(Opcode.Gt, t.left, t.right, t.jump);
                const { finalStatus } = await runTestProgram(db, program, 4);
                expect(finalStatus).to.equal(t.jump ? StatusCode.OK : StatusCode.INTERNAL);
            });
        });

        // Test cases for Ge
        [
            { left: 6, right: 5, jump: true, desc: 'Ge: 6 >= 5' },
            { left: 5, right: 5, jump: true, desc: 'Ge: 5 >= 5' },
            { left: 5, right: 6, jump: false, desc: 'Ge: 5 >= 6' },
            { left: null, right: 5, jump: false, desc: 'Ge: null >= 5' },
        ].forEach(t => {
             it(t.desc, async () => {
                const program = createCompareTest(Opcode.Ge, t.left, t.right, t.jump);
                const { finalStatus } = await runTestProgram(db, program, 4);
                expect(finalStatus).to.equal(t.jump ? StatusCode.OK : StatusCode.INTERNAL);
            });
        });
	});

    // --- Other Register/Memory ---

    describe('Opcode.Move', () => {
        // Move <srcReg> <destReg> <count>
        it('should move multiple registers', async () => {
            const rSrc = 2;
            const rDest = 5;
            const count = 3;
            const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 10, rSrc),
                createInstruction(Opcode.Integer, 20, rSrc + 1),
                createInstruction(Opcode.Integer, 30, rSrc + 2),
                createInstruction(Opcode.Null, 0, rDest), // Ensure dest starts null
                createInstruction(Opcode.Null, 0, rDest + 1),
                createInstruction(Opcode.Null, 0, rDest + 2),
				createInstruction(Opcode.Move, rSrc, rDest, count),
			]);
            const { runtime, finalStatus } = await runTestProgram(db, program, 7);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rDest)).to.equal(10);
            expect(runtime.getMem(rDest + 1)).to.equal(20);
            expect(runtime.getMem(rDest + 2)).to.equal(30);
             // Source should remain unchanged
            expect(runtime.getMem(rSrc)).to.equal(10);
            expect(runtime.getMem(rSrc + 1)).to.equal(20);
            expect(runtime.getMem(rSrc + 2)).to.equal(30);
        });

        it('should handle Move with count 0 (no-op)', async () => {
             const rSrc = 2;
            const rDest = 3;
            const program = createTestProgram(db, [
                createInstruction(Opcode.Integer, 10, rSrc),
                createInstruction(Opcode.Integer, 20, rDest),
				createInstruction(Opcode.Move, rSrc, rDest, 0),
			]);
            const { runtime, finalStatus } = await runTestProgram(db, program, 3);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rSrc)).to.equal(10);
            expect(runtime.getMem(rDest)).to.equal(20); // Unchanged
        });

        it('should handle overlapping Move correctly (dest > src)', async () => {
            const rBase = 2;
            const program = createTestProgram(db, [
                createInstruction(Opcode.Integer, 1, rBase),
                createInstruction(Opcode.Integer, 2, rBase + 1),
                createInstruction(Opcode.Integer, 3, rBase + 2),
				createInstruction(Opcode.Move, rBase, rBase + 1, 2), // Move R[2],R[3] to R[3],R[4]
			]);
             const { runtime, finalStatus } = await runTestProgram(db, program, 4);
             expect(finalStatus).to.equal(StatusCode.OK);
             expect(runtime.getMem(rBase)).to.equal(1); // Unchanged
             expect(runtime.getMem(rBase + 1)).to.equal(1); // Moved from R[2]
             expect(runtime.getMem(rBase + 2)).to.equal(2); // Moved from R[3]
        });

        it('should handle overlapping Move correctly (src > dest)', async () => {
            const rBase = 2;
            const program = createTestProgram(db, [
                createInstruction(Opcode.Integer, 1, rBase + 1),
                createInstruction(Opcode.Integer, 2, rBase + 2),
                createInstruction(Opcode.Integer, 3, rBase + 3),
				createInstruction(Opcode.Move, rBase + 1, rBase, 2), // Move R[3],R[4] to R[2],R[3]
			]);
             const { runtime, finalStatus } = await runTestProgram(db, program, 4);
             expect(finalStatus).to.equal(StatusCode.OK);
             expect(runtime.getMem(rBase)).to.equal(1); // Moved from R[3]
             expect(runtime.getMem(rBase + 1)).to.equal(2); // Moved from R[4]
             expect(runtime.getMem(rBase + 2)).to.equal(2); // Unchanged original R[4]
        });
    });

    describe('Opcode.Clear', () => {
        // Clear <startReg> <count>
        it('should set registers to NULL', async () => {
            const rStart = 2;
            const count = 3;
            const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 10, rStart),
                createInstruction(Opcode.Integer, 20, rStart + 1),
                createInstruction(Opcode.Integer, 30, rStart + 2),
                createInstruction(Opcode.Integer, 40, rStart + 3), // Should remain untouched
				createInstruction(Opcode.Clear, rStart, count),
			]);
            const { runtime, finalStatus } = await runTestProgram(db, program, 5);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rStart)).to.be.null;
            expect(runtime.getMem(rStart + 1)).to.be.null;
            expect(runtime.getMem(rStart + 2)).to.be.null;
            expect(runtime.getMem(rStart + 3)).to.equal(40); // Verify register after range is ok
        });

         it('should handle Clear with count 0 (no-op)', async () => {
             const rStart = 2;
             const program = createTestProgram(db, [
                createInstruction(Opcode.Integer, 10, rStart),
				createInstruction(Opcode.Clear, rStart, 0),
			]);
            const { runtime, finalStatus } = await runTestProgram(db, program, 2);
            expect(finalStatus).to.equal(StatusCode.OK);
            expect(runtime.getMem(rStart)).to.equal(10); // Unchanged
        });
    });

    // --- Bitwise Opcodes ---
    // Note: These operate on BigInts

    describe('Opcode.BitAnd', () => {
        const rLeft = 2;
		const rRight = 3;
		const rDest = 4;

        it('should perform bitwise AND', async () => {
            const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 6, rLeft), // 0110
				createInstruction(Opcode.Integer, 12, rRight),// 1100
				createInstruction(Opcode.BitAnd, rLeft, rRight, rDest), // 0100 = 4
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(BigInt(4));
        });

        it('should return NULL if an operand is NULL', async () => {
            const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 6, rLeft),
				createInstruction(Opcode.Null, 0, rRight),
				createInstruction(Opcode.BitAnd, rLeft, rRight, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null;
        });
    });

     describe('Opcode.BitOr', () => {
        const rLeft = 2;
		const rRight = 3;
		const rDest = 4;

        it('should perform bitwise OR', async () => {
            const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 6, rLeft), // 0110
				createInstruction(Opcode.Integer, 12, rRight),// 1100
				createInstruction(Opcode.BitOr, rLeft, rRight, rDest), // 1110 = 14
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(BigInt(14));
        });
     });

     describe('Opcode.ShiftLeft', () => {
        // ShiftLeft <amountReg> <valueReg> <destReg>
        const rAmount = 2;
		const rValue = 3;
		const rDest = 4;

        it('should perform bitwise left shift', async () => {
            const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 2, rAmount),
				createInstruction(Opcode.Integer, 5, rValue), // 0101
				createInstruction(Opcode.ShiftLeft, rAmount, rValue, rDest), // 010100 = 20
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(BigInt(20));
        });
     });

    describe('Opcode.ShiftRight', () => {
        // ShiftRight <amountReg> <valueReg> <destReg>
        const rAmount = 2;
		const rValue = 3;
		const rDest = 4;

        it('should perform bitwise right shift', async () => {
            const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 2, rAmount),
				createInstruction(Opcode.Integer, 20, rValue), // 10100
				createInstruction(Opcode.ShiftRight, rAmount, rValue, rDest), // 00101 = 5
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 3);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(BigInt(5));
        });
     });

    describe('Opcode.BitNot', () => {
        // BitNot <sourceReg> <destReg>
        const rSrc = 2;
        const rDest = 3;

        it('should perform bitwise NOT (~)', async () => {
             const program = createTestProgram(db, [
				createInstruction(Opcode.Integer, 5, rSrc), // 0101
				createInstruction(Opcode.BitNot, rSrc, rDest), // ...11111010 = -6
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 2);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.equal(BigInt(-6));
        });

        it('should return NULL if operand is NULL', async () => {
            const program = createTestProgram(db, [
				createInstruction(Opcode.Null, 0, rSrc),
				createInstruction(Opcode.BitNot, rSrc, rDest),
			]);
			const { runtime, finalStatus } = await runTestProgram(db, program, 2);
			expect(finalStatus).to.equal(StatusCode.OK);
			expect(runtime.getMem(rDest)).to.be.null;
        });
    });
});
