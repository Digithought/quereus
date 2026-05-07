import type { AlterTableNode } from '../../planner/nodes/alter-table-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { type SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { TableSchema, PrimaryKeyColumnDefinition, RowConstraintSchema, ForeignKeyConstraintSchema } from '../../schema/table.js';
import { buildColumnIndexMap, opsToMask } from '../../schema/table.js';
import type { ColumnDef } from '../../parser/ast.js';
import { MemoryTableModule } from '../../vtab/memory/module.js';
import { quoteIdentifier, expressionToString, selectToString } from '../../emit/ast-stringify.js';
import { renameTableInAst, renameColumnInAst } from '../../schema/rename-rewriter.js';
import type { Schema } from '../../schema/schema.js';

const log = createLogger('runtime:emit:alter-table');

export function emitAlterTable(plan: AlterTableNode, _ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;
	const action = plan.action;

	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		const schemaManager = rctx.db.schemaManager;
		const schema = schemaManager.getSchemaOrFail(tableSchema.schemaName);

		switch (action.type) {
			case 'renameTable':
				return runRenameTable(rctx, tableSchema, schema, action.newName);
			case 'renameColumn':
				return runRenameColumn(rctx, tableSchema, schema, action.oldName, action.newName);
			case 'addColumn':
				return runAddColumn(rctx, tableSchema, schema, action.column);
			case 'dropColumn':
				return runDropColumn(rctx, tableSchema, schema, action.name);
			case 'alterPrimaryKey':
				return runAlterPrimaryKey(rctx, tableSchema, schema, action.columns);
			case 'alterColumn':
				return runAlterColumn(rctx, tableSchema, schema, action);
		}
	}

	const note = (() => {
		switch (action.type) {
			case 'renameTable': return `renameTable(${tableSchema.name} -> ${action.newName})`;
			case 'renameColumn': return `renameColumn(${tableSchema.name}.${action.oldName} -> ${action.newName})`;
			case 'addColumn': return `addColumn(${tableSchema.name}.${action.column.name})`;
			case 'dropColumn': return `dropColumn(${tableSchema.name}.${action.name})`;
			case 'alterPrimaryKey': return `alterPrimaryKey(${tableSchema.name} -> [${action.columns.map(c => c.name).join(', ')}])`;
			case 'alterColumn': return `alterColumn(${tableSchema.name}.${action.columnName})`;
		}
	})();

	return {
		params: [],
		run: run as InstructionRun,
		note,
	};
}

async function runRenameTable(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	newName: string,
): Promise<SqlValue> {
	const oldName = tableSchema.name;

	// Check for name conflict
	if (schema.getTable(newName)) {
		throw new QuereusError(`Table '${newName}' already exists`, StatusCode.ERROR);
	}

	// Clone schema with new name
	const updatedTableSchema: TableSchema = {
		...tableSchema,
		name: newName,
	};

	// Let the module re-key its internal state and move any physical storage
	// BEFORE we mutate the in-memory catalog, so a module failure leaves the
	// catalog untouched. Modules that don't persist by table name can simply
	// omit the hook.
	const module = tableSchema.vtabModule;
	if (module.renameTable) {
		await module.renameTable(rctx.db, tableSchema.schemaName, oldName, newName);
	}

	// Remove old, add new in the catalog
	schema.removeTable(oldName);
	schema.addTable(updatedTableSchema);

	// Notify schema change
	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: newName,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	// Propagate the rename into dependent objects (CHECK / FK in this and other
	// tables, view bodies). Best-effort AST rewrite — there is no global
	// dependency tracker yet, so we walk the catalog and patch in-place.
	propagateTableRename(rctx, tableSchema.schemaName, oldName, newName);

	log('Renamed table %s.%s to %s', tableSchema.schemaName, oldName, newName);
	return null;
}

