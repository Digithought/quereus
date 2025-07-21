import { registerWindowFunction } from '../../schema/window-function.js';
import { SqlDataType } from '../../common/types.js';
import { AggValue } from '../registration.js';

// Built-in window function schemas
export function registerBuiltinWindowFunctions(): void {
	// Ranking functions
	registerWindowFunction({
		name: 'ROW_NUMBER',
		argCount: 0,
		returnType: {
			typeClass: 'scalar',
			affinity: SqlDataType.INTEGER,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'RANK',
		argCount: 0,
		returnType: {
			typeClass: 'scalar',
			affinity: SqlDataType.INTEGER,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'DENSE_RANK',
		argCount: 0,
		returnType: {
			typeClass: 'scalar',
			affinity: SqlDataType.INTEGER,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: true,
		kind: 'ranking'
	});

	registerWindowFunction({
		name: 'NTILE',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			affinity: SqlDataType.INTEGER,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: true,
		kind: 'ranking'
	});

	// Aggregate functions as window functions
	registerWindowFunction({
		name: 'COUNT',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			affinity: SqlDataType.INTEGER,
			nullable: false,
			isReadOnly: true
		},
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (state === null || state === undefined) {
				state = 0;
			}
			return value !== null ? state + 1 : state;
		},
		final: (state: AggValue) => state || 0
	});

	registerWindowFunction({
		name: 'SUM',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			affinity: SqlDataType.NUMERIC,
			nullable: true,
			isReadOnly: true
		},
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (value === null) return state;
			if (state === null || state === undefined) {
				return Number(value);
			}
			return state + Number(value);
		},
		final: (state: AggValue) => state
	});

	registerWindowFunction({
		name: 'AVG',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			affinity: SqlDataType.NUMERIC,
			nullable: true,
			isReadOnly: true
		},
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (value === null) return state;
			if (!state) {
				state = { sum: 0, count: 0 };
			}
			state.sum += Number(value);
			state.count += 1;
			return state;
		},
		final: (state: AggValue) => state ? state.sum / state.count : null
	});

	registerWindowFunction({
		name: 'MIN',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			affinity: SqlDataType.NUMERIC,
			nullable: true,
			isReadOnly: true
		},
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (value === null) return state;
			if (state === null || state === undefined) {
				return value;
			}
			return value < state ? value : state;
		},
		final: (state: AggValue) => state
	});

	registerWindowFunction({
		name: 'MAX',
		argCount: 1,
		returnType: {
			typeClass: 'scalar',
			affinity: SqlDataType.NUMERIC,
			nullable: true,
			isReadOnly: true
		},
		requiresOrderBy: false,
		kind: 'aggregate',
		step: (state: AggValue, value: AggValue) => {
			if (value === null) return state;
			if (state === null || state === undefined) {
				return value;
			}
			return value > state ? value : state;
		},
		final: (state: AggValue) => state
	});
}
