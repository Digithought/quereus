// Placeholder for compile helper
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';

/**
 * Parses SQL and returns the planned steps.
 * Assumes the SQL is a SELECT, UPDATE, or DELETE statement.
 */
export function plan(db: Database, sql: string): PlanNode {
    const parser = new Parser(); // No db argument
    const ast = parser.parse(sql); // Returns a single Statement object

    if (!ast) {
        throw new Error('Parsing failed or produced no AST node.');
    }

    if (ast.type !== 'select' && ast.type !== 'update' && ast.type !== 'delete') {
        throw new Error(`Unsupported statement type for planner testing: ${ast.type}`);
    }

		const plan = db.getPlan(ast);

    return plan;
}