async function runRenameColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	oldName: string,
	newName: string,
): Promise<SqlValue> {
	const colIndex = tableSchema.columnIndexMap.get(oldName.toLowerCase());
	if (colIndex === undefined) {
		throw new QuereusError(`Column '${oldName}' not found in table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	const newNameLower = newName.toLowerCase();
	if (oldName.toLowerCase() !== newNameLower && tableSchema.columnIndexMap.has(newNameLower)) {
		throw new QuereusError(`Column '${newName}' already exists in table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	const existingCol = tableSchema.columns[colIndex];

	// Build a ColumnDef AST for the renamed column (preserving type info)
	const newColumnDef: ColumnDef = {
		name: newName,
		dataType: existingCol.logicalType.name,
		constraints: buildConstraintsFromColumn(existingCol),
	};

	// Call module.alterTable if available (handles data-level changes)
	const module = tableSchema.vtabModule;
	let updatedTableSchema: TableSchema;

	if (module.alterTable) {
		updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
			type: 'renameColumn',
			oldName,
			newName,
			newColumnDefAst: newColumnDef,
		});
	} else {
		// Schema-only rename (no data-level changes needed for rename)
		const updatedCols = tableSchema.columns.map((c, i) =>
			i === colIndex ? { ...c, name: newName } : c
		);
		updatedTableSchema = {
			...tableSchema,
			columns: Object.freeze(updatedCols),
			columnIndexMap: buildColumnIndexMap(updatedCols),
		};
	}

	// Update the schema catalog
	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	// Propagate the rename into dependent objects (CHECK / FK in this and other
	// tables, view bodies).
	propagateColumnRename(rctx, tableSchema.schemaName, tableSchema.name, oldName, newName);

	log('Renamed column %s.%s.%s to %s', tableSchema.schemaName, tableSchema.name, oldName, newName);
	return null;
}

async function runAddColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	columnDef: ColumnDef,
): Promise<SqlValue> {
	// Validate column doesn't already exist
	if (tableSchema.columnIndexMap.has(columnDef.name.toLowerCase())) {
		throw new QuereusError(`Column '${columnDef.name}' already exists in table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	// Validate no PK column addition
	if (columnDef.constraints?.some(c => c.type === 'primaryKey')) {
		throw new QuereusError(`Cannot add a PRIMARY KEY column via ALTER TABLE`, StatusCode.ERROR);
	}

	// Call module.alterTable for data + schema update
	const module = tableSchema.vtabModule;
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ALTER TABLE ADD COLUMN`,
			StatusCode.UNSUPPORTED,
		);
	}

	// Extract column-level CHECK / FK constraints. Column-level UNIQUE is not enforced via
	// table-level constraints; the existing rejection path in the manager handles it.
	const newCheckConstraints = extractColumnLevelCheckConstraints(columnDef);
	const newForeignKeys = extractColumnLevelForeignKeys(columnDef, tableSchema.schemaName);

	const updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
		type: 'addColumn',
		columnDef,
	});

	// Resolve the new child column index in the freshly returned schema for any FK constraints.
	const newColIdx = updatedTableSchema.columnIndexMap.get(columnDef.name.toLowerCase());
	const resolvedForeignKeys = newColIdx !== undefined
		? newForeignKeys.map(fk => ({ ...fk, columns: Object.freeze([newColIdx]) }))
		: newForeignKeys;

	// Merge new column-level CHECK / FK into the table-level constraint sets so the
	// existing constraint-builder picks them up for INSERT/UPDATE enforcement.
	const mergedChecks = newCheckConstraints.length > 0
		? Object.freeze([...updatedTableSchema.checkConstraints, ...newCheckConstraints])
		: updatedTableSchema.checkConstraints;
	const mergedForeignKeys = resolvedForeignKeys.length > 0
		? Object.freeze([...(updatedTableSchema.foreignKeys ?? []), ...resolvedForeignKeys])
		: updatedTableSchema.foreignKeys;

	const enhancedTableSchema: TableSchema = Object.freeze({
		...updatedTableSchema,
		checkConstraints: mergedChecks,
		foreignKeys: mergedForeignKeys,
	});

	// Register the enhanced schema BEFORE backfill validation so that SQL bound
	// during validation can resolve the new column.
	schema.addTable(enhancedTableSchema);

	if (newCheckConstraints.length > 0) {
		try {
			await validateBackfillAgainstChecks(rctx, enhancedTableSchema, newCheckConstraints);
		} catch (err) {
			// Revert: drop the column and restore the original catalog entry.
			try {
				await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
					type: 'dropColumn',
					columnName: columnDef.name,
				});
			} catch (revertErr) {
				log('Failed to revert ADD COLUMN after CHECK violation: %s', (revertErr as Error).message);
			}
			schema.addTable(tableSchema);
			throw err;
		}
	}

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: enhancedTableSchema,
	});

	log('Added column %s to table %s.%s', columnDef.name, tableSchema.schemaName, tableSchema.name);
	return null;
}

