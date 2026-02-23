import type { PlanningContext } from '../planning-context.js';
import type { TableSchema, ForeignKeyConstraintSchema, RowConstraintSchema } from '../../schema/table.js';
import { RowOpFlag, type RowOpMask } from '../../schema/table.js';
import type { Attribute, ScalarPlanNode } from '../nodes/plan-node.js';
import type { ConstraintCheck } from '../nodes/constraint-check-node.js';
import { RegisteredScope } from '../scopes/registered.js';
import { buildExpression } from './expression.js';
import { ColumnReferenceNode } from '../nodes/reference.js';
import * as AST from '../../parser/ast.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('planner:fk-builder');

/**
 * Resolves referenced column names to indices in the parent table.
 * If no column names are specified, uses the parent's primary key columns.
 */
function resolveReferencedColumns(
	fk: ForeignKeyConstraintSchema,
	parentSchema: TableSchema,
): number[] {
	const fkWithNames = fk as ForeignKeyConstraintSchema & { _referencedColumnNames?: string[] };
	const refColNames = fkWithNames._referencedColumnNames;

	if (refColNames && refColNames.length > 0) {
		return refColNames.map(name => {
			const idx = parentSchema.columnIndexMap.get(name.toLowerCase());
			if (idx === undefined) {
				throw new Error(`Referenced column '${name}' not found in table '${parentSchema.name}'`);
			}
			return idx;
		});
	}

	// Default to primary key columns
	return parentSchema.primaryKeyDefinition.map(pk => pk.index);
}

/**
 * Synthesizes an EXISTS(...) AST expression that checks whether a matching row
 * exists in the parent table for the given FK columns.
 *
 * Generates: EXISTS(SELECT 1 FROM parent WHERE parent.col1 = NEW.fk1 AND parent.col2 = NEW.fk2)
 */
function synthesizeExistsCheck(
	fk: ForeignKeyConstraintSchema,
	childTable: TableSchema,
	parentTable: TableSchema,
	parentColIndices: number[],
	qualifier: 'new' | 'old',
): AST.ExistsExpr {
	// Build WHERE clause: parent.col1 = NEW.fk_col1 AND parent.col2 = NEW.fk_col2
	const conditions: AST.Expression[] = fk.columns.map((childColIdx, i) => {
		const childCol = childTable.columns[childColIdx];
		const parentCol = parentTable.columns[parentColIndices[i]];

		const parentRef: AST.ColumnExpr = {
			type: 'column',
			name: parentCol.name,
			table: parentTable.name,
		};

		const childRef: AST.ColumnExpr = {
			type: 'column',
			name: childCol.name,
			table: qualifier.toUpperCase(),
		};

		return {
			type: 'binary',
			operator: '=',
			left: parentRef,
			right: childRef,
		} as AST.BinaryExpr;
	});

	const whereExpr = conditions.length === 1
		? conditions[0]
		: conditions.reduce((acc, cond) => ({
			type: 'binary',
			operator: 'AND',
			left: acc,
			right: cond,
		} as AST.BinaryExpr));

	const selectStmt: AST.SelectStmt = {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'literal', value: 1 } as AST.LiteralExpr }],
		from: [{
			type: 'table',
			table: { type: 'identifier', name: parentTable.name },
		} as AST.TableSource],
		where: whereExpr,
	};

	return {
		type: 'exists',
		subquery: selectStmt,
	};
}

/**
 * Synthesizes a NOT EXISTS(...) AST expression that checks no child rows
 * reference the old parent values.
 *
 * Generates: NOT EXISTS(SELECT 1 FROM child WHERE child.fk1 = OLD.pk1 AND ...)
 */
function synthesizeNotExistsCheck(
	fk: ForeignKeyConstraintSchema,
	childTable: TableSchema,
	parentTable: TableSchema,
	parentColIndices: number[],
): AST.UnaryExpr {
	// Build WHERE clause: child.fk_col1 = OLD.pk_col1 AND child.fk_col2 = OLD.pk_col2
	const conditions: AST.Expression[] = fk.columns.map((childColIdx, i) => {
		const childCol = childTable.columns[childColIdx];
		const parentCol = parentTable.columns[parentColIndices[i]];

		const childRef: AST.ColumnExpr = {
			type: 'column',
			name: childCol.name,
			table: childTable.name,
		};

		const parentRef: AST.ColumnExpr = {
			type: 'column',
			name: parentCol.name,
			table: 'OLD',
		};

		return {
			type: 'binary',
			operator: '=',
			left: childRef,
			right: parentRef,
		} as AST.BinaryExpr;
	});

	const whereExpr = conditions.length === 1
		? conditions[0]
		: conditions.reduce((acc, cond) => ({
			type: 'binary',
			operator: 'AND',
			left: acc,
			right: cond,
		} as AST.BinaryExpr));

	const selectStmt: AST.SelectStmt = {
		type: 'select',
		columns: [{ type: 'column', expr: { type: 'literal', value: 1 } as AST.LiteralExpr }],
		from: [{
			type: 'table',
			table: { type: 'identifier', name: childTable.name },
		} as AST.TableSource],
		where: whereExpr,
	};

	return {
		type: 'unary',
		operator: 'NOT',
		expr: {
			type: 'exists',
			subquery: selectStmt,
		} as AST.ExistsExpr,
	};
}

