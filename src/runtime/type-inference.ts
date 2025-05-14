import { SqlDataType, type SqlValue } from "../common/types.js";

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