function extractColumnLevelCheckConstraints(columnDef: ColumnDef): RowConstraintSchema[] {
	const result: RowConstraintSchema[] = [];
	for (const con of columnDef.constraints ?? []) {
		if (con.type !== 'check' || !con.expr) continue;
		result.push({
			name: con.name ?? `_check_${columnDef.name}`,
			expr: con.expr,
			operations: opsToMask(con.operations),
			deferrable: con.deferrable,
			initiallyDeferred: con.initiallyDeferred,
			tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
		});
	}
	return result;
}

function extractColumnLevelForeignKeys(
	columnDef: ColumnDef,
	defaultSchemaName: string,
): ForeignKeyConstraintSchema[] {
	const result: ForeignKeyConstraintSchema[] = [];
	for (const con of columnDef.constraints ?? []) {
		if (con.type !== 'foreignKey' || !con.foreignKey) continue;
		const fk = con.foreignKey;
		// child column index gets resolved by caller after module.alterTable returns
		// the updated schema with the new column appended.
		// When the ADD COLUMN clause omits ON DELETE/UPDATE, default to 'restrict' so
		// the FK is actually enforced child-side on INSERT/UPDATE — buildChildSideFKChecks
		// skips FKs whose onDelete and onUpdate are both 'ignore'.
		result.push({
			name: con.name ?? `_fk_${columnDef.name}`,
			columns: Object.freeze([]),
			referencedTable: fk.table,
			referencedSchema: defaultSchemaName,
			referencedColumns: Object.freeze([]),
			referencedColumnNames: fk.columns,
			onDelete: fk.onDelete ?? 'restrict',
			onUpdate: fk.onUpdate ?? 'restrict',
			deferred: fk.initiallyDeferred ?? false,
			tags: con.tags && Object.keys(con.tags).length > 0 ? Object.freeze({ ...con.tags }) : undefined,
		});
	}
	return result;
}

/**
 * Runs each new CHECK against existing rows. We rely on the just-registered
 * enhanced schema so SQL can resolve the new column. Any row matching
 * `not (<check_expr>)` is a violation and aborts the ALTER.
 */
async function validateBackfillAgainstChecks(
	rctx: RuntimeContext,
	enhancedTableSchema: TableSchema,
	newCheckConstraints: RowConstraintSchema[],
): Promise<void> {
	const schemaPrefix = (enhancedTableSchema.schemaName && enhancedTableSchema.schemaName.toLowerCase() !== 'main')
		? `${quoteIdentifier(enhancedTableSchema.schemaName)}.`
		: '';
	const qualifiedTable = `${schemaPrefix}${quoteIdentifier(enhancedTableSchema.name)}`;

	for (const cc of newCheckConstraints) {
		const checkSql = expressionToString(cc.expr);
		const sql = `select 1 from ${qualifiedTable} where not (${checkSql}) limit 1`;
		const stmt = rctx.db.prepare(sql);
		try {
			let violated = false;
			for await (const _row of stmt._iterateRowsRaw()) {
				violated = true;
				break;
			}
			if (violated) {
				throw new QuereusError(
					`CHECK constraint ${cc.name ? `'${cc.name}' ` : ''}violated by backfilled rows in ALTER TABLE ADD COLUMN on '${enhancedTableSchema.name}'`,
					StatusCode.CONSTRAINT,
				);
			}
		} finally {
			await stmt.finalize();
		}
	}
}

