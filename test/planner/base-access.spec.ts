// Test suite for planner base access
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { mockTable } from '../helpers/mocks.js';
import { compile } from '../helpers/compile.js';
import { planToString } from './utils/planToString.js';
import { SqlDataType } from '../../src/common/types.js';
import { IndexConstraintOp } from '../../src/common/constants.js';
import type { ColumnSchema } from '../../src/schema/column.js';

describe('Query Planner - Base Access', () => {
    let db: Database;

    beforeEach(() => {
        db = new Database();
    });

    it('should handle simple WHERE clause with EQ constraint', () => {
        // 1. Setup: Define schema and mock the table
        const t1Cols: ColumnSchema[] = [
            { name: 'id', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false, hidden: false },
            { name: 'name', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false, hidden: false },
        ];
        const t1ColMap = new Map(t1Cols.map((c, i) => [c.name.toLowerCase(), i]));

        const module = mockTable(db, {
            schema: {
                name: 't1',
                schemaName: 'main',
                columns: t1Cols,
                columnIndexMap: t1ColMap,
                primaryKeyDefinition: [],
                checkConstraints: [],
                isWithoutRowid: false,
                isStrict: false,
                isTemporary: false,
                isView: false,
            },
            bestIndexResult: {
                idxNum: 0,
                orderByConsumed: false,
            }
        });

        // 2. Define SQL Query
        const sql = `SELECT id, name FROM t1 WHERE name = 'testValue'`;

        // 3. Compile and get the plan
        const plan = compile(db, sql);
        const planStr = planToString(plan);

        // 4. Assertions
        // Check the overall plan structure using string comparison
        const expectedPlan = `[0] SCAN t1 (Cursor 0) Cost=10000000000.0 Rows=1000000 Idx=0`;
        expect(planStr).to.equal(expectedPlan);

        // Check the details passed to xBestIndex by the planner
        expect(module.xBestIndexCalls.length).to.equal(1);
        const indexInfo = module.xBestIndexCalls[0];

        // Verify constraint extraction
        expect(indexInfo.nConstraint).to.equal(1);
        // Use deep equality check for the constraint object
        expect(indexInfo.aConstraint[0]).to.deep.equal({
            iColumn: 1, // Index of 'name' column
            op: IndexConstraintOp.EQ,
            usable: true
        });

        // Verify orderByConsumed is false (no ORDER BY in query)
        expect(indexInfo.orderByConsumed).to.be.false;
    });

    // Add more tests here...
    it('should handle ORDER BY consumed by index', () => {
        // 1. Setup: Define schema and mock the table
        const t1Cols: ColumnSchema[] = [
            { name: 'id', affinity: SqlDataType.INTEGER, notNull: false, primaryKey: true, pkOrder: 1, defaultValue: null, collation: 'BINARY', generated: false, hidden: false },
            { name: 'name', affinity: SqlDataType.TEXT, notNull: false, primaryKey: false, pkOrder: 0, defaultValue: null, collation: 'BINARY', generated: false, hidden: false },
        ];
        const t1ColMap = new Map(t1Cols.map((c, i) => [c.name.toLowerCase(), i]));

        const module = mockTable(db, {
            schema: {
                name: 't1',
                schemaName: 'main',
                columns: t1Cols,
                columnIndexMap: t1ColMap,
                primaryKeyDefinition: [],
                checkConstraints: [],
                isWithoutRowid: false, // Important: ORDER BY rowid or PK requires this
                isStrict: false,
                isTemporary: false,
                isView: false,
            },
            // Configure the mock module to report that it satisfied the ORDER BY
            bestIndexResult: {
                idxNum: 1, // Assume idx 1 provides order
                idxStr: 't1_pk_order',
                orderByConsumed: true, // The key part!
                estimatedCost: 100,   // Lower cost for index scan
                estimatedRows: BigInt(10),
            }
        });

        // 2. Define SQL Query with ORDER BY
        const sql = `SELECT id, name FROM t1 WHERE id > 5 ORDER BY id ASC`;

        // 3. Compile and get the plan
        const plan = compile(db, sql);
        const planStr = planToString(plan);

        // 4. Assertions
        // Check the plan string snapshot - it should now include 'OrderConsumed'
        const expectedPlanStr = `[0] SCAN t1 (Cursor 0) Cost=100.0 Rows=10 Idx=1 OrderConsumed`;
        expect(planStr).to.equal(expectedPlanStr);

        // Check the details passed to xBestIndex by the planner
        expect(module.xBestIndexCalls.length).to.equal(1);
        const indexInfo = module.xBestIndexCalls[0];

        // Verify constraint extraction (WHERE id > 5)
        expect(indexInfo.nConstraint).to.equal(1);
        expect(indexInfo.aConstraint[0]).to.deep.equal({
            iColumn: 0, // Index of 'id' column
            op: IndexConstraintOp.GT,
            usable: true
        });

        // Verify ORDER BY information was passed correctly
        expect(indexInfo.nOrderBy).to.equal(1);
        expect(indexInfo.aOrderBy[0]).to.deep.equal({
            iColumn: 0, // Index of 'id' column
            desc: false
        });

        // Verify orderByConsumed flag in the *output* of xBestIndex (confirm mock worked)
        // The planner's use of this is tested by the snapshot containing "OrderConsumed"
        expect(indexInfo.orderByConsumed).to.be.true;
    });

});
