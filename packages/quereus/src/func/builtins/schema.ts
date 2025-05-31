import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { SqlDataType } from "../../common/types.js";
import { createIntegratedTableValuedFunction } from "../registration.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { Database } from "../../core/database.js";
import type { FunctionSchema } from "../../schema/function.js";
import type { TableSchema } from "../../schema/table.js";

/**
 * Generates a function signature string for display
 */
function stringifyCreateFunction(func: FunctionSchema): string {
	const argsString = func.numArgs === -1
		? '...' // Indicate variable arguments
		: Array(func.numArgs).fill('?').join(', ');
	return `FUNCTION ${func.name}(${argsString})`;
}

// Schema introspection function (table-valued function)
export const schemaFunc = createIntegratedTableValuedFunction(
	{
		name: 'schema',
		numArgs: 0,
		deterministic: false, // Schema can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'type', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tbl_name', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'sql', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database): AsyncIterable<Row> {
		try {
			const schemaManager = db.schemaManager;

			const processSchemaInstance = function* (schemaInstance: any) {
				// Process Tables
				for (const tableSchema of schemaInstance.getAllTables()) {
					let createSql: string | null = null;
					try {
						const columnsStr = tableSchema.columns.map((c: any) => `"${c.name}" ${c.affinity ?? SqlDataType.TEXT}`).join(', ');
						const argsStr = Object.entries(tableSchema.vtabArgs ?? {}).map(([key, value]) => `${key}=${value}`).join(', ');
						createSql = `create table "${tableSchema.name}" (${columnsStr}) using ${tableSchema.vtabModuleName}(${argsStr})`;
					} catch (e) {
						createSql = null;
					}

					yield [
						tableSchema.isView ? 'view' : 'table',
						tableSchema.name,
						tableSchema.name,
						createSql
					] as Row;
				}

				// Process Functions
				for (const funcSchema of schemaInstance._getAllFunctions()) {
					yield [
						'function',
						funcSchema.name,
						funcSchema.name,
						stringifyCreateFunction(funcSchema)
					] as Row;
				}
			};

			// Process main schema
			yield* processSchemaInstance(schemaManager.getMainSchema());

			// Process temp schema
			yield* processSchemaInstance(schemaManager.getTempSchema());

		} catch (error: any) {
			// If schema introspection fails, yield an error row
			yield ['error', 'schema_error', 'schema_error', `Failed to introspect schema: ${error.message}`];
		}
	}
);

// Table information function (table-valued function)
export const tableInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'table_info',
		numArgs: 1,
		deterministic: false, // Table structure can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'cid', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'notnull', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'dflt_value', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'pk', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database, tableName: SqlValue): AsyncIterable<Row> {
		if (typeof tableName !== 'string') {
			throw new QuereusError('table_info() requires a table name string argument', StatusCode.ERROR);
		}

		try {
			const table = db._findTable(tableName);
			if (!table) {
				throw new QuereusError(`Table '${tableName}' not found`, StatusCode.ERROR);
			}

			for (let i = 0; i < table.columns.length; i++) {
				const column = table.columns[i];
				const isPrimaryKey = table.primaryKeyDefinition.some(pk => pk.index === i);

				yield [
					i,                                    // cid
					column.name,                         // name
					column.affinity || SqlDataType.TEXT, // type
					column.notNull ? 1 : 0,             // notnull
					column.defaultValue?.toString() || null, // dflt_value
					isPrimaryKey ? 1 : 0                // pk
				];
			}
		} catch (error: any) {
			// If table info fails, yield an error row
			yield [0, 'error', 'error', 1, `Failed to get table info: ${error.message}`, 0];
		}
	}
);

// Function information function (table-valued function)
export const functionInfoFunc = createIntegratedTableValuedFunction(
	{
		name: 'function_info',
		numArgs: 0,
		deterministic: false, // Functions can change
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'name', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'num_args', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'deterministic', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'flags', type: { typeClass: 'scalar', affinity: SqlDataType.INTEGER, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'signature', type: { typeClass: 'scalar', affinity: SqlDataType.TEXT, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database): AsyncIterable<Row> {
		try {
			const schemaManager = db.schemaManager;

			const processFunctions = function* (schemaInstance: any) {
				for (const funcSchema of schemaInstance._getAllFunctions()) {
					const isDeterministic = (funcSchema.flags & 0x800) !== 0; // FunctionFlags.DETERMINISTIC

					yield [
						funcSchema.name,                           // name
						funcSchema.numArgs,                       // num_args
						funcSchema.type,                          // type
						isDeterministic ? 1 : 0,                 // deterministic
						funcSchema.flags,                         // flags
						stringifyCreateFunction(funcSchema)       // signature
					] as Row;
				}
			};

			// Process main schema functions
			yield* processFunctions(schemaManager.getMainSchema());

			// Process temp schema functions
			yield* processFunctions(schemaManager.getTempSchema());

		} catch (error: any) {
			// If function info fails, yield an error row
			yield ['error', -1, 'error', 0, 0, `Failed to get function info: ${error.message}`];
		}
	}
);