async function runDropColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	columnName: string,
): Promise<SqlValue> {
	const colIndex = tableSchema.columnIndexMap.get(columnName.toLowerCase());
	if (colIndex === undefined) {
		throw new QuereusError(`Column '${columnName}' not found in table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	// Validate: can't drop PK column
	if (tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
		throw new QuereusError(`Cannot drop PRIMARY KEY column '${columnName}'`, StatusCode.CONSTRAINT);
	}

	// Validate: can't drop last column
	if (tableSchema.columns.length <= 1) {
		throw new QuereusError(`Cannot drop the last column of table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	// Call module.alterTable for data + schema update
	const module = tableSchema.vtabModule;
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ALTER TABLE DROP COLUMN`,
			StatusCode.UNSUPPORTED,
		);
	}

	const updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
		type: 'dropColumn',
		columnName,
	});

	// Update the schema catalog
	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	log('Dropped column %s from table %s.%s', columnName, tableSchema.schemaName, tableSchema.name);
	return null;
}

async function runAlterColumn(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	action: Extract<import('../../planner/nodes/alter-table-node.js').AlterTableAction, { type: 'alterColumn' }>,
): Promise<SqlValue> {
	const colIndex = tableSchema.columnIndexMap.get(action.columnName.toLowerCase());
	if (colIndex === undefined) {
		throw new QuereusError(`Column '${action.columnName}' not found in table '${tableSchema.name}'`, StatusCode.ERROR);
	}

	// Guard: at most one of the three attribute changes per statement.
	const populated = [action.setNotNull !== undefined, action.setDataType !== undefined, action.setDefault !== undefined];
	const populatedCount = populated.filter(Boolean).length;
	if (populatedCount !== 1) {
		throw new QuereusError(
			`ALTER COLUMN requires exactly one of SET/DROP NOT NULL, SET DATA TYPE, SET/DROP DEFAULT (got ${populatedCount})`,
			StatusCode.INTERNAL,
		);
	}

	// Cannot alter a PRIMARY KEY column's nullability or data type.
	if (tableSchema.primaryKeyDefinition.some(def => def.index === colIndex)) {
		if (action.setNotNull === false) {
			throw new QuereusError(`Cannot DROP NOT NULL on PRIMARY KEY column '${action.columnName}'`, StatusCode.CONSTRAINT);
		}
		if (action.setDataType !== undefined) {
			throw new QuereusError(`Cannot SET DATA TYPE on PRIMARY KEY column '${action.columnName}'`, StatusCode.CONSTRAINT);
		}
	}

	const module = tableSchema.vtabModule;
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ALTER COLUMN`,
			StatusCode.UNSUPPORTED,
		);
	}

	const updatedTableSchema = await module.alterTable(rctx.db, tableSchema.schemaName, tableSchema.name, {
		type: 'alterColumn',
		columnName: action.columnName,
		setNotNull: action.setNotNull,
		setDataType: action.setDataType,
		setDefault: action.setDefault,
	});

	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	log('Altered column %s.%s.%s', tableSchema.schemaName, tableSchema.name, action.columnName);
	return null;
}

async function runAlterPrimaryKey(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	columns: Array<{ name: string; direction?: 'asc' | 'desc' }>,
): Promise<SqlValue> {
	const newPkDef: PrimaryKeyColumnDefinition[] = columns.map(col => {
		const idx = tableSchema.columnIndexMap.get(col.name.toLowerCase());
		if (idx === undefined) {
			throw new QuereusError(
				`Column '${col.name}' not found in table '${tableSchema.name}'`,
				StatusCode.ERROR,
			);
		}
		const colSchema = tableSchema.columns[idx];
		if (!colSchema.notNull) {
			throw new QuereusError(
				`Column '${col.name}' must be NOT NULL to participate in PRIMARY KEY`,
				StatusCode.CONSTRAINT,
			);
		}
		return { index: idx, desc: col.direction === 'desc' };
	});

	// Check for duplicate columns
	const seen = new Set<number>();
	for (const pk of newPkDef) {
		if (seen.has(pk.index)) {
			throw new QuereusError(
				`Duplicate column '${tableSchema.columns[pk.index].name}' in PRIMARY KEY definition`,
				StatusCode.ERROR,
			);
		}
		seen.add(pk.index);
	}

	// Try native module re-key first
	const module = tableSchema.vtabModule;
	if (module.alterTable) {
		try {
			const schemaChangePk = newPkDef.map(pk => ({ index: pk.index, desc: pk.desc ?? false }));
			const updatedTableSchema = await module.alterTable(
				rctx.db, tableSchema.schemaName, tableSchema.name,
				{ type: 'alterPrimaryKey', newPkColumns: schemaChangePk },
			);
			schema.addTable(updatedTableSchema);
			rctx.db.schemaManager.getChangeNotifier().notifyChange({
				type: 'table_modified',
				schemaName: tableSchema.schemaName,
				objectName: tableSchema.name,
				oldObject: tableSchema,
				newObject: updatedTableSchema,
			});
			log('Altered primary key of %s.%s (native)', tableSchema.schemaName, tableSchema.name);
			return null;
		} catch (e) {
			if (e instanceof QuereusError && e.code === StatusCode.UNSUPPORTED) {
				// Fall through to rebuild
			} else {
				throw e;
			}
		}
	}

	// Rebuild fallback
	await rebuildTableWithNewShape(rctx, tableSchema, schema, tableSchema.columns.map(c => c.name), newPkDef);

	log('Altered primary key of %s.%s (rebuild)', tableSchema.schemaName, tableSchema.name);
	return null;
}