/**
 * Builds child-side FK constraint checks (for INSERT/UPDATE on the referencing table).
 * For each FK, generates an EXISTS check ensuring the parent row exists.
 */
export function buildChildSideFKChecks(
	ctx: PlanningContext,
	tableSchema: TableSchema,
	operation: RowOpFlag,
	oldAttributes: Attribute[],
	newAttributes: Attribute[],
	contextAttributes: Attribute[] = [],
): ConstraintCheck[] {
	if (!tableSchema.foreignKeys || tableSchema.foreignKeys.length === 0) return [];
	// Child-side only applies to INSERT and UPDATE
	if (operation !== RowOpFlag.INSERT && operation !== RowOpFlag.UPDATE) return [];

	const checks: ConstraintCheck[] = [];

	for (const fk of tableSchema.foreignKeys) {
		// Resolve parent table
		const parentSchema = ctx.schemaManager.findTable(
			fk.referencedTable,
			fk.referencedSchema,
		);
		if (!parentSchema) {
			log(`FK check skipped: parent table '${fk.referencedTable}' not found`);
			continue;
		}

		const parentColIndices = resolveReferencedColumns(fk, parentSchema);
		if (parentColIndices.length !== fk.columns.length) {
			log(`FK check skipped: column count mismatch for FK '${fk.name}'`);
			continue;
		}

		// Synthesize EXISTS(SELECT 1 FROM parent WHERE parent.ref = NEW.fk)
		const existsExpr = synthesizeExistsCheck(fk, tableSchema, parentSchema, parentColIndices, 'new');

		// Build as a RowConstraintSchema so it integrates with existing infrastructure
		const syntheticConstraint: RowConstraintSchema = {
			name: fk.name ?? `_fk_${tableSchema.name}`,
			expr: existsExpr,
			operations: (RowOpFlag.INSERT | RowOpFlag.UPDATE) as RowOpMask,
			deferrable: true,
			initiallyDeferred: true,
		};

		// Build the expression using a scope with OLD/NEW column access
		const constraintScope = new RegisteredScope(ctx.scope);

		// Register mutation context variables
		contextAttributes.forEach((attr, contextVarIndex) => {
			if (contextVarIndex < (tableSchema.mutationContext?.length || 0)) {
				const contextVar = tableSchema.mutationContext![contextVarIndex];
				const varNameLower = contextVar.name.toLowerCase();
				constraintScope.subscribeFactory(varNameLower, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
				);
			}
		});

		// Register column symbols
		tableSchema.columns.forEach((tableColumn, tableColIndex) => {
			const colNameLower = tableColumn.name.toLowerCase();

			const newAttr = newAttributes[tableColIndex];
			if (newAttr) {
				const newColumnType = {
					typeClass: 'scalar' as const,
					logicalType: tableColumn.logicalType,
					nullable: !tableColumn.notNull,
					isReadOnly: false,
				};

				constraintScope.registerSymbol(`new.${colNameLower}`, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttr.id, tableColIndex));

				if (operation === RowOpFlag.INSERT || operation === RowOpFlag.UPDATE) {
					constraintScope.registerSymbol(colNameLower, (exp, s) =>
						new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttr.id, tableColIndex));
				}
			}

			const oldAttr = oldAttributes[tableColIndex];
			if (oldAttr) {
				const oldColumnType = {
					typeClass: 'scalar' as const,
					logicalType: tableColumn.logicalType,
					nullable: true,
					isReadOnly: false,
				};

				constraintScope.registerSymbol(`old.${colNameLower}`, (exp, s) =>
					new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldColumnType, oldAttr.id, tableColIndex));
			}
		});

		const originalCurrentSchema = ctx.schemaManager.getCurrentSchemaName();
		const needsSchemaSwitch = tableSchema.schemaName !== originalCurrentSchema;
		if (needsSchemaSwitch) ctx.schemaManager.setCurrentSchema(tableSchema.schemaName);

		try {
			const constraintSchemaPath = [tableSchema.schemaName];
			const constraintCtx = { ...ctx, scope: constraintScope, schemaPath: constraintSchemaPath };

			const expression = buildExpression(constraintCtx, existsExpr) as ScalarPlanNode;

			checks.push({
				constraint: syntheticConstraint,
				expression,
				deferrable: true,
				initiallyDeferred: true,
				containsSubquery: true,
			});
		} finally {
			if (needsSchemaSwitch) ctx.schemaManager.setCurrentSchema(originalCurrentSchema);
		}
	}

	return checks;
}

/**
 * Builds parent-side FK constraint checks (for DELETE/UPDATE on the referenced table).
 * For each FK that references this table, generates a NOT EXISTS check for RESTRICT/NO ACTION.
 */
