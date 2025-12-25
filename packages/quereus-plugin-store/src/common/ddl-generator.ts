/**
 * DDL generation utilities for schema persistence.
 *
 * Generates CREATE TABLE and CREATE INDEX statements from schema objects.
 */

import type { TableSchema, IndexSchema } from '@quereus/quereus';

/**
 * Generate a CREATE TABLE statement from a TableSchema.
 */
export function generateTableDDL(tableSchema: TableSchema): string {
  const parts: string[] = ['CREATE TABLE'];

  if (tableSchema.isTemporary) {
    parts.push('TEMP');
  }

  // Schema-qualified name
  if (tableSchema.schemaName && tableSchema.schemaName !== 'main') {
    parts.push(`"${tableSchema.schemaName}"."${tableSchema.name}"`);
  } else {
    parts.push(`"${tableSchema.name}"`);
  }

  // Generate column definitions
  const columnDefs: string[] = [];
  for (const col of tableSchema.columns) {
    let colDef = `"${col.name}"`;
    if (col.logicalType) {
      colDef += ` ${col.logicalType.name}`;
    }
    if (col.notNull) {
      colDef += ' NOT NULL';
    }
    if (col.primaryKey && tableSchema.primaryKeyDefinition.length === 1) {
      colDef += ' PRIMARY KEY';
    }
    if (col.defaultExpr !== undefined) {
      colDef += ` DEFAULT ${formatDefaultValue(col.defaultExpr)}`;
    }
    columnDefs.push(colDef);
  }

  // Add table-level PRIMARY KEY if composite
  if (tableSchema.primaryKeyDefinition.length > 1) {
    const pkCols = tableSchema.primaryKeyDefinition
      .map(pk => `"${tableSchema.columns[pk.index].name}"`)
      .join(', ');
    columnDefs.push(`PRIMARY KEY (${pkCols})`);
  }

  parts.push(`(${columnDefs.join(', ')})`);

  // Add USING clause for virtual table module
  if (tableSchema.vtabModuleName) {
    parts.push(`USING ${tableSchema.vtabModuleName}`);
    if (tableSchema.vtabArgs && Object.keys(tableSchema.vtabArgs).length > 0) {
      const args = Object.entries(tableSchema.vtabArgs)
        .map(([key, value]) => `${key} = ${formatArgValue(value)}`)
        .join(', ');
      parts.push(`(${args})`);
    }
  }

  return parts.join(' ');
}

/**
 * Generate a CREATE INDEX statement from an IndexSchema and TableSchema.
 */
export function generateIndexDDL(
  indexSchema: IndexSchema,
  tableSchema: TableSchema
): string {
  const parts: string[] = ['CREATE INDEX'];

  parts.push(`"${indexSchema.name}"`);
  parts.push('ON');

  // Schema-qualified table name
  if (tableSchema.schemaName && tableSchema.schemaName !== 'main') {
    parts.push(`"${tableSchema.schemaName}"."${tableSchema.name}"`);
  } else {
    parts.push(`"${tableSchema.name}"`);
  }

  // Index columns
  const columns = indexSchema.columns.map(col => {
    let colStr = `"${tableSchema.columns[col.index].name}"`;
    if (col.collation) {
      colStr += ` COLLATE ${col.collation}`;
    }
    if (col.desc) {
      colStr += ' DESC';
    }
    return colStr;
  });

  parts.push(`(${columns.join(', ')})`);

  return parts.join(' ');
}

/**
 * Format a default value expression for DDL.
 */
function formatDefaultValue(expr: unknown): string {
  if (expr === null) return 'NULL';
  if (typeof expr === 'string') return `'${expr.replace(/'/g, "''")}'`;
  if (typeof expr === 'number' || typeof expr === 'bigint') return String(expr);
  if (typeof expr === 'boolean') return expr ? '1' : '0';
  // For complex expressions, attempt to stringify
  return String(expr);
}

/**
 * Format a vtab argument value for DDL.
 */
function formatArgValue(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return JSON.stringify(value);
}