/**
 * Rebuilds a table with a new column projection and/or primary key.
 * For MemoryTable: builds a new table via the module API and copies rows directly,
 * bypassing SQL execution to avoid transaction-layer isolation issues.
 * For other modules: uses shadow-table SQL approach with DROP+RENAME.
 */
async function rebuildTableWithNewShape(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	survivingColumns: string[],
	newPkDef: PrimaryKeyColumnDefinition[],
): Promise<void> {
	const tableName = tableSchema.name;
	const schemaName = tableSchema.schemaName;
	const module = tableSchema.vtabModule;

	if (module instanceof MemoryTableModule) {
		await rebuildMemoryTable(rctx, tableSchema, schema, module, survivingColumns, newPkDef);
	} else {
		await rebuildViaShadowTable(rctx, tableSchema, schema, survivingColumns, newPkDef);
	}

	const finalSchema = schema.getTable(tableName);
	if (finalSchema) {
		rctx.db.schemaManager.getChangeNotifier().notifyChange({
			type: 'table_modified',
			schemaName,
			objectName: tableName,
			oldObject: tableSchema,
			newObject: finalSchema,
		});
	}
}

/**
 * MemoryTable rebuild: builds a new table via module.create() and copies rows
 * directly from the old manager, then swaps in the module and catalog.
 */
async function rebuildMemoryTable(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	module: MemoryTableModule,
	survivingColumns: string[],
	newPkDef: PrimaryKeyColumnDefinition[],
): Promise<void> {
	const tableName = tableSchema.name;
	const schemaName = tableSchema.schemaName;
	const oldKey = `${schemaName}.${tableName}`.toLowerCase();
	const oldMgr = module.tables.get(oldKey);
	if (!oldMgr) {
		throw new QuereusError(`Table '${tableName}' not found in module`, StatusCode.INTERNAL);
	}

	// Build column index mapping: old column index → new column index
	const survivingIndices: number[] = [];
	const newColumns: import('../../schema/column.js').ColumnSchema[] = [];
	for (const colName of survivingColumns) {
		const oldIdx = tableSchema.columnIndexMap.get(colName.toLowerCase());
		if (oldIdx === undefined) continue;
		survivingIndices.push(oldIdx);
		newColumns.push(tableSchema.columns[oldIdx]);
	}

	// Remap PK indices from old schema to new column order
	const remappedPk: PrimaryKeyColumnDefinition[] = newPkDef.map(pk => {
		const newIdx = survivingIndices.indexOf(pk.index);
		if (newIdx === -1) {
			throw new QuereusError(`PK column index ${pk.index} not in surviving columns`, StatusCode.INTERNAL);
		}
		return { ...pk, index: newIdx };
	});

	// Build new schema
	const newSchema: TableSchema = Object.freeze({
		...tableSchema,
		columns: Object.freeze(newColumns),
		columnIndexMap: buildColumnIndexMap(newColumns),
		primaryKeyDefinition: Object.freeze(remappedPk),
		indexes: Object.freeze([]),
	});

	// Create the new table via the module API (goes directly to base layer)
	const shadowName = `${tableName}__rekey_${Date.now()}`;
	const shadowSchema: TableSchema = Object.freeze({ ...newSchema, name: shadowName });
	await module.create(rctx.db, shadowSchema);
	const shadowMgr = module.tables.get(`${schemaName}.${shadowName}`.toLowerCase());
	if (!shadowMgr) {
		throw new QuereusError(`Shadow table manager not found after create`, StatusCode.INTERNAL);
	}

	try {
		// Copy rows from old table to new, projecting surviving columns
		const rows = oldMgr.scanAllRows();
		for (const oldRow of rows) {
			const newRow = survivingIndices.map(i => oldRow[i]);
			shadowMgr.insertRow(newRow);
		}

		// Swap: remove old, remove shadow, re-register shadow under old name
		module.tables.delete(oldKey);
		module.tables.delete(`${schemaName}.${shadowName}`.toLowerCase());
		shadowMgr.renameTable(tableName);
		module.tables.set(oldKey, shadowMgr);

		// Update catalog
		schema.removeTable(tableName);
		schema.addTable(shadowMgr.tableSchema);
	} catch (e) {
		// Clean up shadow on failure
		try {
			module.tables.delete(`${schemaName}.${shadowName}`.toLowerCase());
		} catch { /* ignore */ }
		throw e;
	}
}

