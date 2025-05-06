// Test suite for planner join order selection
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { mockTable } from '../helpers/mocks.js';
import { compile } from '../helpers/compile.js';
import { planToString } from './utils/planToString.js';
import { SqlDataType } from '../../src/common/types.js';
import { IndexConstraintOp } from '../../src/common/constants.js';
import type { ColumnSchema } from '../../src/schema/column.js';

describe('Query Planner - Join Order', () => {
    let db: Database;

    beforeEach(() => {
        db = new Database();
    });

    it('should choose the cheaper table as the outer loop', () => {
        // 1. Setup Schemas
        const t1Cols: ColumnSchema[] = [
            { name: 'id', affinity: SqlDataType.INTEGER, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false, hidden: false },
            { name: 'data1', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false, hidden: false },
        ];
        const t1ColMap = new Map(t1Cols.map((c, i) => [c.name.toLowerCase(), i]));

        const t2Cols: ColumnSchema[] = [
            { name: 'id', affinity: SqlDataType.INTEGER, notNull: true, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false, hidden: false },
            { name: 't1_id', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false, hidden: false }, // Foreign key
            { name: 'data2', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false, hidden: false },
        ];
        const t2ColMap = new Map(t2Cols.map((c, i) => [c.name.toLowerCase(), i]));

        // 2. Mock Tables with different costs
        // t1 is cheaper (cost 100) - should be outer
        const module1 = mockTable(db, {
            schema: {
                name: 't1',
                schemaName: 'main',
                columns: t1Cols,
                columnIndexMap: t1ColMap,
                primaryKeyDefinition: [{ index: 0, desc: false }],
                checkConstraints: [],
                isWithoutRowid: false,
                isStrict: false,
                isTemporary: false,
                isView: false
            },
            bestIndexResult: { estimatedCost: 100, estimatedRows: BigInt(100) },
            constrainedBestIndexResult: { estimatedCost: 10, estimatedRows: BigInt(1) }
        });

        // t2 is more expensive (cost 1000)
        const module2 = mockTable(db, {
            schema: {
                name: 't2',
                schemaName: 'main',
                columns: t2Cols,
                columnIndexMap: t2ColMap,
                primaryKeyDefinition: [{ index: 0, desc: false }],
                checkConstraints: [],
                isWithoutRowid: false,
                isStrict: false,
                isTemporary: false,
                isView: false
            },
            bestIndexResult: { estimatedCost: 1000, estimatedRows: BigInt(500) },
            constrainedBestIndexResult: { estimatedCost: 10, estimatedRows: BigInt(1) }
        });

        // --- Configure inner loop cost expectations --- >
        // When t1 is outer, how much does scanning t2 cost *given* t1.id?
        // We expect the planner to call xBestIndex for t2 *with* the t1 cursor active.
        // For this test, let's assume the join constraint (t1.id = t2.t1_id)
        // makes the inner scan cheap (e.g., index lookup on t2.t1_id).
        // We will verify this by checking the xBestIndexCalls *after* compile.
        // Note: The mock setup currently uses a single bestIndexResult. A more advanced
        // mock could return different results based on the input indexInfo (constraints/orderBy).
        // For now, we rely on the default behavior and verify the calls later.

        // 3. Define SQL Query
        const sql = `SELECT t1.data1, t2.data2 FROM t1 JOIN t2 ON t1.id = t2.t1_id`;

        // 4. Compile and get the plan
        const plan = compile(db, sql);
        const planStr = planToString(plan);

        // 5. Assertions
        // Expect t1 (cheaper) as outer loop
        const expectedPlanStr = [
            '[0] SCAN t1 (Cursor 0) Cost=100.0 Rows=100 Idx=0',
            '[1] SCAN t2 (Cursor 1) Cost=1000.0 Rows=500 Idx=0',
            '[2] JOIN (inner) t1(C0) <-> t2(C1) Outer=t1 Cost=1100.0 Rows=5000' // Correct expectation with correct cost
            //'[2] JOIN (inner) t2(C1) <-> t1(C0) Outer=t2 Cost=51000.0 Rows=5000' // Actual incorrect
        ].join('\n');
        // Keep checking against the actual output for now while debugging
        // const actualIncorrectPlanStr = [
        //     '[0] SCAN t1 (Cursor 0) Cost=100.0 Rows=100 Idx=0',
        //     '[1] SCAN t2 (Cursor 1) Cost=1000.0 Rows=500 Idx=0',
        //     '[2] JOIN (inner) t2(C1) <-> t1(C0) Outer=t2 Cost=51000.0 Rows=5000'
        // ].join('\n');
        expect(planStr).to.equal(expectedPlanStr); // Use the correct expected string
        // expect(planStr).to.equal(actualIncorrectPlanStr, "Plan string does not match current (incorrect) output");

        // --- Inspect xBestIndex calls --- >
        // Initial scan for t1
        expect(module1.xBestIndexCalls.length).to.be.greaterThanOrEqual(1, "t1 xBestIndex not called at least once");
        const t1InitialCall = module1.xBestIndexCalls[0];
        expect(t1InitialCall.nConstraint).to.equal(0, "t1 initial scan should have 0 constraints");

        // Initial scan for t2
        expect(module2.xBestIndexCalls.length).to.be.greaterThanOrEqual(1, "t2 xBestIndex not called at least once");
        const t2InitialCall = module2.xBestIndexCalls[0];
        expect(t2InitialCall.nConstraint).to.equal(0, "t2 initial scan should have 0 constraints");

        // Planner should cost both join orders:
        // 1. t1 outer, t2 inner: Calls xBestIndex on t2 with constraint t2.t1_id = t1.id
        // 2. t2 outer, t1 inner: Calls xBestIndex on t1 with constraint t1.id = t2.t1_id

        // Find the call where t2 was evaluated as inner (should have 1 constraint)
        const t2InnerCall = module2.xBestIndexCalls.find(call => call.nConstraint === 1);
        expect(t2InnerCall).to.exist("Planner did not call xBestIndex for t2 as inner loop");
        expect(t2InnerCall?.aConstraint[0]?.iColumn).to.equal(1, "t2 inner call constraint column index (t1_id)");
        expect(t2InnerCall?.aConstraint[0]?.op).to.equal(IndexConstraintOp.EQ, "t2 inner call constraint op (EQ)");

        // Find the call where t1 was evaluated as inner (should have 1 constraint)
        const t1InnerCall = module1.xBestIndexCalls.find(call => call.nConstraint === 1);
        expect(t1InnerCall).to.exist("Planner did not call xBestIndex for t1 as inner loop");
        expect(t1InnerCall?.aConstraint[0]?.iColumn).to.equal(0, "t1 inner call constraint column index (id)");
        expect(t1InnerCall?.aConstraint[0]?.op).to.equal(IndexConstraintOp.EQ, "t1 inner call constraint op (EQ)");

        // If the planner logic was correct AND the mock returned lower costs for the inner calls,
        // the plan string assertion using expectedPlanStr should have passed.
        // Since it didn't, it implies the estimatedCost returned during the inner call simulation
        // was still the high base cost (1000 for t2, 100 for t1), leading to the wrong choice.

        // We can add more specific checks on the *returned* cost/rows in these calls
        // if we make the mock more sophisticated later.
    });

    // Add more tests here...

});
