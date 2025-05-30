import { expect, chai } from 'aegir/chai';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/core/database.js';
import { QuereusError } from '../src/common/errors.js';
import { safeJsonStringify } from '../src/util/serialization.js';
import { CollectingInstructionTracer } from '../src/runtime/types.js';

chai.config.truncateThreshold = 1000;
chai.config.includeStack = true;

// ESM equivalent for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Determine project root - if we're in dist/test, go up two levels, otherwise just one
const isInDist = __dirname.includes(path.join('dist', 'test'));
const projectRoot = isInDist ? path.resolve(__dirname, '..', '..') : path.resolve(__dirname, '..');
const logicTestDir = path.join(projectRoot, 'test', 'logic');

// Diagnostic configuration from environment variables
const DIAG_CONFIG = {
	showPlan: process.env.QUEREUS_TEST_SHOW_PLAN === 'true',
	showProgram: process.env.QUEREUS_TEST_SHOW_PROGRAM === 'true',
	showStack: process.env.QUEREUS_TEST_SHOW_STACK === 'true',
	showTrace: process.env.QUEREUS_TEST_SHOW_TRACE === 'true'
};

/**
 * Generates configurable diagnostic information for failed tests.
 *
 * Environment variables to control output:
 * - QUEREUS_TEST_SHOW_PLAN=true     : Include query plan in diagnostics
 * - QUEREUS_TEST_SHOW_PROGRAM=true  : Include instruction program in diagnostics
 * - QUEREUS_TEST_SHOW_STACK=true    : Include full stack trace in diagnostics
 * - QUEREUS_TEST_SHOW_TRACE=true    : Include execution trace in diagnostics
 */
function generateDiagnostics(db: Database, sqlBlock: string, error: Error): string {
	const diagnostics = ['\n=== FAILURE DIAGNOSTICS ==='];

	// Show configuration hint if no diagnostics are enabled
	const anyDiagEnabled = Object.values(DIAG_CONFIG).some(v => v);
	if (!anyDiagEnabled) {
		diagnostics.push('\nFor more detailed diagnostics, set environment variables:');
		diagnostics.push('  QUEREUS_TEST_SHOW_PLAN=true     - Show query plan');
		diagnostics.push('  QUEREUS_TEST_SHOW_PROGRAM=true  - Show instruction program');
		diagnostics.push('  QUEREUS_TEST_SHOW_STACK=true    - Show full stack trace');
		diagnostics.push('  QUEREUS_TEST_SHOW_TRACE=true    - Show execution trace');
	}

	try {
		const statements = sqlBlock.split(';').map(s => s.trim()).filter(s => s.length > 0);
		const lastStatement = statements[statements.length - 1];

		if (lastStatement && DIAG_CONFIG.showPlan) {
			diagnostics.push('\nQUERY PLAN:');
			try {
				const plan = db.getDebugPlan(lastStatement);
				diagnostics.push(plan);
			} catch (planError: any) {
				diagnostics.push(`Plan generation failed: ${planError.message || planError}`);
			}
		}

		if (lastStatement && DIAG_CONFIG.showProgram) {
			diagnostics.push('\nINSTRUCTION PROGRAM:');
			try {
				const stmt = db.prepare(lastStatement);
				const program = stmt.getDebugProgram();
				diagnostics.push(program);
				stmt.finalize().catch(() => {}); // Silent cleanup
			} catch (programError: any) {
				diagnostics.push(`Program generation failed: ${programError.message || programError}`);
			}
		}

		if (DIAG_CONFIG.showStack && error.stack) {
			diagnostics.push('\nSTACK TRACE:');
			diagnostics.push(error.stack);
		}

	} catch (diagError: any) {
		diagnostics.push(`\nDiagnostic generation failed: ${diagError.message || diagError}`);
	}

	diagnostics.push('=== END DIAGNOSTICS ===\n');
	return diagnostics.join('\n');
}

/**
 * Executes a query with tracing and returns results plus trace information
 */
async function executeWithTracing(db: Database, sql: string, params?: any[]): Promise<{
	results: any[],
	traceEvents: any[]
}> {
	const tracer = new CollectingInstructionTracer();
	const results: any[] = [];

	try {
		const stmt = db.prepare(sql);
		if (params) {
			stmt.bindAll(params);
		}

		for await (const row of stmt.iterateRowsWithTrace(undefined, tracer)) {
			// Convert row array to object using column names
			const columnNames = stmt.getColumnNames();

			// For single-column results, check if it's a simple expression that should use array format
			if (columnNames.length === 1) {
				const columnName = columnNames[0].toLowerCase();

				// Simple expressions that use array format [value]:
				// 1. IS NOT NULL / IS NULL expressions (standalone, not part of complex expressions)
				// 2. Simple arithmetic (contains - but not complex boolean operators)
				// 3. Specific function calls that use simple format (JSON, date/time functions)
				const isSimpleExpression =
					// Standalone IS NULL expressions (not part of XOR, AND, OR expressions)
					(columnName.endsWith(' is not null') || columnName.endsWith(' is null')) &&
					!columnName.includes(' xor ') && !columnName.includes(' and ') && !columnName.includes(' or ') ||
					// Simple arithmetic like "julianday('2024-01-01') - julianday('2023-01-01')"
					(columnName.includes(' - ') && !columnName.includes(' and ') && !columnName.includes(' or ') && !columnName.includes(' xor ')) ||
					// Specific function calls that use simple format (JSON and date/time functions mainly)
					(/^(json_extract|json_array_length|json_array|json_object|json_insert|json_replace|json_set|json_remove|strftime|julianday|date|time|datetime)\(.+\)$/.test(columnName));

				if (isSimpleExpression) {
					// Simple value format for simple expressions
					results.push(row[0]);
				} else {
					// Object format for complex expressions, column references, etc.
					const rowObject = row.reduce((obj, val, idx) => {
						obj[columnNames[idx] || `col_${idx}`] = val;
						return obj;
					}, {} as Record<string, any>);
					results.push(rowObject);
				}
			} else {
				// Multi-column results always use object format
				const rowObject = row.reduce((obj, val, idx) => {
					obj[columnNames[idx] || `col_${idx}`] = val;
					return obj;
				}, {} as Record<string, any>);
				results.push(rowObject);
			}
		}

		await stmt.finalize();
	} catch (error: any) {
		// Re-throw with optional trace information
		let errorMsg = error.message || String(error);
		if (DIAG_CONFIG.showTrace) {
			errorMsg += `\n\nEXECUTION TRACE:\n${formatTraceEvents(tracer.getTraceEvents())}`;
		}
		const enhancedError = new Error(errorMsg);
		enhancedError.stack = error.stack;
		throw enhancedError;
	}

	return {
		results,
		traceEvents: tracer.getTraceEvents()
	};
}

