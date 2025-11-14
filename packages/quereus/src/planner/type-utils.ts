import type { TableSchema } from '../schema/table.js';
import type { ColumnSchema } from '../schema/column.js';
import type { RelationType, ColumnDef, ScalarType, ColRef } from '../common/datatype.js';
import { SqlDataType, StatusCode, type DeepReadonly, type SqlValue } from '../common/types.js'; // Import SqlValue and ensure SqlDataType is not type-only
import type { AstNode } from '../parser/ast.js';
import { QuereusError } from '../common/errors.js';
import { inferLogicalTypeFromValue } from '../common/type-inference.js';

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
				logicalType: col.logicalType,
				collationName: col.collation,
				nullable: !col.notNull,
				isReadOnly: false,
			},
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
    isSet: true, // Base tables are sets by definition (enforced by primary keys)
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
  const logicalType = inferLogicalTypeFromValue(value);

  return {
    typeClass: 'scalar',
    logicalType,
    nullable: true,	// No guarantees about the value, so it's nullable
    isReadOnly: true, // Parameters are read-only within the query execution context
  };
}

export function checkColumnsAssignable(source: DeepReadonly<ColumnDef[]>, target: DeepReadonly<ColumnDef[]>, astNode?: AstNode): void {
	if (source.length !== target.length) {
		throw new QuereusError(`Column count mismatch ${(astNode ? astNode.type + ' clause' : '')}.`, StatusCode.ERROR, undefined, astNode?.loc?.start.line, astNode?.loc?.start.column);
	}
}

export function checkRelationsAssignable(source: RelationType, target: RelationType, astNode?: AstNode): void {
	return checkColumnsAssignable(source.columns, target.columns, astNode);
}

export function columnSchemaToDef(colName: string, colDef: ColumnSchema): ColumnDef {
	return {
		name: colName,
		type: {
			typeClass: 'scalar',
			logicalType: colDef.logicalType,
			collationName: colDef.collation,
			nullable: !colDef.notNull,
			isReadOnly: false,
		},
		generated: colDef.generated,
	};
}
