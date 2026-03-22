import { expect } from 'chai';
import {
	isScalarFunctionSchema,
	isTableValuedFunctionSchema,
	isAggregateFunctionSchema,
	isWindowFunctionSchema,
} from '../src/schema/function.js';
import { FunctionFlags } from '../src/common/constants.js';
import type {
	FunctionSchema,
	ScalarFunctionSchema,
	AggregateFunctionSchema,
	TableValuedFunctionSchema,
	WindowFunctionSchema,
} from '../src/schema/function.js';

describe('Function type guards', () => {
	const scalarFunc: ScalarFunctionSchema = {
		name: 'test_scalar',
		numArgs: 1,
		flags: FunctionFlags.DETERMINISTIC,
		returnType: { typeClass: 'scalar', affinity: 'TEXT' },
		implementation: (x) => x,
	};

	const tvfFunc: TableValuedFunctionSchema = {
		name: 'test_tvf',
		numArgs: 0,
		flags: 0,
		returnType: { typeClass: 'relation', columns: [] },
		implementation: async function* () { /* empty */ },
	};

	const aggFunc: AggregateFunctionSchema = {
		name: 'test_agg',
		numArgs: 1,
		flags: 0,
		returnType: { typeClass: 'scalar', affinity: 'REAL' },
		stepFunction: (acc, val) => acc + Number(val),
		finalizeFunction: (acc) => acc,
		initialValue: 0,
	};

	const windowFunc: WindowFunctionSchema = {
		name: 'test_window',
		numArgs: 0,
		flags: 0,
		returnType: { typeClass: 'scalar', affinity: 'INTEGER' },
		implementation: () => 0,
	};

	it('isScalarFunctionSchema correctly identifies scalar functions', () => {
		expect(isScalarFunctionSchema(scalarFunc)).to.equal(true);
		expect(isScalarFunctionSchema(tvfFunc)).to.equal(false);
		expect(isScalarFunctionSchema(aggFunc)).to.equal(false);
	});

	it('isTableValuedFunctionSchema correctly identifies TVFs', () => {
		expect(isTableValuedFunctionSchema(tvfFunc)).to.equal(true);
		expect(isTableValuedFunctionSchema(scalarFunc)).to.equal(false);
	});

	it('isAggregateFunctionSchema correctly identifies aggregates', () => {
		expect(isAggregateFunctionSchema(aggFunc)).to.equal(true);
		expect(isAggregateFunctionSchema(scalarFunc)).to.equal(false);
	});

	it('BUG: isWindowFunctionSchema cannot distinguish window from scalar', () => {
		// This test documents the bug: WindowFunctionSchema from function.ts
		// is runtime-indistinguishable from ScalarFunctionSchema, so the
		// type guard always returns false.
		expect(isScalarFunctionSchema(windowFunc as FunctionSchema)).to.equal(true); // misclassified!
		expect(isWindowFunctionSchema(windowFunc as FunctionSchema)).to.equal(false); // broken!
	});
});