/**
 * Build the shadow-table CREATE TABLE DDL used by the non-memory rebuild path.
 *
 * Nullability is emitted explicitly for every column, matching the "no-db"
 * stance of `generateTableDDL` in ddl-generator.ts: safe under any session's
 * `default_column_nullability` setting. DEFAULT and COLLATE are preserved so
 * the shadow table faithfully mirrors the original schema.
 */
export function buildShadowTableDdl(
	tableSchema: TableSchema,
	shadowName: string,
	survivingColumns: string[],
	newPkDef: PrimaryKeyColumnDefinition[],
): string {
	const schemaName = tableSchema.schemaName;
	const schemaPrefix = (schemaName && schemaName.toLowerCase() !== 'main')
		? `${quoteIdentifier(schemaName)}.`
		: '';

	const colDefs: string[] = [];
	for (const colName of survivingColumns) {
		const idx = tableSchema.columnIndexMap.get(colName.toLowerCase());
		if (idx === undefined) continue;
		const col = tableSchema.columns[idx];
		let def = quoteIdentifier(col.name) + ' ' + col.logicalType.name;
		def += col.notNull ? ' not null' : ' null';
		if (col.collation && col.collation !== 'BINARY') def += ` collate ${col.collation}`;
		if (col.defaultValue !== null && col.defaultValue !== undefined) {
			def += ` default ${expressionToString(col.defaultValue)}`;
		}
		colDefs.push(def);
	}

	const pkColNames: string[] = [];
	for (const pk of newPkDef) {
		const colName = tableSchema.columns[pk.index].name;
		let entry = quoteIdentifier(colName);
		if (pk.desc) entry += ' desc';
		pkColNames.push(entry);
	}

	let createDdl = `create table ${schemaPrefix}${quoteIdentifier(shadowName)} (${colDefs.join(', ')}`;
	createDdl += pkColNames.length > 0
		? `, primary key (${pkColNames.join(', ')}))`
		: `)`;

	if (tableSchema.vtabModuleName) {
		createDdl += ` using ${tableSchema.vtabModuleName}`;
		if (tableSchema.vtabArgs && Object.keys(tableSchema.vtabArgs).length > 0) {
			const args = Object.entries(tableSchema.vtabArgs)
				.map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
				.join(', ');
			createDdl += ` (${args})`;
		}
	}

	return createDdl;
}

/**
 * Generic rebuild via shadow table SQL for non-memory modules.
 */
