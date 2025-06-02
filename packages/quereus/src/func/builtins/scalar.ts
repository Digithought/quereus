import type { SqlValue } from '../../common/types.js';
import { createScalarFunction } from '../registration.js';
import { compareSqlValues, getSqlDataTypeName } from '../../util/comparison.js';

// --- abs(X) ---
export const absFunc = createScalarFunction(
	{ name: 'abs', numArgs: 1, deterministic: true },
	(arg: SqlValue): SqlValue => {
		if (arg === null) return null;
		if (typeof arg === 'bigint') return arg < 0n ? -arg : arg;
		const num = Number(arg);
		if (isNaN(num)) return null;
		return Math.abs(num);
	}
);

// --- round(X, Y?) ---
export const roundFunc = createScalarFunction(
	{ name: 'round', numArgs: -1, deterministic: true },
	(numVal: SqlValue, placesVal?: SqlValue): SqlValue => {
		if (numVal === null) return null;
		const x = Number(numVal);
		if (isNaN(x)) return null;

		let y = 0;
		if (placesVal !== undefined && placesVal !== null) {
			const numY = Number(placesVal);
			if (isNaN(numY)) return null;
			y = Math.trunc(numY);
		}

		try {
			const factor = Math.pow(10, y);
			return Math.round(x * factor) / factor;
		} catch {
			return null;
		}
	}
);

// --- coalesce(...) ---
export const coalesceFunc = createScalarFunction(
	{ name: 'coalesce', numArgs: -1, deterministic: true },
	(...args: SqlValue[]): SqlValue => {
		for (const arg of args) {
			if (arg !== null) {
				return arg;
			}
		}
		return null;
	}
);

// --- nullif(X, Y) ---
export const nullifFunc = createScalarFunction(
	{ name: 'nullif', numArgs: 2, deterministic: true },
	(argX: SqlValue, argY: SqlValue): SqlValue => {
		const comparison = compareSqlValues(argX, argY);
		return comparison === 0 ? null : argX;
	}
);

// --- typeof(X) ---
export const typeofFunc = createScalarFunction(
	{ name: 'typeof', numArgs: 1, deterministic: true },
	(arg: SqlValue): SqlValue => {
		return getSqlDataTypeName(arg);
	}
);

// --- random() ---
export const randomFunc = createScalarFunction(
	{ name: 'random', numArgs: 0, deterministic: false },
	(): SqlValue => {
		const randomInt = Math.floor(Math.random() * (Number.MAX_SAFE_INTEGER - Number.MIN_SAFE_INTEGER + 1)) + Number.MIN_SAFE_INTEGER;
		return BigInt(randomInt);
	}
);

// --- randomblob(N) ---
export const randomblobFunc = createScalarFunction(
	{ name: 'randomblob', numArgs: 1, deterministic: false },
	(nVal: SqlValue): SqlValue => {
		if (typeof nVal !== 'number' && typeof nVal !== 'bigint') return null;
		const n = Number(nVal);
		if (!Number.isInteger(n) || n <= 0) return new Uint8Array(0);
		const byteLength = Math.min(n, 1024 * 1024); // Cap at 1MB

		const buffer = new Uint8Array(byteLength);
		for (let i = 0; i < byteLength; i++) {
			buffer[i] = Math.floor(Math.random() * 256);
		}
		return buffer;
	}
);

// --- iif(X, Y, Z) ---
export const iifFunc = createScalarFunction(
	{ name: 'iif', numArgs: 3, deterministic: true },
	(condition: SqlValue, trueVal: SqlValue, falseVal: SqlValue): SqlValue => {
		let isTrue: boolean;
		if (condition === null) {
			isTrue = false;
		} else if (typeof condition === 'number') {
			isTrue = condition !== 0;
		} else if (typeof condition === 'bigint') {
			isTrue = condition !== 0n;
		} else if (typeof condition === 'string') {
			const num = Number(condition);
			isTrue = !isNaN(num) && num !== 0;
		} else {
			isTrue = Boolean(condition);
		}

		return isTrue ? trueVal : falseVal;
	}
);

// --- sqrt(X) ---
export const sqrtFunc = createScalarFunction(
	{ name: 'sqrt', numArgs: 1, deterministic: true },
	(arg: SqlValue): SqlValue => {
		if (arg === null) return null;
		const num = Number(arg);
		if (isNaN(num) || num < 0) return null;
		return Math.sqrt(num);
	}
);

// --- pow(X, Y) / power(X, Y) ---

const pow = (base: SqlValue, exponent: SqlValue): SqlValue => {
	if (base === null || exponent === null) return null;
	const numBase = Number(base);
	const numExp = Number(exponent);
	if (isNaN(numBase) || isNaN(numExp)) return null;
	return Math.pow(numBase, numExp);
};

export const powFunc = createScalarFunction(
	{ name: 'pow', numArgs: 2, deterministic: true },
	pow
);

export const powerFunc = createScalarFunction(
	{ name: 'power', numArgs: 2, deterministic: true },
	pow
);

// --- floor(X) ---
export const floorFunc = createScalarFunction(
	{ name: 'floor', numArgs: 1, deterministic: true },
	(arg: SqlValue): SqlValue => {
		if (arg === null) return null;
		const num = Number(arg);
		if (isNaN(num)) return null;
		return Math.floor(num);
	}
);

// --- ceil(X) / ceiling(X) ---

const ceil = (arg: SqlValue): SqlValue => {
	if (arg === null) return null;
	const num = Number(arg);
	if (isNaN(num)) return null;
	return Math.ceil(num);
};

export const ceilFunc = createScalarFunction(
	{ name: 'ceil', numArgs: 1, deterministic: true },
	ceil
);

export const ceilingFunc = createScalarFunction(
	{ name: 'ceiling', numArgs: 1, deterministic: true },
	ceil
);

// Math clamp function
export const clampFunc = createScalarFunction(
	{ name: 'clamp', numArgs: 3, deterministic: true },
	(value: SqlValue, min: SqlValue, max: SqlValue): SqlValue => {
		const v = Number(value);
		const minVal = Number(min);
		const maxVal = Number(max);

		if (isNaN(v) || isNaN(minVal) || isNaN(maxVal)) return null;
		return Math.max(minVal, Math.min(maxVal, v));
	}
);

// Greatest-of function
export const greatestFunc = createScalarFunction(
	{ name: 'greatest', numArgs: -1, deterministic: true },
	(...args: SqlValue[]): SqlValue => {
		if (args.length === 0) return null;
		return args.reduce((max, current) => {
			if (max === null || compareSqlValues(current, max) > 0) {
				return current;
			}
			return max;
		}, args[0]);
	}
);

// Least-of function
export const leastFunc = createScalarFunction(
	{ name: 'least', numArgs: -1, deterministic: true },
	(...args: SqlValue[]): SqlValue => {
		if (args.length === 0) return null;
		return args.reduce((min, current) => {
			if (min === null || compareSqlValues(current, min) < 0) {
				return current;
			}
			return min;
		}, args[0]);
	}
);

// Choose function
export const chooseFunc = createScalarFunction(
	{ name: 'choose', numArgs: -1, deterministic: true },
	(...args: SqlValue[]): SqlValue => {
		if (args.length === 0) return null;
		const index = Number(args[0]);
		if (isNaN(index) || index < 1 || index >= args.length) return null;
		return args[index];
	}
);

// Greatest-of function
