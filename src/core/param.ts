import type { ScalarType } from '../common/datatype';
import { type SqlParameters, type SqlValue, SqlDataType } from '../common/types';

export function getParameterTypeHints(params: SqlParameters | undefined): Map<string | number, ScalarType> | undefined {
	let results: Map<string | number, ScalarType> | undefined;
	if (params) {
		results = new Map<string | number, ScalarType>();
		if (Array.isArray(params)) {
			params.forEach((paramValue, index) => {
				// ParameterScope resolves '?' to 1-based indices internally when it sees the AST node.
				// The hints should be keyed by these 1-based indices for anonymous params.
				results!.set(index + 1, getParameterScalarType(paramValue));
			});
		} else {
			Object.entries(params).forEach(([key, value]) => {
				// For named params like ':name', ParameterScope expects 'name' as key for hints.
				results!.set(key.startsWith(':') ? key.substring(1) : key, getParameterScalarType(value));
			});
		}
	}
	return results;
}

function getParameterScalarType(value: SqlValue): ScalarType {
	let affinity: SqlDataType;
	if (value === null) affinity = SqlDataType.NULL;
	else if (typeof value === 'number') affinity = SqlDataType.REAL;
	else if (typeof value === 'bigint') affinity = SqlDataType.INTEGER;
	else if (typeof value === 'string') affinity = SqlDataType.TEXT;
	else if (value instanceof Uint8Array) affinity = SqlDataType.BLOB;
	else if (typeof value === 'boolean') affinity = SqlDataType.INTEGER;
	else affinity = SqlDataType.BLOB;

	return {
		typeClass: 'scalar',
		affinity: affinity,
		nullable: value === null,
		isReadOnly: true,
		datatype: affinity,
	};
}
