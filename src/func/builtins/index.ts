import { lowerFunc, upperFunc, lengthFunc, substrFunc, substringFunc, absFunc, roundFunc, coalesceFunc,
	nullifFunc, likeFunc, globFunc } from './scalar';
import { countStarFunc, sumFunc, avgFunc, minFunc, maxFunc } from './aggregate';
import type { FunctionSchema } from '../../schema/function';

// Combine all built-in function definitions into a single array
export const BUILTIN_FUNCTIONS: FunctionSchema[] = [
	lowerFunc,
	upperFunc,
	lengthFunc,
	substrFunc,
	substringFunc,
	absFunc,
	roundFunc,
	coalesceFunc,
	nullifFunc,
	likeFunc,
	globFunc,
	// Aggregates
	countStarFunc,
	sumFunc,
	avgFunc,
	minFunc,
	maxFunc,
	countXFunc,
	groupConcatFuncRev,
];