/**
 * Formats trace events for readable output
 */
function formatTraceEvents(events: any[]): string {
	if (events.length === 0) return 'No trace events captured.';

	const lines = ['Instruction Execution Trace:'];
	for (const event of events) {
		const note = event.note ? ` (${event.note})` : '';
		const timestamp = new Date(event.timestamp).toISOString();

		if (event.type === 'input') {
			lines.push(`[${event.instructionIndex}] INPUT${note} at ${timestamp}: ${safeJsonStringify(event.args)}`);
		} else if (event.type === 'output') {
			lines.push(`[${event.instructionIndex}] OUTPUT${note} at ${timestamp}: ${safeJsonStringify(event.result)}`);
		} else if (event.type === 'error') {
			lines.push(`[${event.instructionIndex}] ERROR${note} at ${timestamp}: ${event.error}`);
		}
	}
	return lines.join('\n');
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
										const statement = statements[i].trim();
										if (statement.length > 0) {
											console.log(`  -> Executing setup statement: ${statement}`);
											await db.exec(statement); // exec is for side-effects
										}
									}
								}

								const lastStatement = statements[statements.length - 1];
								console.log(`  -> Executing final statement (with tracing): ${lastStatement}`);

								let executionResult: { results: Record<string, any>[], traceEvents: any[] };
								if (lastStatement) {
									executionResult = await executeWithTracing(db, lastStatement);
								} else {
									executionResult = { results: [], traceEvents: [] };
								}

								const actualResult = executionResult.results;

								let expectedResult: any;
								try {
									expectedResult = JSON.parse(expectedResultJson);
								} catch (jsonError: any) {
									throw new Error(`[${file}:${lineNumber}] Invalid expected JSON: ${jsonError.message} - JSON: ${expectedResultJson}`);
								}

								if (actualResult.length !== expectedResult.length) {
									const baseError = new Error(`[${file}:${lineNumber}] Row count mismatch. Expected ${expectedResult.length}, got ${actualResult.length}\nBlock:\n${sqlBlock}`);
									const diagnostics = generateDiagnostics(db, sqlBlock, baseError);
									const traceInfo = DIAG_CONFIG.showTrace ? `\nEXECUTION TRACE:\n${formatTraceEvents(executionResult.traceEvents)}` : '';
									throw new Error(`${baseError.message}${diagnostics}${traceInfo}`);
								}
								for (let i = 0; i < actualResult.length; i++) {
									try {
										expect(actualResult[i]).to.deep.equal(expectedResult[i], `[${file}:${lineNumber}] row ${i} mismatch.\nActual: ${safeJsonStringify(actualResult[i])}\nExpected: ${safeJsonStringify(expectedResult[i])}\nBlock:\n${sqlBlock}`);
									} catch (matchError: any) {
										const error = matchError instanceof Error ? matchError : new Error(String(matchError));
										const diagnostics = generateDiagnostics(db, sqlBlock, error);
										const traceInfo = DIAG_CONFIG.showTrace ? `\nEXECUTION TRACE:\n${formatTraceEvents(executionResult.traceEvents)}` : '';
										throw new Error(`${error.message}${diagnostics}${traceInfo}`);
									}
								}
								console.log("   -> Results match!");

							} else if (expectedErrorSubstring !== null) {
								console.log(`Executing block (expect error "${expectedErrorSubstring}"):\n${sqlBlock}`);
								try {
									await db.exec(sqlBlock);
									const baseError = new Error(`[${file}:${lineNumber}] Expected error matching "${expectedErrorSubstring}" but SQL block executed successfully.\nBlock: ${sqlBlock}`);
									const diagnostics = generateDiagnostics(db, sqlBlock, baseError);
									throw new Error(`${baseError.message}${diagnostics}`);
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
								// Check if error already contains diagnostics to avoid duplication
								if (error.message.includes('=== FAILURE DIAGNOSTICS ===')) {
									// Error already has diagnostics, just re-throw
									throw error;
								} else {
									// Add diagnostics to the error
									const diagnostics = generateDiagnostics(db, sqlBlock, error);
									throw new Error(`[${file}:${lineNumber}] Failed executing SQL block: ${sqlBlock} - Unexpected Error: ${error.message}${diagnostics}`);
								}
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
						const baseError = new Error(`[${file}:${lineNumber}] Failed executing final SQL: ${finalSql} - Error: ${error.message}`);
						const diagnostics = generateDiagnostics(db, finalSql, baseError);
						throw new Error(`${baseError.message}${diagnostics}`);
					}
				}
			});
		});
	}
});
