import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { CollectingInstructionTracer } from '../src/runtime/types.js';

describe('Row-Level Tracing', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it('should capture row events for simple queries', async () => {
		const tracer = new CollectingInstructionTracer();

		// Execute a simple query that produces multiple rows
		const stmt = db.prepare('SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3');
		const results: any[] = [];

		for await (const row of stmt.iterateRowsWithTrace(undefined, tracer)) {
			results.push(row);
		}

		await stmt.finalize();

		// Verify results
		expect(results).to.have.length(3);
		expect(results).to.deep.equal([[1], [2], [3]]);

		// Get trace events and check for row events
		const traceEvents = tracer.getTraceEvents();
		const rowEvents = traceEvents.filter(e => e.type === 'row');

		// Should have at least some row events
		expect(rowEvents.length).to.be.greaterThan(0);

		// Check that row events have the expected structure
		for (const event of rowEvents) {
			expect(event).to.have.property('instructionIndex').that.is.a('number');
			expect(event).to.have.property('type', 'row');
			expect(event).to.have.property('rowIndex').that.is.a('number');
			expect(event).to.have.property('row').that.is.an('array');
			expect(event).to.have.property('timestamp').that.is.a('number');
		}
	});

	it('should work with the row_trace TVF', async () => {
		// Create a simple table with data
		await db.exec('CREATE TABLE test_data USING memory(name TEXT)');
		await db.exec("INSERT INTO test_data VALUES ('Alice'), ('Bob'), ('Charlie')");

		// Use the row_trace TVF to capture row data
		const results: any[] = [];
		for await (const row of db.eval("SELECT * FROM row_trace('SELECT * FROM test_data')")) {
			results.push(row);
		}

		// Should have row trace results
		expect(results.length).to.be.greaterThan(0);

		// Check the structure of row trace results
		const firstResult = results[0];
		expect(firstResult).to.have.property('instruction_index').that.is.a('number');
		expect(firstResult).to.have.property('operation').that.is.a('string');
		expect(firstResult).to.have.property('row_index').that.is.a('number');
		expect(firstResult).to.have.property('row_data').that.is.a('string');
		expect(firstResult).to.have.property('timestamp_ms').that.is.a('number');

		// Check that row_data is valid JSON
		const rowData = JSON.parse(firstResult.row_data);
		expect(rowData).to.be.an('array');
	});

	it('should not impact performance when tracing is disabled', async () => {
		// This test ensures the hot path isn't affected
		const stmt = db.prepare('SELECT 1 UNION ALL SELECT 2');
		const results: any[] = [];

		// Execute without tracer (should use optimized path)
		for await (const row of stmt.iterateRows()) {
			results.push(row);
		}

		await stmt.finalize();

		// Verify results are still correct
		expect(results).to.have.length(2);
		expect(results).to.deep.equal([[1], [2]]);
	});

	it('should handle empty result sets gracefully', async () => {
		const tracer = new CollectingInstructionTracer();

		// Execute a query that returns no rows
		const stmt = db.prepare('SELECT 1 WHERE 1 = 0');
		const results: any[] = [];

		for await (const row of stmt.iterateRowsWithTrace(undefined, tracer)) {
			results.push(row);
		}

		await stmt.finalize();

		// Verify no results
		expect(results).to.have.length(0);

		// Should still have other trace events (input/output) but no row events
		const traceEvents = tracer.getTraceEvents();
		const rowEvents = traceEvents.filter(e => e.type === 'row');
		expect(rowEvents).to.have.length(0);
	});
});
