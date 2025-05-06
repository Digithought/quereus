import { expect } from 'aegir/chai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/core/database.js';
import { ParseError } from '../src/common/errors.js';
import { Parser } from '../src/parser/parser.js';
import { Compiler } from '../src/compiler/compiler.js';
import type { VdbeInstruction } from '../src/vdbe/instruction.js';
import { Opcode } from '../src/vdbe/opcodes.js';
import { safeJsonStringify } from '../src/util/serialization.js';

// ESM equivalent for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); // This will be C:\...\dist\test when running compiled code

// Adjust path to point to the source logic directory relative to the project root
// Go up two levels from __dirname (dist/test -> project root) then down to test/logic
const projectRoot = path.resolve(__dirname, '..', '..');
const logicTestDir = path.join(projectRoot, 'test', 'logic');

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
					const sqlBlock = currentSql.trim(); // Keep sqlBlock variable
					if (sqlBlock && (expectedResultJson !== null || expectedErrorSubstring !== null)) {

						if (expectedResultJson !== null && expectedErrorSubstring !== null) {
							throw new Error(`[${file}:${lineNumber}] Cannot expect both a result and an error for the same SQL block.`);
						}

						try {
							if (expectedResultJson !== null) {
								// --- REVERTED: Handle Expected Result (Split execution) --- //
								console.log(`Executing block (expect results):
${sqlBlock}`);
								// Split statements
								const statements = sqlBlock.split(';').map(s => s.trim()).filter(s => s.length > 0);
								const lastStatementIndex = statements.length - 1;

								// Execute all but the last statement using exec
								for (let i = 0; i < lastStatementIndex; i++) {
									console.log(`  -> Executing setup statement: ${statements[i]}`);
									await db.exec(statements[i]);
								}

								// Execute the last statement using eval and collect results
								const lastStatement = statements[lastStatementIndex];
								console.log(`  -> Executing final statement (eval): ${lastStatement}`);
								const actualResult: Record<string, any>[] = [];
								if (lastStatement) { // Ensure there is a last statement
									for await (const row of db.eval(lastStatement)) {
										actualResult.push(row);
									}
								}

								// Compare results
								let expectedResult: any;
								try {
									expectedResult = JSON.parse(expectedResultJson);
								} catch (jsonError: any) {
									throw new Error(`[${file}:${lineNumber}] Invalid expected JSON: ${jsonError.message} - JSON: ${expectedResultJson}`);
								}

								// Explicit row count check before detailed comparison
								if (actualResult.length !== expectedResult.length) {
									throw new Error(`[${file}:${lineNumber}] Row count mismatch. Expected ${expectedResult.length}, got ${actualResult.length}. Block:\n${sqlBlock}`);
								}
								// Compare row by row using stringify
								for (let i = 0; i < actualResult.length; i++) {
									const actualStr = JSON.stringify(actualResult[i]);
									const expectedStr = JSON.stringify(expectedResult[i]);
									expect(actualStr).to.equal(expectedStr, `[${file}:${lineNumber}] row ${i} mismatch.\nActual: ${actualStr}\nExpected: ${expectedStr}\nBlock:\n${sqlBlock}`);
								}
								console.log("   -> Results match!");
							} else if (expectedErrorSubstring !== null) {
								// --- Handle Expected Error (Unchanged) ---
								console.log(`Executing block (expect error "${expectedErrorSubstring}"):
${sqlBlock}`);
								try {
									await db.exec(sqlBlock); // Use db.exec directly
									throw new Error(`[${file}:${lineNumber}] Expected error matching "${expectedErrorSubstring}" but SQL block executed successfully.
Block: ${sqlBlock}`);
								} catch (actualError: any) {
									expect(actualError.message.toLowerCase()).to.include(expectedErrorSubstring.toLowerCase(),
										`[${file}:${lineNumber}] Block: ${sqlBlock}
Expected error containing: "${expectedErrorSubstring}"
Actual error: "${actualError.message}"`
									);
									console.log(`   -> Caught expected error: ${actualError.message}`);
								}
							}
						} catch (error: any) {
							// --- Handle unexpected errors (mostly unchanged, but simplify VDBE dump) --- //
							if (expectedErrorSubstring !== null) {
								// Error occurred, and we expected one. Check if it matches.
								expect(error.message.toLowerCase()).to.include(expectedErrorSubstring.toLowerCase(),
									`[${file}:${lineNumber}] Block: ${sqlBlock}
Expected error containing: "${expectedErrorSubstring}"
Actual error: "${error.message}"`
								);
								console.log(`   -> Caught expected error: ${error.message}`);
							} else {
								// Unexpected runtime error
								let diagnosticInfo = '';
								try {
									// Add Query Plan diagnostics
									if (db && sqlBlock) {
										diagnosticInfo += `\n\n--- QUERY PLAN ---`;
										try {
											// Attempt to get plan for the *last* statement in the block
											const stmtsForPlan = sqlBlock.split(';').map(s => s.trim()).filter(s => s);
											if (stmtsForPlan.length > 0) {
												const lastStmtSql = stmtsForPlan[stmtsForPlan.length - 1];
												try {
													const planSteps = db.getPlanInfo(lastStmtSql); // Get plan for last stmt
													if (planSteps.length > 0) {
														planSteps.forEach(step => {
															// Use new fields: id, parentId (or op), op, and detail
															diagnosticInfo += `\n${step.id}|${step.parentId ?? '-'}|${step.op}| ${step.detail}`;
														});
													} else {
														diagnosticInfo += `\n(No plan info returned for last statement)`;
													}
												} catch (planError: any) {
													diagnosticInfo += `\n(Error getting plan for last stmt: ${planError.message})`;
												}
											} else {
												diagnosticInfo += `\n(Could not isolate last statement for plan)`;
											}
										} catch (planError: any) {
											diagnosticInfo += `\n(Error parsing/getting plan: ${planError.message})`;
										}
									}

									// Add VDBE Program diagnostics (Simplified: Try compiling last statement only)
									if (db && sqlBlock) {
										diagnosticInfo += `\n\n--- VDBE PROGRAM (Last Statement) ---`;
										try {
											const stmtsForVdbe = sqlBlock.split(';').map(s => s.trim()).filter(s => s);
											if (stmtsForVdbe.length > 0) {
												const lastStmtSqlVdbe = stmtsForVdbe[stmtsForVdbe.length - 1];
												try {
													const parserForVdbe = new Parser();
													const astForVdbe = parserForVdbe.parse(lastStmtSqlVdbe);
													const compilerForVdbe = new Compiler(db);
													const compiledProgram = compilerForVdbe.compile(astForVdbe, lastStmtSqlVdbe);
													// Use manual formatting again
													diagnosticInfo += compiledProgram.instructions.map((instr: VdbeInstruction, idx: number) => {
														const opcodeName = Opcode[instr.opcode] ?? 'UNKNOWN';
														let p4String = '';
														if (instr.p4 !== null && instr.p4 !== undefined) {
															if (typeof instr.p4 === 'object') {
																try { p4String = safeJsonStringify(instr.p4); } catch { p4String = '[unstringifiable]'; }
															} else {
																p4String = String(instr.p4);
															}
														}
														const comment = instr.comment ? ` # ${instr.comment}` : '';
														return `\n${idx}: ${opcodeName} ${instr.p1} ${instr.p2} ${instr.p3} ${p4String} ${instr.p5}${comment}`;
													}).join('');
												} catch (compileError: any) {
													diagnosticInfo += `\n(Error compiling last statement for VDBE dump: ${compileError.message})`;
												}
											} else {
												diagnosticInfo += `\n(Could not isolate last statement for VDBE dump)`;
											}
										} catch (compileError: any) {
											diagnosticInfo += `\n(Error parsing/compiling VDBE dump: ${compileError.message})`;
										}
									}
								} catch (parseError: any) {
									if (parseError instanceof ParseError) { diagnosticInfo += `\n\n--- AST (Parse Error) ---\n${parseError.message}`; }
									else { diagnosticInfo += `\n\n--- AST (Unknown Parsing Error) ---\n${parseError.message}`; }
								}
								throw new Error(`[${file}:${lineNumber}] Failed executing SQL block: ${sqlBlock} - Unexpected Error: ${error.message}${diagnosticInfo}`);
							}
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
