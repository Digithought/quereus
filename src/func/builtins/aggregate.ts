import { FunctionFlags } from '../../common/constants.js';
import type { SqlValue } from '../../common/types.js';
import { createAggregateFunction } from '../registration.js';
import { compareSqlValues } from '../../util/comparison.js';

// --- count(*) ---
const countStarStep = (acc: number | undefined): number => {
	return (acc ?? 0) + 1;
};
const countStarFinal = (acc: number | undefined): number => {
	return acc ?? 0;
};
export const countStarFunc = createAggregateFunction(
	{ name: 'count', numArgs: 0, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC, initialState: 0 },
	countStarStep,
	countStarFinal
);

// --- SUM(X) ---
const sumStep = (acc: { sum: number | bigint } | null, value: any): { sum: number | bigint } | null => {
	if (value === null) return acc; // Ignore NULLs
	const currentSum = acc?.sum ?? 0; // Initialize sum to 0 if null
	let numValue = value;
	// Basic numeric coercion - prefer BigInt if possible
	try {
		if (typeof value !== 'bigint') {
			numValue = Number(value);
			if (isNaN(numValue)) return acc; // Ignore non-numeric
		}

		// Promote to BigInt if either is BigInt or if result might overflow Number
		if (typeof currentSum === 'bigint' || typeof numValue === 'bigint') {
			return { sum: BigInt(currentSum) + BigInt(numValue) };
		} else {
			// Check potential overflow before adding as numbers
			const potentialSum = currentSum + numValue;
			if (potentialSum > Number.MAX_SAFE_INTEGER || potentialSum < Number.MIN_SAFE_INTEGER) {
				return { sum: BigInt(currentSum) + BigInt(numValue) };
			}
			return { sum: potentialSum };
		}
	} catch (e) {
		console.warn("Error during SUM step coercion:", e);
		return acc; // Ignore value if coercion fails
	}
};
const sumFinal = (acc: { sum: number | bigint } | null): number | bigint | null => {
	// SQLite returns NULL for SUM of empty set, INTEGER or REAL result
	return acc?.sum ?? null;
};
export const sumFunc = createAggregateFunction(
	{ name: 'sum', numArgs: 1, flags: FunctionFlags.UTF8 },
	sumStep,
	sumFinal
);

// --- AVG(X) ---
interface AvgAccumulator { sum: number | bigint; count: number }
const avgStep = (acc: AvgAccumulator | undefined, value: any): AvgAccumulator | undefined => {
	if (value === null) return acc; // Ignore NULLs
	let currentSum = acc?.sum ?? 0;
	let currentCount = acc?.count ?? 0;
	let numValue = value;
	try {
		if (typeof value !== 'bigint') {
			numValue = Number(value);
			if (isNaN(numValue)) return acc; // Ignore non-numeric
		}

		// Use floating point for sum in AVG to avoid potential BigInt division issues
		const newSum = Number(currentSum) + Number(numValue);
		return { sum: newSum, count: currentCount + 1 };
	} catch (e) {
		console.warn("Error during AVG step coercion:", e);
		return acc;
	}
};
const avgFinal = (acc: AvgAccumulator | undefined): number | null => {
	if (!acc || acc.count === 0) return null; // NULL for empty set
	return Number(acc.sum) / acc.count;
};
export const avgFunc = createAggregateFunction(
	{ name: 'avg', numArgs: 1, flags: FunctionFlags.UTF8 },
	avgStep,
	avgFinal
);

// --- MIN(X) ---
const minStep = (acc: { min: SqlValue } | null, value: any): { min: SqlValue } | null => {
	if (value === null) return acc; // Ignore NULLs
	if (acc === null) return { min: value }; // First non-null value
	return compareSqlValues(value, acc.min) < 0 ? { min: value } : acc;
};
const minFinal = (acc: { min: SqlValue } | null): SqlValue | null => {
	return acc?.min ?? null;
};
export const minFunc = createAggregateFunction(
	{ name: 'min', numArgs: 1, flags: FunctionFlags.UTF8 },
	minStep,
	minFinal
);