async function rebuildViaShadowTable(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	survivingColumns: string[],
	newPkDef: PrimaryKeyColumnDefinition[],
): Promise<void> {
	const tableName = tableSchema.name;
	const schemaName = tableSchema.schemaName;
	const schemaPrefix = (schemaName && schemaName.toLowerCase() !== 'main')
		? `${quoteIdentifier(schemaName)}.`
		: '';
	const shadowName = `${tableName}__rekey_${Date.now()}`;

	const createDdl = buildShadowTableDdl(tableSchema, shadowName, survivingColumns, newPkDef);
	const projection = survivingColumns.map(c => quoteIdentifier(c)).join(', ');

	try {
		await rctx.db._execWithinTransaction(createDdl);
		await rctx.db._execWithinTransaction(
			`insert into ${schemaPrefix}${quoteIdentifier(shadowName)} (${projection}) select ${projection} from ${schemaPrefix}${quoteIdentifier(tableName)}`
		);
		await rctx.db._execWithinTransaction(
			`drop table ${schemaPrefix}${quoteIdentifier(tableName)}`
		);
		await rctx.db._execWithinTransaction(
			`alter table ${schemaPrefix}${quoteIdentifier(shadowName)} rename to ${quoteIdentifier(tableName)}`
		);
	} catch (e) {
		try {
			await rctx.db._execWithinTransaction(
				`drop table if exists ${schemaPrefix}${quoteIdentifier(shadowName)}`
			);
		} catch { /* ignore */ }
		throw e;
	}
}

/**
 * Propagates a table rename into every dependent schema object the catalog
 * knows about: CHECK expressions, FK references, and view bodies. Walks every
 * schema (not just the renamed table's home schema) so cross-schema FK
 * references are picked up. View `selectAst` is mutated in place because the
 * planner re-walks it on every reference.
 */
function propagateTableRename(
	rctx: RuntimeContext,
	renamedSchemaName: string,
	oldName: string,
	newName: string,
): void {
	const notifier = rctx.db.schemaManager.getChangeNotifier();
	for (const schema of rctx.db.schemaManager._getAllSchemas()) {
		propagateTableRenameInSchema(schema, renamedSchemaName, oldName, newName, notifier);
	}
}

function propagateTableRenameInSchema(
	schema: Schema,
	renamedSchemaName: string,
	oldName: string,
	newName: string,
	notifier: import('../../schema/change-events.js').SchemaChangeNotifier,
): void {
	const renamedSchemaLower = renamedSchemaName.toLowerCase();

	for (const table of Array.from(schema.getAllTables())) {
		// Skip the just-renamed table when iterating the home schema; the FK
		// `referencedTable` field on its own FKs (if any self-reference) is
		// still pointing at the old name and needs rewriting too.
		const updated = rewriteTableForTableRename(table, renamedSchemaLower, oldName, newName);
		if (updated !== table) {
			schema.addTable(updated);
			notifier.notifyChange({
				type: 'table_modified',
				schemaName: schema.name,
				objectName: updated.name,
				oldObject: table,
				newObject: updated,
			});
		}
	}

	if (schema.name.toLowerCase() === renamedSchemaLower) {
		for (const view of Array.from(schema.getAllViews())) {
			const changed = renameTableInAst(view.selectAst, oldName, newName, renamedSchemaName);
			if (changed) {
				const updatedView = { ...view, sql: selectToString(view.selectAst) };
				schema.addView(updatedView);
			}
		}
	}
}

function rewriteTableForTableRename(
	table: TableSchema,
	renamedSchemaLower: string,
	oldName: string,
	newName: string,
): TableSchema {
	const oldLower = oldName.toLowerCase();
	let changed = false;

	const newChecks = table.checkConstraints.map(cc => {
		const rewrote = renameTableInAst(cc.expr, oldName, newName, renamedSchemaLower);
		if (!rewrote) return cc;
		changed = true;
		return { ...cc };
	});

	const newFks = (table.foreignKeys ?? []).map(fk => {
		const fkSchemaLower = (fk.referencedSchema ?? table.schemaName).toLowerCase();
		if (fkSchemaLower !== renamedSchemaLower) return fk;
		if (fk.referencedTable.toLowerCase() !== oldLower) return fk;
		changed = true;
		return { ...fk, referencedTable: newName };
	});

	if (!changed) return table;

	return Object.freeze({
		...table,
		checkConstraints: Object.freeze(newChecks),
		foreignKeys: table.foreignKeys ? Object.freeze(newFks) : table.foreignKeys,
	});
}

