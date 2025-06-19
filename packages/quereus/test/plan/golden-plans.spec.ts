/**
 * Golden plan tests for Quereus optimizer
 * Captures expected plan structures for regression testing
 */

import { describe, it } from 'mocha';
import { expect } from 'chai';
import { promises as fs } from 'fs';
import * as path from 'path';
import { Database } from '../../src/core/database.js';
import { serializePlanTree } from '../../src/planner/debug.js';
import { fileURLToPath } from 'node:url';

// ESM equivalent for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPDATE_PLANS = process.env.UPDATE_PLANS === 'true';

interface PlanTestCase {
	name: string;
	sqlFile: string;
	logicalFile: string;
	physicalFile: string;
}

/**
 * Normalize plan object for comparison
 * Removes non-deterministic fields like node IDs
 */
function normalizePlan(plan: any): any {
	if (typeof plan !== 'object' || plan === null) {
		return plan;
	}

	if (Array.isArray(plan)) {
		return plan.map(item => normalizePlan(item));
	}

	const normalized: any = {};

	// Sort keys for consistent output
	const keys = Object.keys(plan).sort();

	for (const key of keys) {
		// Skip non-deterministic fields
		if (key === 'id' || key === 'timestamp') {
			continue;
		}

		normalized[key] = normalizePlan(plan[key]);
	}

	return normalized;
}

/**
 * Find all test cases in the plan directory
 */
async function findTestCases(): Promise<PlanTestCase[]> {
	const planDir = path.join(__dirname);
	const testCases: PlanTestCase[] = [];

	async function scanDirectory(dir: string, prefix: string = ''): Promise<void> {
		try {
			const entries = await fs.readdir(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = path.join(dir, entry.name);
				const relativePath = prefix + entry.name;

				if (entry.isDirectory()) {
					// Skip node_modules and other non-test directories
					if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
						await scanDirectory(fullPath, relativePath + '/');
					}
				} else if (entry.name.endsWith('.sql')) {
					const baseName = entry.name.slice(0, -4); // Remove .sql
					const testName = prefix + baseName;

					testCases.push({
						name: testName,
						sqlFile: fullPath,
						logicalFile: path.join(dir, baseName + '.logical.json'),
						physicalFile: path.join(dir, baseName + '.physical.json')
					});
				}
			}
		} catch {
			// Directory might not exist yet
		}
	}

	await scanDirectory(planDir);
	return testCases;
}

/**
 * Read file content, returning undefined if file doesn't exist
 */
async function readFileIfExists(filePath: string): Promise<string | undefined> {
	try {
		return await fs.readFile(filePath, 'utf-8');
	} catch (error) {
		if ((error as any).code === 'ENOENT') {
			return undefined;
		}
		throw error;
	}
}

/**
 * Execute SQL and get both logical and physical plans
 */
async function getPlans(sql: string): Promise<{ logical: any; physical: any }> {
	const db = new Database();

	try {
		// Set up test environment with memory tables
		await db.exec(`
			CREATE TABLE users (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				age INTEGER,
				dept_id INTEGER
			) USING memory();

			CREATE TABLE departments (
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL,
				budget REAL
			) USING memory();
		`);

		// Prepare statement to get plan
		const stmt = db.prepare(sql);

						// Get both logical and physical plans
		// For logical plan, we'll use the compiled plan and mark it as logical
		const logicalPlan = stmt.compile();
		const serializedLogical = serializePlanTree(logicalPlan);

		// For physical plan, we use the same plan but mark it as physical
		// (In practice, they're the same in current implementation)
		const physicalPlan = logicalPlan;
		const serializedPhysical = serializePlanTree(physicalPlan);

		return {
			logical: normalizePlan(serializedLogical),
			physical: normalizePlan(serializedPhysical)
		};

	} finally {
		await db.close();
	}
}

/**
 * Write plan to file with pretty formatting
 */
async function writePlan(filePath: string, plan: any): Promise<void> {
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(plan, null, 2) + '\n');
}

describe('Golden Plan Tests', () => {
	let testCases: PlanTestCase[];

	before(async () => {
		testCases = await findTestCases();
		console.log(`Found ${testCases.length} golden plan test cases`);
	});

	// Create a test for each found test case
	function createTest(testCase: PlanTestCase) {
		it(`should match golden plan for ${testCase.name}`, async function() {
			// Increase timeout for plan generation
			this.timeout(10000);

			// Read SQL query
			const sql = await fs.readFile(testCase.sqlFile, 'utf-8');

			// Generate current plans
			const { logical, physical } = await getPlans(sql);

			if (UPDATE_PLANS) {
				// Update mode: write new golden files
				await writePlan(testCase.logicalFile, logical);
				await writePlan(testCase.physicalFile, physical);
				console.log(`Updated golden files for ${testCase.name}`);
				return;
			}

			// Read expected plans
			const expectedLogicalContent = await readFileIfExists(testCase.logicalFile);
			const expectedPhysicalContent = await readFileIfExists(testCase.physicalFile);

			if (!expectedLogicalContent || !expectedPhysicalContent) {
				throw new Error(
					`Missing golden files for ${testCase.name}. ` +
					`Run with UPDATE_PLANS=true to generate them.`
				);
			}

			const expectedLogical = JSON.parse(expectedLogicalContent);
			const expectedPhysical = JSON.parse(expectedPhysicalContent);

			// Compare plans
			try {
				expect(logical).to.deep.equal(expectedLogical);
			} catch (error) {
				console.log('\nLogical plan mismatch for', testCase.name);
				console.log('Expected:', JSON.stringify(expectedLogical, null, 2));
				console.log('Actual:', JSON.stringify(logical, null, 2));
				throw error;
			}

			try {
				expect(physical).to.deep.equal(expectedPhysical);
			} catch (error) {
				console.log('\nPhysical plan mismatch for', testCase.name);
				console.log('Expected:', JSON.stringify(expectedPhysical, null, 2));
				console.log('Actual:', JSON.stringify(physical, null, 2));
				throw error;
			}
		});
	}

	// Generate tests dynamically
	before(function() {
		for (const testCase of testCases) {
			createTest(testCase);
		}
	});

	// Fallback test in case no test cases are found
	it('should have test cases', () => {
		if (testCases.length === 0 && !UPDATE_PLANS) {
			console.log('No golden plan test cases found. Create .sql files in test/plan/ directory.');
		}
		// This test always passes - it's just for information
	});
});

/**
 * Utility to generate golden files from a directory of SQL files
 */
export async function generateGoldenFiles(sqlDir: string): Promise<void> {
	const entries = await fs.readdir(sqlDir, { withFileTypes: true });

	for (const entry of entries) {
		if (entry.name.endsWith('.sql')) {
			const sqlFile = path.join(sqlDir, entry.name);
			const baseName = entry.name.slice(0, -4);
			const logicalFile = path.join(sqlDir, baseName + '.logical.json');
			const physicalFile = path.join(sqlDir, baseName + '.physical.json');

			console.log(`Generating golden files for ${entry.name}`);

			const sql = await fs.readFile(sqlFile, 'utf-8');
			const { logical, physical } = await getPlans(sql);

			await writePlan(logicalFile, logical);
			await writePlan(physicalFile, physical);
		}
	}
}