// --- MAX(X) ---
const maxStep = (acc: { max: SqlValue } | null, value: any): { max: SqlValue } | null => {
	if (value === null) return acc; // Ignore NULLs
	if (acc === null) return { max: value }; // First non-null value
	return compareSqlValues(value, acc.max) > 0 ? { max: value } : acc;
};
const maxFinal = (acc: { max: SqlValue } | null): SqlValue | null => {
	return acc?.max ?? null;
};
export const maxFunc = createAggregateFunction(
	{ name: 'max', numArgs: 1, flags: FunctionFlags.UTF8 },
	maxStep,
	maxFinal
);

// --- COUNT(X) ---
// Counts non-NULL values of X
const countXStep = (acc: number | undefined, value: any): number => {
	if (value === null) return acc ?? 0; // Do not count NULLs
	return (acc ?? 0) + 1;
};
const countXFinal = (acc: number | undefined): number => {
	return acc ?? 0;
};
export const countXFunc = createAggregateFunction(
	{ name: 'count', numArgs: 1, flags: FunctionFlags.UTF8 | FunctionFlags.DETERMINISTIC },
	countXStep,
	countXFinal
);

// --- GROUP_CONCAT(X, Y?) ---
// X is the value to concatenate, Y is the optional separator (default ,)
interface GroupConcatAccumulator {
	values: string[];
}
const groupConcatStep = (acc: GroupConcatAccumulator | undefined, value: any, separator?: any): GroupConcatAccumulator => {
	// Ignore NULL values for concatenation
	if (value === null) {
		return acc ?? { values: [] };
	}
	const currentValues = acc?.values ?? [];
	// Coerce value to string
	const strValue = String(value);
	currentValues.push(strValue);
	return { values: currentValues };
};
const groupConcatFinal = (acc: GroupConcatAccumulator | undefined, separator?: any): string | null => {
	if (!acc || acc.values.length === 0) {
		return null; // Return NULL if no non-NULL values were added
	}
	const sep = (separator === undefined || separator === null) ? ',' : String(separator);
	return acc.values.join(sep);
};
export const groupConcatFunc = createAggregateFunction(
	{ name: 'group_concat', numArgs: -1, flags: FunctionFlags.UTF8 }, // Allows 1 or 2 args
	// Need wrapper functions because createAggregateFunction expects specific signatures
	(acc: GroupConcatAccumulator | undefined, ...args: any[]) => groupConcatStep(acc, args[0], args[1]),
	(acc: GroupConcatAccumulator | undefined, ...args: any[]) => groupConcatFinal(acc, args[1]) // Final only needs separator from original args?
	// This is tricky. SQLite gets the separator from the *last* call to step technically.
	// Let's simplify: Assume separator is consistent or only the first one matters.
	// A better accumulator would store the separator.
	// Revised Approach: Store separator in accumulator
);

// Revised GROUP_CONCAT
interface GroupConcatAccumulatorRev {
	values: string[];
	separator: string;
}
const groupConcatStepRev = (acc: GroupConcatAccumulatorRev | undefined, value: any, separator: any = ','): GroupConcatAccumulatorRev => {
	const currentAcc = acc ?? { values: [], separator: String(separator) };
	// Use the separator from the *first* call if not provided in subsequent calls?
	// SQLite uses the separator from the *last* non-null separator arg encountered.
	// Let's just use the separator provided in *this* step if available.
	const currentSeparator = (separator === undefined || separator === null) ? currentAcc.separator : String(separator);

	if (value === null) {
		// Update separator even if value is NULL
		return { ...currentAcc, separator: currentSeparator };
	}

	const strValue = String(value);
	currentAcc.values.push(strValue);
	return { values: currentAcc.values, separator: currentSeparator };
};
const groupConcatFinalRev = (acc: GroupConcatAccumulatorRev | undefined): string | null => {
	if (!acc || acc.values.length === 0) {
		return null;
	}
	return acc.values.join(acc.separator);
};

export const groupConcatFuncRev = createAggregateFunction(
    { name: 'group_concat', numArgs: -1, flags: FunctionFlags.UTF8, initialState: { values: [], separator: ',' } },
    groupConcatStepRev,
    groupConcatFinalRev
);

