import type { Row } from "../../common/types.js";
import type { SqlValue } from "../../common/types.js";
import { createIntegratedTableValuedFunction } from "../registration.js";
import { QuereusError } from "../../common/errors.js";
import { StatusCode } from "../../common/types.js";
import type { Database } from "../../core/database.js";
import type { FunctionSchema } from "../../schema/function.js";
import { isScalarFunctionSchema, isTableValuedFunctionSchema, isAggregateFunctionSchema, isWindowFunctionSchema } from "../../schema/function.js";
import { Schema } from "../../schema/schema.js";
import { INTEGER_TYPE, TEXT_TYPE } from "../../types/builtin-types.js";
import { ColumnSchema } from "../../schema/column.js";

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
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'tbl_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'sql', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database): AsyncIterable<Row> {
		try {
			const schemaManager = db.schemaManager;

			const processSchemaInstance = function* (schemaInstance: Schema) {
				// Process Tables
				for (const tableSchema of schemaInstance.getAllTables()) {
					let createSql: string | null = null;
					try {
						const columnsStr = tableSchema.columns.map((c: ColumnSchema) => `"${c.name}" ${c.logicalType.name}`).join(', ');
						const argsStr = Object.entries(tableSchema.vtabArgs ?? {}).map(([key, value]) => `${key}=${value}`).join(', ');
						createSql = `create table "${tableSchema.name}" (${columnsStr}) using ${tableSchema.vtabModuleName}(${argsStr})`;
					} catch {
						createSql = null;
					}

					yield [
						tableSchema.isView ? 'view' : 'table',
						tableSchema.name,
						tableSchema.name,
						createSql
					] as Row;

					// Process Indexes for this table
					if (tableSchema.indexes) {
						for (const indexSchema of tableSchema.indexes) {
							let indexSql: string | null = null;
							try {
								const indexColumns = indexSchema.columns.map(col => {
									const column = tableSchema.columns[col.index];
									let colStr = `"${column.name}"`;
									if (col.collation) {
										colStr += ` COLLATE ${col.collation}`;
									}
									if (col.desc) {
										colStr += ' DESC';
									}
									return colStr;
								}).join(', ');
								indexSql = `CREATE INDEX "${indexSchema.name}" ON "${tableSchema.name}" (${indexColumns})`;
							} catch {
								indexSql = null;
							}

							yield [
								'index',
								indexSchema.name,
								tableSchema.name,
								indexSql
							] as Row;
						}
					}
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

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
				{ name: 'cid', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'notnull', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'dflt_value', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'pk', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true }
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
					column.logicalType.name,             // type
					column.notNull ? 1 : 0,             // notnull
					column.defaultValue?.toString() || null, // dflt_value
					isPrimaryKey ? 1 : 0                // pk
				];
			}
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
				{ name: 'name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'num_args', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'type', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'deterministic', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'flags', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'signature', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true }
			],
			keys: [],
			rowConstraints: []
		}
	},
	async function* (db: Database): AsyncIterable<Row> {
		try {
			const schemaManager = db.schemaManager;

			const processFunctions = function* (schemaInstance: Schema) {
				for (const funcSchema of schemaInstance._getAllFunctions()) {
					const isDeterministic = (funcSchema.flags & 0x800) !== 0; // FunctionFlags.DETERMINISTIC

					// Determine function type based on schema type guards
					let functionType: string;
					if (isScalarFunctionSchema(funcSchema)) {
						functionType = 'scalar';
					} else if (isTableValuedFunctionSchema(funcSchema)) {
						functionType = 'table';
					} else if (isAggregateFunctionSchema(funcSchema)) {
						functionType = 'aggregate';
					} else if (isWindowFunctionSchema(funcSchema)) {
						functionType = 'window';
					} else {
						functionType = 'unknown';
					}

					yield [
						funcSchema.name,                           // name
						funcSchema.numArgs,                       // num_args
						functionType,                             // type
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

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (error: any) {
			// If function info fails, yield an error row
			yield ['error', -1, 'error', 0, 0, `Failed to get function info: ${error.message}`];
		}
	}
);
