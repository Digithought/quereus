import { MisuseError, QuereusError } from '../common/errors.js';
import { StatusCode } from '../common/types.js';
import { SqlDataType } from '../common/types.js';
import type { SqlValue } from '../common/types.js';
import type { ColumnSchema } from './column.js';
import type { TableSchema, IndexSchema, RowConstraintSchema } from './table.js';
import { buildColumnIndexMap, opsToMask, RowOp } from './table.js';
import type { FunctionSchema } from './function.js';
import type { Database } from '../core/database.js';
import type { JsonDatabaseSchema, JsonSchema, JsonTableSchema, JsonColumnSchema,
	JsonFunctionSchema, JsonIndexSchema, JsonIndexColumnSchema, JsonTableConstraint} from '../core/json-schema.js';
import * as AST from '../parser/ast.js';
import type { VirtualTableModule } from '../vtab/module.js';
import { createLogger } from '../common/logger.js';

const log = createLogger('schema:serialization');
const warnLog = log.extend('warn');
const errorLog = log.extend('error');

/**
 * Converts a RowOpMask bitmask to an array of operation strings
 *
 * @param mask The RowOpMask bitmask
 * @returns Array of operation strings
 */
function maskToOpsArray(mask: number): ('insert' | 'update' | 'delete')[] {
  const ops: ('insert' | 'update' | 'delete')[] = [];
  if (mask & RowOp.INSERT) ops.push('insert');
  if (mask & RowOp.UPDATE) ops.push('update');
  if (mask & RowOp.DELETE) ops.push('delete');
  return ops;
}

/**
 * Exports a database schema (tables and function signatures) to a JSON string
 *
 * @param db The database to export the schema from
 * @returns A JSON string representing the schema
 * @throws MisuseError if the database is closed
 */
export function exportSchemaJson(db: Database): string {
  if (!db['isOpen']) throw new MisuseError("Database is closed");

  const schemaManager = db['schemaManager'];
  const output: JsonDatabaseSchema = {
    schemaVersion: 1,
    schemas: {},
  };

  for (const schema of schemaManager._getAllSchemas()) {
    const jsonSchema: JsonSchema = {
      tables: [],
      functions: [],
    };

    for (const tableSchema of schema.getAllTables()) {
      const jsonTable: JsonTableSchema = {
        name: tableSchema.name,
        columns: tableSchema.columns.map((col: ColumnSchema) => {
          const affinityKey = SqlDataType[col.affinity] as keyof typeof SqlDataType;
          let jsonDefault: string | number | null = null;
          if (typeof col.defaultValue === 'string' || typeof col.defaultValue === 'number' || col.defaultValue === null) {
            jsonDefault = col.defaultValue;
          } else if (typeof col.defaultValue === 'bigint') {
            jsonDefault = (col.defaultValue as bigint).toString() + 'n';
          } else if (col.defaultValue instanceof Uint8Array) {
            const hex = Array.from(col.defaultValue).map(b => b.toString(16).padStart(2, '0')).join('');
            jsonDefault = `x'${hex}'`;
          }

          return {
            name: col.name,
            affinity: affinityKey,
            notNull: col.notNull,
            primaryKey: col.primaryKey,
            defaultValue: jsonDefault,
            collation: col.collation,
            hidden: col.hidden,
            generated: col.generated,
          } as JsonColumnSchema;
        }),
        primaryKeyDefinition: [...tableSchema.primaryKeyDefinition],
        vtabModule: tableSchema.vtabModuleName ?? '',
        vtabArgs: tableSchema.vtabArgs ? [...tableSchema.vtabArgs] : undefined,
        indexes: tableSchema.indexes?.map((idx: IndexSchema): JsonIndexSchema => ({
          name: idx.name,
          columns: idx.columns.map((col): JsonIndexColumnSchema => ({
            index: col.index,
            desc: col.desc,
            collation: col.collation,
          })),
        })),
        checkConstraints: tableSchema.checkConstraints?.map((constraint): JsonTableConstraint => {
          const rowConstraint = constraint as RowConstraintSchema;
          return {
            type: 'check',
            name: rowConstraint.name,
            expr: null,
            operations: maskToOpsArray(rowConstraint.operations),
          };
        }),
      };
      jsonSchema.tables.push(jsonTable);
    }

    for (const funcSchema of schema._getAllFunctions()) {
      const jsonFunc: JsonFunctionSchema = {
        name: funcSchema.name,
        numArgs: funcSchema.numArgs,
        flags: funcSchema.flags,
      };
      jsonSchema.functions.push(jsonFunc);
    }

    output.schemas[schema.name] = jsonSchema;
  }

  return JSON.stringify(output, null, 2);
}

/**
 * Imports a database schema from a JSON string
 * Clears existing non-core schemas (like attached) before importing.
 * Note: Function implementations must be re-registered manually after import.
 * Virtual tables will need to be reconnected separately.
 *
 * @param db The database to import the schema into
 * @param jsonString The JSON string representing the schema
 * @throws Error on parsing errors, invalid schema format, or missing VTab modules
 */
