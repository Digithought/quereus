import { expect } from 'chai';
import { EmptyScope } from '../../src/planner/scopes/empty.js';
import { fingerprintExpression } from '../../src/planner/analysis/expression-fingerprint.js';
import { BinaryOpNode, LiteralNode, UnaryOpNode, CaseExprNode, CastNode, CollateNode, BetweenNode } from '../../src/planner/nodes/scalar.js';
import { ColumnReferenceNode, ParameterReferenceNode } from '../../src/planner/nodes/reference.js';
import { ScalarFunctionCallNode } from '../../src/planner/nodes/function.js';
import { AggregateFunctionCallNode } from '../../src/planner/nodes/aggregate-function.js';
import type { ScalarPlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';
import type { ScalarFunctionSchema, AggregateFunctionSchema } from '../../src/schema/function.js';
import { TEXT_TYPE, INTEGER_TYPE, REAL_TYPE } from '../../src/types/builtin-types.js';
import { FunctionFlags } from '../../src/common/constants.js';
import type { ScalarType } from '../../src/common/datatype.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const scope = EmptyScope.instance as any;

const textType: ScalarType = { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: false };
const intType: ScalarType = { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: false };

function colRef(attrId: number, name = 'c', index = 0): ColumnReferenceNode {
	const expr = { type: 'column', schema: undefined, table: undefined, name } as unknown as AST.ColumnExpr;
	return new ColumnReferenceNode(scope, expr, textType, attrId, index);
}

function lit(value: unknown): LiteralNode {
	return new LiteralNode(scope, { type: 'literal', value } as unknown as AST.LiteralExpr);
}

function binOp(op: string, left: ScalarPlanNode, right: ScalarPlanNode): BinaryOpNode {
	const ast = { type: 'binary', operator: op, left: (left as any).expression, right: (right as any).expression } as AST.BinaryExpr;
	return new BinaryOpNode(scope, ast, left, right);
}

function unaryOp(op: string, operand: ScalarPlanNode): UnaryOpNode {
	const ast = { type: 'unary', operator: op, operand: (operand as any).expression } as unknown as AST.UnaryExpr;
	return new UnaryOpNode(scope, ast, operand);
}

function makeFunctionSchema(name: string, deterministic: boolean): ScalarFunctionSchema {
	return {
		name,
		numArgs: -1,
		flags: deterministic ? FunctionFlags.DETERMINISTIC : 0,
		returnType: textType,
		implementation: () => null,
	};
}

function fnCall(name: string, args: ScalarPlanNode[], deterministic = true): ScalarFunctionCallNode {
	const expr = { type: 'function', name, args: args.map(a => (a as any).expression) } as unknown as AST.FunctionExpr;
	return new ScalarFunctionCallNode(scope, expr, makeFunctionSchema(name, deterministic), args);
}

function aggCall(name: string, args: ScalarPlanNode[], distinct = false): AggregateFunctionCallNode {
	const expr = { type: 'function', name, args: args.map(a => (a as any).expression) } as unknown as AST.FunctionExpr;
	const schema: AggregateFunctionSchema = {
		name,
		numArgs: args.length,
		flags: FunctionFlags.DETERMINISTIC,
		returnType: intType,
		stepFunction: () => null,
		finalizeFunction: () => null,
	};
	return new AggregateFunctionCallNode(scope, expr, name, schema, args, distinct);
}

describe('Expression fingerprinting', () => {

	describe('Literal fingerprints', () => {
		it('integer (bigint) literal', () => {
			expect(fingerprintExpression(lit(5n))).to.equal('LI:5n');
		});

		it('real (number) literal', () => {
			expect(fingerprintExpression(lit(3.14))).to.equal('LI:3.14f');
		});

		it('text literal', () => {
			expect(fingerprintExpression(lit('hello'))).to.equal("LI:'hello'");
		});

		it('null literal', () => {
			expect(fingerprintExpression(lit(null))).to.equal('LI:null');
		});

		it('boolean literal', () => {
			expect(fingerprintExpression(lit(true))).to.equal('LI:true');
		});

		it('blob literal', () => {
			const blob = new Uint8Array([0xde, 0xad]);
			expect(fingerprintExpression(lit(blob))).to.equal('LI:xdead');
		});

		it('distinguishes integer from real', () => {
			expect(fingerprintExpression(lit(5n))).to.not.equal(fingerprintExpression(lit(5)));
		});
	});

	describe('Column reference fingerprints', () => {
		it('fingerprints by attribute ID, not name', () => {
			const a = colRef(42, 'foo');
			const b = colRef(42, 'bar');
			expect(fingerprintExpression(a)).to.equal(fingerprintExpression(b));
		});

		it('different attribute IDs produce different fingerprints', () => {
			expect(fingerprintExpression(colRef(1))).to.not.equal(fingerprintExpression(colRef(2)));
		});
	});

	describe('Parameter reference fingerprints', () => {
		it('named parameter', () => {
			const expr = { type: 'parameter', name: ':foo' } as unknown as AST.ParameterExpr;
			const node = new ParameterReferenceNode(scope, expr, ':foo', textType);
			expect(fingerprintExpression(node)).to.equal('PR::foo');
		});

		it('indexed parameter', () => {
			const expr = { type: 'parameter', name: '1' } as unknown as AST.ParameterExpr;
			const node = new ParameterReferenceNode(scope, expr, 1, textType);
			expect(fingerprintExpression(node)).to.equal('PR:1');
		});
	});

	describe('Unary operator fingerprints', () => {
		it('NOT operator', () => {
			const fp = fingerprintExpression(unaryOp('NOT', lit(true)));
			expect(fp).to.equal('UO:NOT(LI:true)');
		});

		it('negation operator', () => {
			const fp = fingerprintExpression(unaryOp('-', lit(5n)));
			expect(fp).to.equal('UO:-(LI:5n)');
		});
	});

	describe('Binary operator fingerprints', () => {
		it('basic binary op', () => {
			const fp = fingerprintExpression(binOp('>', fnCall('length', [colRef(42)]), lit(5n)));
			expect(fp).to.equal('BO:>(FN:length(CR:42),LI:5n)');
		});

		it('same structure produces same fingerprint', () => {
			const a = binOp('+', colRef(1), lit(2n));
			const b = binOp('+', colRef(1), lit(2n));
			expect(fingerprintExpression(a)).to.equal(fingerprintExpression(b));
		});

		it('different operators produce different fingerprints', () => {
			const a = binOp('+', colRef(1), lit(2n));
			const b = binOp('-', colRef(1), lit(2n));
			expect(fingerprintExpression(a)).to.not.equal(fingerprintExpression(b));
		});
	});

	describe('Commutativity', () => {
		it('a + b equals b + a', () => {
			const ab = binOp('+', colRef(1), colRef(2));
			const ba = binOp('+', colRef(2), colRef(1));
			expect(fingerprintExpression(ab)).to.equal(fingerprintExpression(ba));
		});

		it('a * b equals b * a', () => {
			const ab = binOp('*', colRef(1), lit(3n));
			const ba = binOp('*', lit(3n), colRef(1));
			expect(fingerprintExpression(ab)).to.equal(fingerprintExpression(ba));
		});

		it('a = b equals b = a', () => {
			const ab = binOp('=', colRef(1), lit(5n));
			const ba = binOp('=', lit(5n), colRef(1));
			expect(fingerprintExpression(ab)).to.equal(fingerprintExpression(ba));
		});

		it('a - b does NOT equal b - a', () => {
			const ab = binOp('-', colRef(1), colRef(2));
			const ba = binOp('-', colRef(2), colRef(1));
			expect(fingerprintExpression(ab)).to.not.equal(fingerprintExpression(ba));
		});

		it('a > b does NOT equal b > a', () => {
			const ab = binOp('>', colRef(1), colRef(2));
			const ba = binOp('>', colRef(2), colRef(1));
			expect(fingerprintExpression(ab)).to.not.equal(fingerprintExpression(ba));
		});
	});

	describe('Function call fingerprints', () => {
		it('scalar function', () => {
			const fp = fingerprintExpression(fnCall('length', [colRef(42)]));
			expect(fp).to.equal('FN:length(CR:42)');
		});

		it('same function same args produces same fingerprint', () => {
			const a = fnCall('upper', [colRef(10)]);
			const b = fnCall('upper', [colRef(10)]);
			expect(fingerprintExpression(a)).to.equal(fingerprintExpression(b));
		});

		it('different function names produce different fingerprints', () => {
			const a = fnCall('upper', [colRef(10)]);
			const b = fnCall('lower', [colRef(10)]);
			expect(fingerprintExpression(a)).to.not.equal(fingerprintExpression(b));
		});
	});

	describe('Aggregate function fingerprints', () => {
		it('basic aggregate', () => {
			const fp = fingerprintExpression(aggCall('count', [colRef(1)]));
			expect(fp).to.equal('AG:count(CR:1)');
		});

		it('distinct aggregate differs from non-distinct', () => {
			const a = aggCall('count', [colRef(1)], false);
			const b = aggCall('count', [colRef(1)], true);
			expect(fingerprintExpression(a)).to.not.equal(fingerprintExpression(b));
		});
	});

	describe('CASE expression fingerprints', () => {
		it('simple CASE', () => {
			const caseNode = new CaseExprNode(
				scope,
				{ type: 'case' } as unknown as AST.CaseExpr,
				undefined,
				[{ when: binOp('=', colRef(1), lit(1n)), then: lit('a') }],
				lit('z')
			);
			const fp = fingerprintExpression(caseNode);
			expect(fp).to.contain('CE(');
			expect(fp).to.contain('W:');
			expect(fp).to.contain('T:');
			expect(fp).to.contain('E:');
		});
	});

	describe('CAST fingerprints', () => {
		it('CAST to TEXT', () => {
			const castNode = new CastNode(
				scope,
				{ type: 'cast', targetType: 'TEXT', operand: null } as unknown as AST.CastExpr,
				colRef(7)
			);
			expect(fingerprintExpression(castNode)).to.equal('CA:TEXT(CR:7)');
		});
	});

	describe('COLLATE fingerprints', () => {
		it('COLLATE NOCASE', () => {
			const collateNode = new CollateNode(
				scope,
				{ type: 'collate', collation: 'NOCASE' } as unknown as AST.CollateExpr,
				colRef(3)
			);
			expect(fingerprintExpression(collateNode)).to.equal('CO:NOCASE(CR:3)');
		});
	});

	describe('BETWEEN fingerprints', () => {
		it('BETWEEN', () => {
			const bw = new BetweenNode(
				scope,
				{ type: 'between', not: false } as unknown as AST.BetweenExpr,
				colRef(5), lit(1n), lit(10n)
			);
			expect(fingerprintExpression(bw)).to.equal('BW:(CR:5,LI:1n,LI:10n)');
		});

		it('NOT BETWEEN differs from BETWEEN', () => {
			const bw = new BetweenNode(
				scope,
				{ type: 'between', not: false } as unknown as AST.BetweenExpr,
				colRef(5), lit(1n), lit(10n)
			);
			const nbw = new BetweenNode(
				scope,
				{ type: 'between', not: true } as unknown as AST.BetweenExpr,
				colRef(5), lit(1n), lit(10n)
			);
			expect(fingerprintExpression(bw)).to.not.equal(fingerprintExpression(nbw));
		});
	});

	describe('Non-deterministic guard', () => {
		it('non-deterministic function produces unique fingerprint', () => {
			const a = fnCall('random', [], false);
			const b = fnCall('random', [], false);
			const fpA = fingerprintExpression(a);
			const fpB = fingerprintExpression(b);
			expect(fpA).to.not.equal(fpB);
			expect(fpA).to.match(/^_ND:/);
		});
	});

	describe('Nested expressions', () => {
		it('nested expression fingerprints recursively', () => {
			// length(name) > 5
			const expr = binOp('>', fnCall('length', [colRef(42)]), lit(5n));
			expect(fingerprintExpression(expr)).to.equal('BO:>(FN:length(CR:42),LI:5n)');
		});

		it('deeply nested expressions produce consistent fingerprints', () => {
			// (a + b) * (c - d)
			const add = binOp('+', colRef(1), colRef(2));
			const sub = binOp('-', colRef(3), colRef(4));
			const mul = binOp('*', add, sub);

			const add2 = binOp('+', colRef(1), colRef(2));
			const sub2 = binOp('-', colRef(3), colRef(4));
			const mul2 = binOp('*', add2, sub2);

			expect(fingerprintExpression(mul)).to.equal(fingerprintExpression(mul2));
		});
	});
});
