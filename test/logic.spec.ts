import { expect } from 'aegir/chai';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../src/core/database'; // Adjust path as needed
import { SqliteError, ParseError } from '../src/common/errors';
import { StatusCode } from '../src/common/types';
import { Parser } from '../src/parser/parser';
import { Compiler } from '../src/compiler/compiler';
import type * as AST from '../src/parser/ast';
import type { VdbeInstruction } from '../src/vdbe/instruction';
import { Opcode } from '../src/vdbe/opcodes'; // <-- ADD Opcode enum import

const logicTestDir = path.join(__dirname, 'logic');

// --- Helper Function to Format AST ---
function formatAst(ast: AST.AstNode): string {
	try {
		// Use JSON.stringify for a readable AST representation
		// Replace circular references (like potential parent pointers if added later)
		const cache = new Set();
		return JSON.stringify(ast, (key, value) => {
			if (typeof value === 'object' && value !== null) {
				if (cache.has(value)) {
					// Circular reference found, discard key
					return '[Circular]';
				}
				// Store value in our collection
				cache.add(value);
			}
			return value;
		}, 2);
	} catch (e: any) {
		return `Error formatting AST: ${e.message}`;
	}
}

// --- Helper Function to Format VDBE Instructions ---
function formatVdbe(instructions: ReadonlyArray<VdbeInstruction>): string {
	try {
		return instructions.map((inst, i) => {
			let p4Str = '';
			if (inst.p4) {
				try {
					// Attempt simple stringification for P4, handle potential errors
					if (inst.p4 && typeof inst.p4 === 'object' && 'type' in inst.p4) {
						p4Str = `P4(${inst.p4.type})`; // Show type for complex P4
					} else {
						p4Str = JSON.stringify(inst.p4);
					}
				} catch { p4Str = '[Unserializable P4]'; }
			}
			// Convert Opcode number to string name before padding
			const opcodeName = Opcode[inst.opcode] || 'UNKNOWN_OPCODE';
			return `[${i.toString().padStart(3)}] ${opcodeName.padEnd(15)} ${inst.p1}\t${inst.p2}\t${inst.p3}\t${p4Str} ${inst.p5 > 0 ? `#${inst.p5}` : ''} ${inst.comment ? `// ${inst.comment}` : ''}`;
		}).join('\n');
	} catch (e: any) {
		return `Error formatting VDBE: ${e.message}`;
	}
}

