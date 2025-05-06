// Placeholder for compile helper
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { Compiler } from '../../src/compiler/compiler.js';
import type * as AST from '../../src/parser/ast.js';
import type { PlannedStep } from '../../src/compiler/planner/types.js';
import { planQueryExecution } from '../../src/compiler/planner/query-planner.js';

/**
 * Compiles SQL and returns the planned steps.
 * Assumes the SQL is a SELECT, UPDATE, or DELETE statement.
 */
export function compile(db: Database, sql: string): PlannedStep[] {
    const parser = new Parser(); // No db argument
    const ast = parser.parse(sql); // Returns a single Statement object

    if (!ast) {
        throw new Error('Parsing failed or produced no AST node.');
    }

    if (ast.type !== 'select' && ast.type !== 'update' && ast.type !== 'delete') {
        throw new Error(`Unsupported statement type for planner testing: ${ast.type}`);
    }

    const compiler = new Compiler(db);

    // --- Pre-populate necessary compiler state before planning --- >
    // 1. CTEs (if any)
    if ('withClause' in ast && ast.withClause) {
        // @ts-ignore - Accessing private method for testing setup
        compiler._analyzeCteReferences(ast, ast.withClause);
        compiler.compileWithClause(ast.withClause);
    }
    // 2. FROM sources (registers tables/aliases/cursors)
    if ('from' in ast && ast.from) {
        compiler.compileFromCore(ast.from);
    }
    // < --- End pre-population --- //

    // --- Run the planner --- >
    const plannedSteps = planQueryExecution(compiler, ast as AST.SelectStmt | AST.UpdateStmt | AST.DeleteStmt);
    // < --- End planner run --- //

    return plannedSteps;
}
