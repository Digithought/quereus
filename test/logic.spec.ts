import { expect } from 'aegir/chai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/core/database.js';
import { ParseError } from '../src/common/errors.js';
import { Parser } from '../src/parser/parser.js';
import type * as AST from '../src/parser/ast.js';
import type { VdbeInstruction } from '../src/vdbe/instruction.js';
import { Opcode } from '../src/vdbe/opcodes.js';
import { jsonStringify, safeJsonStringify } from '../src/util/serialization.js';

// ESM equivalent for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename); // This will be C:\...\dist\test when running compiled code

// Adjust path to point to the source logic directory relative to the project root
// Go up two levels from __dirname (dist/test -> project root) then down to test/logic
const projectRoot = path.resolve(__dirname, '..', '..');
const logicTestDir = path.join(projectRoot, 'test', 'logic');

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
						p4Str = jsonStringify(inst.p4);
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
					const sqlBlock = currentSql.trim(); // Keep sqlBlock variable
					if (sqlBlock && (expectedResultJson !== null || expectedErrorSubstring !== null)) {

						if (expectedResultJson !== null && expectedErrorSubstring !== null) {
							throw new Error(`[${file}:${lineNumber}] Cannot expect both a result and an error for the same SQL block.`);
						}

						try {
							if (expectedResultJson !== null) {
								// --- Handle Expected Result (Potentially Multi-Statement) ---
								console.log(`Executing block (expect results):\n${sqlBlock}`);
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
								expect(actualResult).to.deep.equal(expectedResult, `[${file}:${lineNumber}] Block: ${sqlBlock}`);
								console.log("   -> Results match!");
							} else if (expectedErrorSubstring !== null) {
								// --- Handle Expected Error (Multi-statement ok via db.exec) ---
								console.log(`Executing block (expect error "${expectedErrorSubstring}"):\n${sqlBlock}`);
								try {
									await db.exec(sqlBlock); // Use db.exec directly
									throw new Error(`[${file}:${lineNumber}] Expected error matching "${expectedErrorSubstring}" but SQL block executed successfully.\nBlock: ${sqlBlock}`);
								} catch (actualError: any) {
									expect(actualError.message.toLowerCase()).to.include(expectedErrorSubstring.toLowerCase(),
										`[${file}:${lineNumber}] Block: ${sqlBlock}\nExpected error containing: "${expectedErrorSubstring}"\nActual error: "${actualError.message}"`
									);
									console.log(`   -> Caught expected error: ${actualError.message}`);
								}
							}
						} catch (error: any) {
							// Handle unexpected errors - Check if an error was expected FIRST
							if (expectedErrorSubstring !== null) {
								// Error occurred, and we expected one. Check if it matches.
								expect(error.message.toLowerCase()).to.include(expectedErrorSubstring.toLowerCase(),
									`[${file}:${lineNumber}] Block: ${sqlBlock}\nExpected error containing: "${expectedErrorSubstring}"\nActual error: "${error.message}"`
								);
								console.log(`   -> Caught expected error: ${error.message}`);
								// Error was expected and matched, proceed normally
							} else {
								// Error occurred, but we did NOT expect one (or expected a specific non-matching one).
								// OR it's the specific assertion failure from the error handling block above.
								if (error.message.includes('Expected error matching')) {
									throw error; // Rethrow assertion failure
								}
								// Unexpected runtime error, dump diagnostics
								let diagnosticInfo = '';
								try {
									const parser = new Parser();
									// Try parsing the block that caused the error
									const statementsAst = parser.parseAll(sqlBlock);
//									diagnosticInfo += `\n\n--- AST (Full Block, ${statementsAst.length} stmts) ---`;
//									statementsAst.forEach((ast, idx) => {
//										diagnosticInfo += `\n--- Stmt ${idx + 1} ---\n${formatAst(ast)}`;
//									});
									// Maybe try compiling the first failing statement? Too complex here.
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
