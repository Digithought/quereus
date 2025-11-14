import { SqlDataType, type SqlValue } from "./types.js";
import type { LogicalType } from "../types/logical-type.js";
import { NULL_TYPE, INTEGER_TYPE, REAL_TYPE, TEXT_TYPE, BLOB_TYPE, BOOLEAN_TYPE } from "../types/builtin-types.js";

export function getLiteralSqlType(v: SqlValue): SqlDataType {
	if (v === null) return SqlDataType.NULL;
	if (typeof v === 'number') {
		if (Number.isInteger(v)) return SqlDataType.INTEGER;
		return SqlDataType.REAL;
	}
	if (typeof v === 'bigint') return SqlDataType.INTEGER;
	if (typeof v === 'string') return SqlDataType.TEXT;
	if (v instanceof Uint8Array) return SqlDataType.BLOB;
	return SqlDataType.BLOB;
}

/**
 * Infer LogicalType from a SqlValue
 */
export function inferLogicalTypeFromValue(v: SqlValue): LogicalType {
	if (v === null) return NULL_TYPE;
	if (typeof v === 'number') {
		// For now, all numbers are REAL. Could check Number.isInteger() for INTEGER_TYPE
		return REAL_TYPE;
	}
	if (typeof v === 'bigint') return INTEGER_TYPE;
	if (typeof v === 'boolean') return BOOLEAN_TYPE;
	if (typeof v === 'string') return TEXT_TYPE;
	if (v instanceof Uint8Array) return BLOB_TYPE;
	return BLOB_TYPE;
}