describe('SQL Logic Tests', () => {
	const files = fs.readdirSync(logicTestDir)
		.filter(file => file.endsWith('.sqllogic'));

	for (const file of files) {
		const filePath = path.join(logicTestDir, file);
		const content = fs.readFileSync(filePath, 'utf-8');

		describe(`File: ${file}`, () => {
			let db: Database;

			beforeEach(() => {
				db = new Database();
			});

			afterEach(async () => {
				await db.close();
			});

			it('should execute statements and match results or expected errors', async () => {
				const lines = content.split(/\r?\n/);
				let currentSql = '';
				let expectedResultJson: string | null = null;
				let expectedErrorSubstring: string | null = null; // <-- Store expected error
				let lineNumber = 0;

				for (const line of lines) {
					lineNumber++;
					const trimmedLine = line.trim();

					if (trimmedLine === '') continue; // Skip empty lines

					// Check for comments, including error expectation
					if (trimmedLine.startsWith('--')) {
						if (trimmedLine.toLowerCase().startsWith('-- error:')) {
							expectedErrorSubstring = trimmedLine.substring(9).trim();
						}
						continue; // Skip comment lines
					}

					// Process results marker (→) or accumulate SQL
					if (trimmedLine.startsWith('→')) {
						expectedResultJson = trimmedLine.substring(1).trim();
					} else {
						currentSql += line + '\n';
					}

					// Execute when we have a full SQL block AND either an expected result or expected error
					const sqlToRun = currentSql.trim();
					if (sqlToRun && (expectedResultJson !== null || expectedErrorSubstring !== null)) {

						if (expectedResultJson !== null && expectedErrorSubstring !== null) {
							throw new Error(`[${file}:${lineNumber}] Cannot expect both a result and an error for the same SQL block.`);
						}

						try {
							if (expectedResultJson !== null) {
								// --- Handle Expected Result ---
								console.log(`Executing (expect results): ${sqlToRun}`);
								const actualResult: Record<string, any>[] = [];
								for await (const row of db.eval(sqlToRun)) {
									actualResult.push(row);
								}
								let expectedResult: any;
								try {
									expectedResult = JSON.parse(expectedResultJson);
								} catch (jsonError: any) {
									throw new Error(`[${file}:${lineNumber}] Invalid expected JSON: ${jsonError.message} - JSON: ${expectedResultJson}`);
								}
								expect(actualResult).to.deep.equal(expectedResult, `[${file}:${lineNumber}] SQL: ${sqlToRun}`);
							} else if (expectedErrorSubstring !== null) {
								// --- Handle Expected Error ---
								console.log(`Executing (expect error "${expectedErrorSubstring}"): ${sqlToRun}`);
								try {
									// Attempt execution - we expect this to throw
									// Need to decide if SELECT errors come from prepare or step. `exec` covers both.
									await db.exec(sqlToRun);
									// If exec completes without error, it's a test failure
									throw new Error(`[${file}:${lineNumber}] Expected error matching "${expectedErrorSubstring}" but SQL executed successfully.\nSQL: ${sqlToRun}`);
								} catch (actualError: any) {
									// Check if the actual error message includes the expected substring (case-insensitive)
									expect(actualError.message.toLowerCase()).to.include(expectedErrorSubstring.toLowerCase(),
										`[${file}:${lineNumber}] SQL: ${sqlToRun}\nExpected error containing: "${expectedErrorSubstring}"\nActual error: "${actualError.message}"`
									);
									console.log(`   -> Caught expected error: ${actualError.message}`);
								}
							}
						} catch (error: any) {
							// Handle unexpected errors during execution or assertion
							if (expectedErrorSubstring !== null && error.message.includes('Expected error matching')) {
								// This is the failure case where we expected an error but didn't get one.
								throw error; // Rethrow the assertion failure
							}
							// Otherwise, it's an unexpected runtime error, dump diagnostics
							let diagnosticInfo = '';
							try {
								const parser = new Parser(); const ast = parser.parse(sqlToRun);
								diagnosticInfo += `\n\n--- AST ---\n${formatAst(ast)}`;
								try {
									const compiler = new Compiler(db); const program = compiler.compile(ast, sqlToRun);
									diagnosticInfo += `\n\n--- VDBE ---\n${formatVdbe(program.instructions)}`;
								} catch (compileError: any) { diagnosticInfo += `\n\n--- VDBE (Compilation Error) ---\n${compileError.message}`; }
							} catch (parseError: any) {
								if (parseError instanceof ParseError) { diagnosticInfo += `\n\n--- AST (Parse Error) ---\n${parseError.message}`; }
								else { diagnosticInfo += `\n\n--- AST (Unknown Parsing Error) ---\n${parseError.message}`; }
							}
							throw new Error(`[${file}:${lineNumber}] Failed executing SQL: ${sqlToRun} - Unexpected Error: ${error.message}${diagnosticInfo}`);
						}

						// Reset for the next block
						currentSql = '';
						expectedResultJson = null;
						expectedErrorSubstring = null;
					}
				}

				// Process any remaining SQL at the end of the file (that doesn't expect results or errors)
				const finalSql = currentSql.trim();
				if (finalSql) {
					if (expectedErrorSubstring !== null || expectedResultJson !== null) {
						// This shouldn't happen if logic is correct, but check anyway
						console.warn(`[${file}] Dangling SQL block at end of file with expectation: ${finalSql}`);
					}
					try {
						console.log(`Executing (final, no results expected): ${finalSql}`);
						await db.exec(finalSql);
					} catch (error: any) {
						// If the final block was actually expected to error, this catch is wrong.
						// The loop structure assumes errors/results are declared *before* the SQL.
						throw new Error(`[${file}:${lineNumber}] Failed executing final SQL: ${finalSql} - Error: ${error.message}`);
					}
				}
			});
		});
	}
});