// --- TOTAL(X) ---
// Similar to SUM, but always returns a FLOAT and returns 0.0 for empty set.
const totalStep = (acc: { total: number } | undefined, value: any): { total: number } => {
	const currentTotal = acc?.total ?? 0.0;
	let numValue = 0.0;
	if (value !== null) {
		try {
			// Attempt numeric conversion, default to 0.0 if not possible
			numValue = Number(value);
			if (isNaN(numValue)) {
				numValue = 0.0;
			}
		} catch {
			numValue = 0.0;
		}
	}
	// Always use floating-point arithmetic
	return { total: currentTotal + numValue };
};
const totalFinal = (acc: { total: number } | undefined): number => {
	// Returns 0.0 for empty set or only NULL inputs
	return acc?.total ?? 0.0;
};
export const totalFunc = createAggregateFunction(
	{ name: 'total', numArgs: 1, flags: FunctionFlags.UTF8, initialState: { total: 0.0 } },
	totalStep,
	totalFinal
);

// --- Statistical Aggregates (Variance, Standard Deviation) ---
interface StatAccumulator {
	count: number;
	sum: number;
	sumSq: number;
}

const statStep = (acc: StatAccumulator | undefined, value: any): StatAccumulator => {
	const currentAcc = acc ?? { count: 0, sum: 0, sumSq: 0 };
	if (value === null) {
		return currentAcc; // Ignore NULLs
	}
	try {
		const numValue = Number(value);
		if (isNaN(numValue)) {
			return currentAcc; // Ignore non-numeric
		}
		// Use floating-point for calculations
		return {
			count: currentAcc.count + 1,
			sum: currentAcc.sum + numValue,
			sumSq: currentAcc.sumSq + (numValue * numValue),
		};
	} catch (e) {
		console.warn("Error during statistical aggregate step coercion:", e);
		return currentAcc;
	}
};

// Population Variance (VAR_POP)
const varPopFinal = (acc: StatAccumulator | undefined): number | null => {
	if (!acc || acc.count === 0) return null; // NULL for empty set
	const avg = acc.sum / acc.count;
	const variance = (acc.sumSq / acc.count) - (avg * avg);
	return variance;
};
export const varPopFunc = createAggregateFunction(
	{ name: 'var_pop', numArgs: 1, flags: FunctionFlags.UTF8, initialState: { count: 0, sum: 0, sumSq: 0 } },
	statStep,
	varPopFinal
);

// Sample Variance (VAR_SAMP)
const varSampFinal = (acc: StatAccumulator | undefined): number | null => {
	if (!acc || acc.count <= 1) return null; // NULL if count is 0 or 1
	const avg = acc.sum / acc.count;
	// Sample variance: (sumSq - n*avg^2) / (n-1) == (sumSq - sum*sum/n) / (n-1)
	const variance = (acc.sumSq - (acc.sum * acc.sum) / acc.count) / (acc.count - 1);
	return variance;
};
export const varSampFunc = createAggregateFunction(
	{ name: 'var_samp', numArgs: 1, flags: FunctionFlags.UTF8, initialState: { count: 0, sum: 0, sumSq: 0 } },
	statStep,
	varSampFinal
);

// Population Standard Deviation (STDDEV_POP)
const stdDevPopFinal = (acc: StatAccumulator | undefined): number | null => {
	const variance = varPopFinal(acc);
	return variance === null || variance < 0 ? null : Math.sqrt(variance);
};
export const stdDevPopFunc = createAggregateFunction(
	{ name: 'stddev_pop', numArgs: 1, flags: FunctionFlags.UTF8, initialState: { count: 0, sum: 0, sumSq: 0 } },
	statStep,
	stdDevPopFinal
);

// Sample Standard Deviation (STDDEV_SAMP)
const stdDevSampFinal = (acc: StatAccumulator | undefined): number | null => {
	const variance = varSampFinal(acc);
	return variance === null || variance < 0 ? null : Math.sqrt(variance);
};
export const stdDevSampFunc = createAggregateFunction(
	{ name: 'stddev_samp', numArgs: 1, flags: FunctionFlags.UTF8, initialState: { count: 0, sum: 0, sumSq: 0 } },
	statStep,
	stdDevSampFinal
);

// TODO: Implement COUNT(X) which counts non-NULL values of X -- Done
// TODO: Implement GROUP_CONCAT -- Done (Revised)