function propagateColumnRename(
	rctx: RuntimeContext,
	renamedSchemaName: string,
	tableName: string,
	oldCol: string,
	newCol: string,
): void {
	const notifier = rctx.db.schemaManager.getChangeNotifier();
	for (const schema of rctx.db.schemaManager._getAllSchemas()) {
		propagateColumnRenameInSchema(schema, renamedSchemaName, tableName, oldCol, newCol, notifier);
	}
}

function propagateColumnRenameInSchema(
	schema: Schema,
	renamedSchemaName: string,
	tableName: string,
	oldCol: string,
	newCol: string,
	notifier: import('../../schema/change-events.js').SchemaChangeNotifier,
): void {
	const renamedSchemaLower = renamedSchemaName.toLowerCase();

	for (const table of Array.from(schema.getAllTables())) {
		const updated = rewriteTableForColumnRename(table, renamedSchemaLower, tableName, oldCol, newCol);
		if (updated !== table) {
			schema.addTable(updated);
			notifier.notifyChange({
				type: 'table_modified',
				schemaName: schema.name,
				objectName: updated.name,
				oldObject: table,
				newObject: updated,
			});
		}
	}

	if (schema.name.toLowerCase() === renamedSchemaLower) {
		for (const view of Array.from(schema.getAllViews())) {
			const changed = renameColumnInAst(view.selectAst, tableName, oldCol, newCol, renamedSchemaName);
			if (changed) {
				const updatedView = { ...view, sql: selectToString(view.selectAst) };
				schema.addView(updatedView);
			}
		}
	}
}

function rewriteTableForColumnRename(
	table: TableSchema,
	renamedSchemaLower: string,
	tableName: string,
	oldCol: string,
	newCol: string,
): TableSchema {
	const oldColLower = oldCol.toLowerCase();
	const tableLower = tableName.toLowerCase();
	let changed = false;

	const newChecks = table.checkConstraints.map(cc => {
		const rewrote = renameColumnInAst(cc.expr, tableName, oldCol, newCol, renamedSchemaLower);
		if (!rewrote) return cc;
		changed = true;
		return { ...cc };
	});

	const newFks = (table.foreignKeys ?? []).map(fk => {
		const fkSchemaLower = (fk.referencedSchema ?? table.schemaName).toLowerCase();
		if (fkSchemaLower !== renamedSchemaLower) return fk;
		if (fk.referencedTable.toLowerCase() !== tableLower) return fk;
		if (!fk.referencedColumnNames || fk.referencedColumnNames.length === 0) return fk;
		let touched = false;
		const newRefNames = fk.referencedColumnNames.map(n => {
			if (n.toLowerCase() === oldColLower) {
				touched = true;
				return newCol;
			}
			return n;
		});
		if (!touched) return fk;
		changed = true;
		return { ...fk, referencedColumnNames: Object.freeze(newRefNames) };
	});

	if (!changed) return table;

	return Object.freeze({
		...table,
		checkConstraints: Object.freeze(newChecks),
		foreignKeys: table.foreignKeys ? Object.freeze(newFks) : table.foreignKeys,
	});
}

/**
 * Build a minimal constraints array from an existing ColumnSchema
 * so that the ColumnDef AST accurately represents the column.
 */
function buildConstraintsFromColumn(col: import('../../schema/column.js').ColumnSchema): ColumnDef['constraints'] {
	const constraints: ColumnDef['constraints'] = [];
	if (col.notNull) {
		constraints.push({ type: 'notNull' });
	} else {
		constraints.push({ type: 'null' });
	}
	if (col.primaryKey) {
		constraints.push({ type: 'primaryKey', direction: col.pkDirection });
	}
	if (col.defaultValue) {
		constraints.push({ type: 'default', expr: col.defaultValue });
	}
	if (col.collation && col.collation !== 'BINARY') {
		constraints.push({ type: 'collate', collation: col.collation });
	}
	if (col.generated) {
		constraints.push({
			type: 'generated',
			generated: col.generatedExpr ? { expr: col.generatedExpr, stored: col.generatedStored ?? false } : undefined
		});
	}
	return constraints;
}
