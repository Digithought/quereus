import type { CastNode } from '../../planner/nodes/scalar.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { emitPlanNode } from '../emitters.js';
import { type SqlValue } from '../../common/types.js';
import type { EmissionContext } from '../emission-context.js';

export function emitCast(plan: CastNode, ctx: EmissionContext): Instruction {
	async function run(
		runtimeCtx: RuntimeContext,
		operandValue: SqlValue
	): Promise<SqlValue> {
		const targetType = plan.expression.targetType.toUpperCase();

		// Handle NULL values - CAST(NULL AS anything) = NULL
		if (operandValue === null) {
			return null;
		}

		// Perform the cast based on target type
		switch (targetType) {
			case 'INTEGER':
			case 'INT':
			case 'TINYINT':
			case 'SMALLINT':
			case 'MEDIUMINT':
			case 'BIGINT':
			case 'UNSIGNED BIG INT':
			case 'INT2':
			case 'INT8':
				return castToInteger(operandValue);

			case 'REAL':
			case 'DOUBLE':
			case 'DOUBLE PRECISION':
			case 'FLOAT':
				return castToReal(operandValue);

			case 'TEXT':
			case 'CHARACTER':
			case 'VARCHAR':
			case 'VARYING CHARACTER':
			case 'NCHAR':
			case 'NATIVE CHARACTER':
			case 'NVARCHAR':
			case 'CLOB':
				return castToText(operandValue);

			case 'BLOB':
				return castToBlob(operandValue);

			case 'NUMERIC':
			case 'DECIMAL':
			case 'BOOLEAN':
			case 'DATE':
			case 'DATETIME':
				return castToNumeric(operandValue);

			default:
				// For unknown types, return as-is (BLOB affinity)
				return operandValue;
		}
	}

	return {
		params: [emitPlanNode(plan.operand, ctx)],
		run: run as any,
		note: `cast(${plan.expression.targetType})`
	};
}

function castToInteger(value: SqlValue): SqlValue {
	if (typeof value === 'number') {
		return Math.trunc(value);
	}
	if (typeof value === 'bigint') {
		return value;
	}
	if (typeof value === 'string') {
		const num = Number(value);
		return isNaN(num) ? 0 : Math.trunc(num);
	}
	if (typeof value === 'boolean') {
		return value ? 1 : 0;
	}
	return 0;
}

function castToReal(value: SqlValue): SqlValue {
	if (typeof value === 'number') {
		return value;
	}
	if (typeof value === 'bigint') {
		return Number(value);
	}
	if (typeof value === 'string') {
		const num = Number(value);
		return isNaN(num) ? 0.0 : num;
	}
	if (typeof value === 'boolean') {
		return value ? 1.0 : 0.0;
	}
	return 0.0;
}

function castToText(value: SqlValue): SqlValue {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'bigint') {
		return String(value);
	}
	if (typeof value === 'boolean') {
		return value ? '1' : '0';
	}
	if (value instanceof Uint8Array) {
		// Convert blob to hex string
		return Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
	}
	return String(value);
}

function castToBlob(value: SqlValue): SqlValue {
	if (value instanceof Uint8Array) {
		return value;
	}
	if (typeof value === 'string') {
		// Convert string to UTF-8 bytes
		return new TextEncoder().encode(value);
	}
	// For other types, convert to string first then to bytes
	return new TextEncoder().encode(String(value));
}

function castToNumeric(value: SqlValue): SqlValue {
	// NUMERIC affinity: prefer integer if possible, otherwise real
	if (typeof value === 'number') {
		return Number.isInteger(value) ? Math.trunc(value) : value;
	}
	if (typeof value === 'bigint') {
		return value;
	}
	if (typeof value === 'string') {
		const num = Number(value);
		if (isNaN(num)) return 0;
		return Number.isInteger(num) ? Math.trunc(num) : num;
	}
	if (typeof value === 'boolean') {
		return value ? 1 : 0;
	}
	return 0;
}
