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
/**
 * Determines the column affinity based on SQLite rules.
 * @see https://www.sqlite.org/datatype3.html#determination_of_column_affinity
 *
 * @param typeName The declared type name (case-insensitive)
 * @returns The determined SqlDataType affinity
 */

export function getAffinity(typeName: string | undefined): SqlDataType {
	if (!typeName) {
		return SqlDataType.BLOB;
	}
	const typeUpper = typeName.toUpperCase();
	if (typeUpper.includes('INT')) {
		return SqlDataType.INTEGER;
	}
	if (typeUpper.includes('CHAR') || typeUpper.includes('CLOB') || typeUpper.includes('TEXT')) {
		return SqlDataType.TEXT;
	}
	if (typeUpper.includes('BLOB')) {
		return SqlDataType.BLOB;
	}
	if (typeUpper.includes('REAL') || typeUpper.includes('FLOA') || typeUpper.includes('DOUB')) {
		return SqlDataType.REAL;
	}
	return SqlDataType.NUMERIC; // Default catch-all
}
