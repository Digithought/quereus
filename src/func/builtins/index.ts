import { lowerFunc, upperFunc, lengthFunc, substrFunc, substringFunc, absFunc, roundFunc, coalesceFunc,
	nullifFunc, likeFunc, globFunc } from './scalar';
import { countStarFunc, sumFunc, avgFunc, minFunc, maxFunc, countXFunc, groupConcatFuncRev } from './aggregate';
import type { FunctionSchema } from '../../schema/function';
import { dateFunc, timeFunc, datetimeFunc, juliandayFunc, strftimeFunc } from './datetime';
// Import JSON functions
import { jsonValidFunc, jsonTypeFunc, jsonExtractFunc, jsonQuoteFunc, jsonArrayFunc, jsonObjectFunc, jsonInsertFunc, jsonReplaceFunc, jsonSetFunc, jsonRemoveFunc,
	jsonArrayLengthFunc, jsonPatchFunc,
	jsonGroupArrayFunc, jsonGroupObjectFunc } from './json';

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
	// Date/Time Functions
	dateFunc,
	timeFunc,
	datetimeFunc,
	juliandayFunc,
	strftimeFunc,
	// JSON Functions
	jsonValidFunc,
	jsonTypeFunc,
	jsonExtractFunc,
	jsonQuoteFunc,
	jsonArrayFunc,
	jsonObjectFunc,
	// JSON Manipulation
	jsonInsertFunc,
	jsonReplaceFunc,
	jsonSetFunc,
	jsonRemoveFunc,
	// Additional JSON
	jsonArrayLengthFunc,
	jsonPatchFunc,
	// JSON Aggregates
	jsonGroupArrayFunc,
	jsonGroupObjectFunc,
];