export function buildParentSideFKChecks(
	ctx: PlanningContext,
	tableSchema: TableSchema,
	operation: RowOpFlag,
	oldAttributes: Attribute[],
	newAttributes: Attribute[],
	contextAttributes: Attribute[] = [],
): ConstraintCheck[] {
	// Parent-side only applies to DELETE and UPDATE
	if (operation !== RowOpFlag.DELETE && operation !== RowOpFlag.UPDATE) return [];

	const checks: ConstraintCheck[] = [];

	// Find all tables that have FKs referencing this table
	for (const schema of ctx.schemaManager._getAllSchemas()) {
		for (const childTable of schema.getAllTables()) {
			if (!childTable.foreignKeys) continue;

			for (const fk of childTable.foreignKeys) {
				if (fk.referencedTable.toLowerCase() !== tableSchema.name.toLowerCase()) continue;

				const action = operation === RowOpFlag.DELETE ? fk.onDelete : fk.onUpdate;

				// Only RESTRICT and NO ACTION generate parent-side checks
				// CASCADE, SET NULL, SET DEFAULT are handled by cascading actions (Phase 2)
				if (action !== 'restrict' && action !== 'noAction') continue;

				const parentColIndices = resolveReferencedColumns(fk, tableSchema);
				if (parentColIndices.length !== fk.columns.length) continue;

				// For UPDATE, only check if the referenced columns are being modified
				// (this optimization can be added later; for now check always)

				// Synthesize NOT EXISTS(SELECT 1 FROM child WHERE child.fk = OLD.pk)
				const notExistsExpr = synthesizeNotExistsCheck(fk, childTable, tableSchema, parentColIndices);

				const isRestrict = action === 'restrict';
				const syntheticConstraint: RowConstraintSchema = {
					name: fk.name ?? `_fk_parent_${childTable.name}_${tableSchema.name}`,
					expr: notExistsExpr,
					operations: (RowOpFlag.DELETE | RowOpFlag.UPDATE) as RowOpMask,
					deferrable: !isRestrict, // RESTRICT is immediate
					initiallyDeferred: !isRestrict,
				};

				// Build scope with OLD/NEW column access
				const constraintScope = new RegisteredScope(ctx.scope);

				contextAttributes.forEach((attr, contextVarIndex) => {
					if (contextVarIndex < (tableSchema.mutationContext?.length || 0)) {
						const contextVar = tableSchema.mutationContext![contextVarIndex];
						constraintScope.subscribeFactory(contextVar.name.toLowerCase(), (exp, s) =>
							new ColumnReferenceNode(s, exp as AST.ColumnExpr, attr.type, attr.id, contextVarIndex)
						);
					}
				});

				tableSchema.columns.forEach((tableColumn, tableColIndex) => {
					const colNameLower = tableColumn.name.toLowerCase();

					const oldAttr = oldAttributes[tableColIndex];
					if (oldAttr) {
						const oldColumnType = {
							typeClass: 'scalar' as const,
							logicalType: tableColumn.logicalType,
							nullable: !tableColumn.notNull,
							isReadOnly: false,
						};

						constraintScope.registerSymbol(`old.${colNameLower}`, (exp, s) =>
							new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldColumnType, oldAttr.id, tableColIndex));

						// For DELETE, unqualified defaults to OLD
						if (operation === RowOpFlag.DELETE) {
							constraintScope.registerSymbol(colNameLower, (exp, s) =>
								new ColumnReferenceNode(s, exp as AST.ColumnExpr, oldColumnType, oldAttr.id, tableColIndex));
						}
					}

					const newAttr = newAttributes[tableColIndex];
					if (newAttr) {
						const newColumnType = {
							typeClass: 'scalar' as const,
							logicalType: tableColumn.logicalType,
							nullable: true,
							isReadOnly: false,
						};

						constraintScope.registerSymbol(`new.${colNameLower}`, (exp, s) =>
							new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttr.id, tableColIndex));

						if (operation === RowOpFlag.UPDATE) {
							constraintScope.registerSymbol(colNameLower, (exp, s) =>
								new ColumnReferenceNode(s, exp as AST.ColumnExpr, newColumnType, newAttr.id, tableColIndex));
						}
					}
				});

				const originalCurrentSchema = ctx.schemaManager.getCurrentSchemaName();
				const needsSchemaSwitch = tableSchema.schemaName !== originalCurrentSchema;
				if (needsSchemaSwitch) ctx.schemaManager.setCurrentSchema(tableSchema.schemaName);

				try {
					const constraintSchemaPath = [tableSchema.schemaName];
					const constraintCtx = { ...ctx, scope: constraintScope, schemaPath: constraintSchemaPath };

					const expression = buildExpression(constraintCtx, notExistsExpr) as ScalarPlanNode;

					checks.push({
						constraint: syntheticConstraint,
						expression,
						deferrable: !isRestrict,
						initiallyDeferred: !isRestrict,
						containsSubquery: !isRestrict, // RESTRICT must be immediate, not deferred
					});
				} finally {
					if (needsSchemaSwitch) ctx.schemaManager.setCurrentSchema(originalCurrentSchema);
				}
			}
		}
	}

	return checks;
}
