import { expect } from 'aegir/chai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/core/database.js';
import { ParseError, QuereusError } from '../src/common/errors.js';
import { safeJsonStringify } from '../src/util/serialization.js';

// ESM equivalent for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine project root - if we're in dist/test, go up two levels, otherwise just one
const isInDist = __dirname.includes(path.join('dist', 'test'));
const projectRoot = isInDist ? path.resolve(__dirname, '..', '..') : path.resolve(__dirname, '..');
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

					// Check for full-line comments, including error expectation
					if (trimmedLine.startsWith('--')) {
						if (trimmedLine.toLowerCase().startsWith('-- error:')) {
							expectedErrorSubstring = trimmedLine.substring(9).trim();
						}
						continue; // Skip full comment lines
					}

					// --- Refined Comment/SQL Handling ---
					let sqlPart = line;

					// Check for result marker first
					if (trimmedLine.startsWith('→')) {
						expectedResultJson = trimmedLine.substring(1).trim();
						sqlPart = ''; // Line with marker doesn't contribute SQL
					}

					// Strip trailing comment from the potential SQL part
					const commentIndex = sqlPart.indexOf('--');
					if (commentIndex !== -1) {
						sqlPart = sqlPart.substring(0, commentIndex);
					}

					// Accumulate the potentially stripped SQL part
					if (sqlPart.trim() !== '') {
						currentSql += sqlPart + '\n';
					}
					// --- End Refined Handling ---

					// Execute when we have a full SQL block AND either an expected result or expected error
					const sqlBlock = currentSql.trim(); // Keep sqlBlock variable
					if (sqlBlock && (expectedResultJson !== null || expectedErrorSubstring !== null)) {

						if (expectedResultJson !== null && expectedErrorSubstring !== null) {
							throw new Error(`[${file}:${lineNumber}] Cannot expect both a result and an error for the same SQL block.`);
						}

						try {
							if (expectedResultJson !== null) {
								console.log(`Executing block (expect results):\n${sqlBlock}`);

								// db.eval now handles parsing the whole sqlBlock.
								// If sqlBlock has multiple statements, db.eval will execute the first one
								// and is intended for single result-producing queries.
								// For logic tests with setup statements, we need to ensure setup is run first.

								const statements = sqlBlock.split(';').map(s => s.trim()).filter(s => s.length > 0);
								if (statements.length > 1) {
									for (let i = 0; i < statements.length - 1; i++) {
										console.log(`  -> Executing setup statement: ${statements[i]}`);
										await db.exec(statements[i]); // exec is for side-effects
									}
								}

								const lastStatement = statements[statements.length - 1];
								const actualResult: Record<string, any>[] = [];
								console.log(`  -> Executing final statement (eval): ${lastStatement}`);
								if (lastStatement) {
									for await (const row of db.eval(lastStatement)) {
										actualResult.push(row);
									}
								}

								let expectedResult: any;
								try {
									expectedResult = JSON.parse(expectedResultJson);
								} catch (jsonError: any) {
									throw new Error(`[${file}:${lineNumber}] Invalid expected JSON: ${jsonError.message} - JSON: ${expectedResultJson}`);
								}

								if (actualResult.length !== expectedResult.length) {
									throw new Error(`[${file}:${lineNumber}] Row count mismatch. Expected ${expectedResult.length}, got ${actualResult.length}. Block:\n${sqlBlock}`);
								}
								for (let i = 0; i < actualResult.length; i++) {
									expect(actualResult[i]).to.deep.equal(expectedResult[i], `[${file}:${lineNumber}] row ${i} mismatch.\nActual: ${safeJsonStringify(actualResult[i])}\nExpected: ${safeJsonStringify(expectedResult[i])}\nBlock:\n${sqlBlock}`);
								}
								console.log("   -> Results match!");

							} else if (expectedErrorSubstring !== null) {
								console.log(`Executing block (expect error "${expectedErrorSubstring}"):\n${sqlBlock}`);
								try {
									await db.exec(sqlBlock);
									throw new Error(`[${file}:${lineNumber}] Expected error matching "${expectedErrorSubstring}" but SQL block executed successfully.\nBlock: ${sqlBlock}`);
								} catch (actualError: any) {
									expect(actualError.message.toLowerCase()).to.include(expectedErrorSubstring.toLowerCase(),
										`[${file}:${lineNumber}] Block: ${sqlBlock}\nExpected error containing: "${expectedErrorSubstring}"\nActual error: "${actualError.message}"`
									);
									console.log(`   -> Caught expected error: ${actualError.message}`);
								}
							}
						} catch (error: any) {
							if (expectedErrorSubstring !== null && error instanceof QuereusError) { // Check if QuereusError for more consistent error source
								expect(error.message.toLowerCase()).to.include(expectedErrorSubstring.toLowerCase(),
									`[${file}:${lineNumber}] Block: ${sqlBlock}\nExpected error containing: "${expectedErrorSubstring}"\nActual error: "${error.message}"`
								);
								console.log(`   -> Caught expected error: ${error.message}`);
							} else {
								let diagnosticInfo = '';
								// TODO: Add Query Plan diagnostics once db.getPlanInfo is re-implemented for the new runtime
								// VDBE dump is removed as it's for the old runtime.
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