export function importSchemaJson(db: Database, jsonString: string): void {
  if (!db['isOpen']) throw new MisuseError("Database is closed");

  const schemaManager = db['schemaManager'];
  const inTransaction = db['inTransaction'];

  if (inTransaction) throw new MisuseError("Cannot import schema during a transaction");

  let jsonData: JsonDatabaseSchema;
  try {
    jsonData = JSON.parse(jsonString);
  } catch (e: any) {
    throw new Error(`Failed to parse JSON schema: ${e.message}`);
  }

  if (jsonData.schemaVersion !== 1) {
    throw new Error(`Unsupported schema version: ${jsonData.schemaVersion}. Expected version 1.`);
  }

  schemaManager.clearAll();

  for (const schemaName in jsonData.schemas) {
    if (!Object.prototype.hasOwnProperty.call(jsonData.schemas, schemaName)) continue;

    let schema = schemaManager.getSchema(schemaName);
    if (!schema) {
      if (schemaName === 'main' || schemaName === 'temp') {
        errorLog(`Core schema %s missing during import!`, schemaName);
        throw new QuereusError(`Internal error: Core schema ${schemaName} is missing.`, StatusCode.INTERNAL);
      } else {
        schema = schemaManager.addSchema(schemaName);
      }
    } else {
      schema.clearTables();
      schema.clearFunctions();
    }

    const jsonSchema = jsonData.schemas[schemaName];

    // Import Tables
    for (const jsonTable of jsonSchema.tables) {
      const columns: ColumnSchema[] = jsonTable.columns.map(jsonCol => {
        const affinity = SqlDataType[jsonCol.affinity as keyof typeof SqlDataType];
        if (affinity === undefined) {
          throw new Error(`Invalid affinity string "${jsonCol.affinity}" for column ${jsonCol.name}`);
        }
        // Deserialize default value
        let defaultValue: SqlValue = null;
        if (typeof jsonCol.defaultValue === 'string') {
          if (jsonCol.defaultValue.endsWith('n')) {
            try { defaultValue = BigInt(jsonCol.defaultValue.slice(0, -1)); } catch { /* ignore invalid */ }
          } else if (jsonCol.defaultValue.toLowerCase().startsWith('x\'') && jsonCol.defaultValue.endsWith('\'')) {
            const hex = jsonCol.defaultValue.slice(2, -1);
            try {
              const bytes = new Uint8Array(hex.length / 2);
              for (let i = 0; i < hex.length; i += 2) {
                bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
              }
              defaultValue = bytes;
            } catch { /* ignore invalid hex */ }
          } else {
            defaultValue = jsonCol.defaultValue; // Assume string literal
          }
        } else if (typeof jsonCol.defaultValue === 'number' || jsonCol.defaultValue === null) {
          defaultValue = jsonCol.defaultValue;
        }

        return {
          name: jsonCol.name,
          affinity: affinity,
          notNull: jsonCol.notNull,
          primaryKey: jsonCol.primaryKey,
          pkOrder: jsonTable.primaryKeyDefinition.find(pk => pk.index === jsonTable.columns.indexOf(jsonCol)) ? jsonTable.primaryKeyDefinition.findIndex(pk => pk.index === jsonTable.columns.indexOf(jsonCol)) + 1 : 0,
          defaultValue: defaultValue,
          collation: jsonCol.collation,
          hidden: jsonCol.hidden,
          generated: jsonCol.generated,
        } as ColumnSchema;
      });

      // Deserialize checkConstraints
      const checkConstraints: RowConstraintSchema[] = [];
      if (jsonTable.checkConstraints) {
        for (const jsonCheck of jsonTable.checkConstraints) {
          if (jsonCheck.type === 'check') {
            const placeholderExpr: AST.LiteralExpr = { type: 'literal', value: null };

            checkConstraints.push({
              name: jsonCheck.name,
              expr: placeholderExpr,
              operations: opsToMask(jsonCheck.operations as any),
            });
          }
        }
      }

      // Find the corresponding VTab module registered in the database
      const vtabModuleName = jsonTable.vtabModule;
      const moduleInfo = db._getVtabModule(vtabModuleName);
      if (!moduleInfo) {
        throw new QuereusError(`Virtual table module '${vtabModuleName}' for table '${jsonTable.name}' is not registered with the current Database instance. Cannot import schema.`, StatusCode.ERROR);
      }
      const vtabModule: VirtualTableModule<any, any> = moduleInfo.module;

      const tableSchema: TableSchema = {
        name: jsonTable.name,
        schemaName: schemaName,
        checkConstraints: Object.freeze(checkConstraints),
        columns: Object.freeze(columns),
        columnIndexMap: Object.freeze(buildColumnIndexMap(columns)),
        primaryKeyDefinition: Object.freeze(jsonTable.primaryKeyDefinition),
        vtabModule: vtabModule,
        vtabModuleName: vtabModuleName,
        vtabArgs: jsonTable.vtabArgs ? Object.freeze(jsonTable.vtabArgs) : undefined,
        indexes: jsonTable.indexes ? Object.freeze(jsonTable.indexes.map((jsonIdx: JsonIndexSchema): IndexSchema => ({
          name: jsonIdx.name,
          columns: Object.freeze(jsonIdx.columns.map((jsonCol: JsonIndexColumnSchema) => ({
            index: jsonCol.index,
            desc: jsonCol.desc,
            collation: jsonCol.collation,
          }))),
        }))) : undefined,
        isWithoutRowid: false,
        isStrict: false,
        isView: false,
      };
      schema.addTable(tableSchema);
    }

    // Import Functions (stubs only)
    for (const jsonFunc of jsonSchema.functions) {
      const funcSchema: FunctionSchema = {
        name: jsonFunc.name,
        numArgs: jsonFunc.numArgs,
        flags: jsonFunc.flags,
      };
      schema.addFunction(funcSchema);
    }
  }

  warnLog("Schema imported from JSON. Function implementations and VTab connections must be re-established manually.");
}
