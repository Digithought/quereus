import type { TableSchema } from '../schema/table.js';
import type { ColumnSchema } from '../schema/column.js';
import type { RelationType, ColumnDef, ScalarType, ColRef } from '../common/datatype.js';
import { SqlDataType, type SqlValue } from '../common/types.js'; // Import SqlValue and ensure SqlDataType is not type-only
// Note: getAffinity from '../schema/column.js' is used by the ColumnSchema type from table.js itself if that's what we use.
// If tableSchema.columns are of type from '../schema/column.js', then their affinity is already SqlDataType.

/**
 * Converts a TableSchema (from src/schema/table.ts) to a RelationType (from src/common/datatype.ts).
 * This is used by PlanNodes that source data directly from a base table.
 */
export function relationTypeFromTableSchema(tableSchema: TableSchema): RelationType {
  const columnDefs: ColumnDef[] = tableSchema.columns.map((col: ColumnSchema) => {
    return {
      name: col.name,
      type: {
				typeClass: 'scalar',
				affinity: col.affinity,
				collationName: col.collation,
				nullable: !col.notNull,
				isReadOnly: false,
			},
      hidden: col.hidden,
      generated: col.generated,
    };
  });

  // Populate keys from primaryKeyDefinition
  const keys: ColRef[][] = [];
  if (tableSchema.primaryKeyDefinition && tableSchema.primaryKeyDefinition.length > 0) {
    const primaryKey: ColRef[] = tableSchema.primaryKeyDefinition.map(pkCol => ({
      index: pkCol.index,
      desc: pkCol.desc,
    }));
    keys.push(primaryKey);
  }

  return {
    typeClass: 'relation',
    isReadOnly: !!(tableSchema.isView || tableSchema.isTemporary),
    columns: columnDefs,
    keys: keys,
    // TODO: Populate rowConstraints from tableSchema if/when RelationType supports them
    rowConstraints: [], // Placeholder
  };
}

/**
 * Creates a ScalarType for a given SqlValue, typically for parameters.
 * @param value The SqlValue to determine the type for.
 * @returns A ScalarType representing the inferred type of the value.
 */
export function getParameterScalarType(value: SqlValue): ScalarType {
  let affinity: SqlDataType;
  if (value === null) affinity = SqlDataType.NULL;
  else if (typeof value === 'number') affinity = SqlDataType.REAL;
  else if (typeof value === 'bigint') affinity = SqlDataType.INTEGER;
  else if (typeof value === 'string') affinity = SqlDataType.TEXT;
  else if (value instanceof Uint8Array) affinity = SqlDataType.BLOB;
  else if (typeof value === 'boolean') affinity = SqlDataType.INTEGER; // Store booleans as INTEGER
  else affinity = SqlDataType.BLOB; // Default for unknown types that might pass as SqlValue

  return {
    typeClass: 'scalar',
    affinity: affinity,
    nullable: true,	// No guarantees about the value, so it's nullable
    isReadOnly: true, // Parameters are read-only within the query execution context
  };
}
