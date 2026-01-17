import type { EmissionContext } from '../emission-context.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import { createLogger } from '../../common/logger.js';
import { StatusCode, type Row, type SqlValue } from '../../common/types.js';
import { QuereusError } from '../../common/errors.js';
import { collectSchemaCatalog } from '../../schema/catalog.js';
import { computeSchemaDiff, generateMigrationDDL } from '../../schema/schema-differ.js';
import { computeShortSchemaHash } from '../../schema/schema-hasher.js';
import type * as AST from '../../parser/ast.js';
import type { PlanNode } from '../../planner/nodes/plan-node.js';

const log = createLogger('runtime:emit:declare');

export function emitDeclareSchema(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const declareStmt = (plan as unknown as { statementAst: AST.DeclareSchemaStmt }).statementAst;

	const run = (rctx: RuntimeContext): Row => {
		const schemaName = declareStmt.schemaName || 'main';
		log('DECLARE SCHEMA %s', schemaName);

		// Clear previous declaration and seed data for this schema
		rctx.db.declaredSchemaManager.clearSeedData(schemaName);

		// Store the declared schema
		rctx.db.declaredSchemaManager.setDeclaredSchema(schemaName, declareStmt);

		// Process seed data if present
		for (const item of declareStmt.items) {
			if (item.type === 'declaredSeed' && item.seedData) {
				const tableName = item.tableName;
				const rows = Array.from(item.seedData) as Array<SqlValue[]>;
				rctx.db.declaredSchemaManager.setSeedData(schemaName, tableName, rows);
				log('Stored seed data for %s.%s (%d rows)', schemaName, tableName, rows.length);
			}
		}

		// Return empty row to satisfy type system (void result)
		return [];
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `declare schema ${declareStmt.schemaName || 'main'}`
	};
}

export function emitDiffSchema(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const diffStmt = (plan as unknown as { statementAst: AST.DiffSchemaStmt }).statementAst;

	const run = async function* (rctx: RuntimeContext): AsyncIterable<Row> {
		const schemaName = diffStmt.schemaName || 'main';
		log('DIFF SCHEMA %s', schemaName);

		// Get declared schema
		const declaredSchema = rctx.db.declaredSchemaManager.getDeclaredSchema(schemaName);
		if (!declaredSchema) {
			throw new QuereusError(`No declared schema found for '${schemaName}'`, StatusCode.ERROR);
		}

		// Collect actual catalog
		const actualCatalog = collectSchemaCatalog(rctx.db, schemaName);

		// Compute diff
		const diff = computeSchemaDiff(declaredSchema, actualCatalog);

		// Generate migration DDL statements
		const migrationStatements = generateMigrationDDL(diff, schemaName);

		// Return each DDL statement as a row
		// This allows users to fetch the DDL and execute it themselves with custom logic
		for (const ddl of migrationStatements) {
			yield [ddl];
		}
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `diff schema ${diffStmt.schemaName || 'main'}`
	};
}

export function emitApplySchema(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const applyStmt = (plan as unknown as { statementAst: AST.ApplySchemaStmt }).statementAst;

	const run = async (rctx: RuntimeContext): Promise<Row> => {
		const schemaName = applyStmt.schemaName || 'main';
		log('APPLY SCHEMA %s', schemaName);

		// Get declared schema
		const declaredSchema = rctx.db.declaredSchemaManager.getDeclaredSchema(schemaName);
		if (!declaredSchema) {
			throw new QuereusError(`No declared schema found for '${schemaName}'`, StatusCode.ERROR);
		}

		// Ensure the target schema exists (create if it doesn't, except for main/temp)
		const lowerSchemaName = schemaName.toLowerCase();
		if (lowerSchemaName !== 'main' && lowerSchemaName !== 'temp') {
			if (!rctx.db.schemaManager.getSchema(schemaName)) {
				rctx.db.schemaManager.addSchema(schemaName);
				log('Created schema: %s', schemaName);
			}
		}

		// Collect actual catalog
		const actualCatalog = collectSchemaCatalog(rctx.db, schemaName);

		// Compute diff
		const diff = computeSchemaDiff(declaredSchema, actualCatalog);

		// Generate migration DDL
		const migrationStatements = generateMigrationDDL(diff, schemaName);

		// Execute each migration statement using _execWithinTransaction to avoid mutex deadlock
		// (we're already inside an exec() call that holds the mutex)
		for (const ddl of migrationStatements) {
			log('Executing migration DDL: %s', ddl);
			try {
				await rctx.db._execWithinTransaction(ddl);
			} catch (e) {
				log('Migration failed for DDL: %s', ddl);
				const errorMessage = e instanceof Error ? e.message : String(e);
				throw new QuereusError(
					`Failed to execute DDL: ${ddl}\nError: ${errorMessage}`,
					StatusCode.ERROR,
					e instanceof Error ? e : undefined
				);
			}
		}

		// Apply seed data if requested
		if (applyStmt.withSeed) {
			const allSeedData = rctx.db.declaredSchemaManager.getAllSeedData(schemaName);
			log('Seed data available for %d tables', allSeedData.size);
			for (const [tableName, rows] of allSeedData) {
				log('Applying seed data to %s.%s (%d rows)', schemaName, tableName, rows.length);

				// Qualify table name with schema if not main
				const qualifiedTableName = (schemaName && schemaName.toLowerCase() !== 'main')
					? `${schemaName}.${tableName}`
					: tableName;

				// Delete existing rows, then insert seed rows in one batch
				const deleteAndInsertSql = [
					`DELETE FROM ${qualifiedTableName}`,
					...rows.map(row => {
						const values = row.map(v =>
							v === null ? 'NULL' :
							typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` :
							typeof v === 'number' || typeof v === 'bigint' ? String(v) :
							'NULL'
						).join(', ');
						return `INSERT INTO ${qualifiedTableName} VALUES (${values})`;
					})
				].join('; ');

				log('Executing seed SQL (length=%d): %s', deleteAndInsertSql.length, deleteAndInsertSql);
				try {
					await rctx.db._execWithinTransaction(deleteAndInsertSql);
					log('Seed application succeeded for table %s', tableName);
				} catch (e) {
					log('Seed application failed for table %s: %O', tableName, e);
					const errorMessage = e instanceof Error ? e.message : String(e);
					throw new QuereusError(
						`Failed to apply seed data for table ${tableName}. SQL: ${deleteAndInsertSql}\nError: ${errorMessage}`,
						StatusCode.ERROR,
						e instanceof Error ? e : undefined
					);
				}
			}
		}

		// Return empty row to satisfy type system (void result)
		return [];
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `apply schema ${applyStmt.schemaName || 'main'}${applyStmt.withSeed ? ' with seed' : ''}`
	};
}

export function emitExplainSchema(plan: PlanNode, _ctx: EmissionContext): Instruction {
	const explainStmt = (plan as unknown as { statementAst: AST.ExplainSchemaStmt }).statementAst;

	const run = async function* (rctx: RuntimeContext): AsyncIterable<Row> {
		const schemaName = explainStmt.schemaName || 'main';
		log('EXPLAIN SCHEMA %s', schemaName);

		// Get declared schema
		const declaredSchema = rctx.db.declaredSchemaManager.getDeclaredSchema(schemaName);
		if (!declaredSchema) {
			throw new QuereusError(`No declared schema found for '${schemaName}'`, StatusCode.ERROR);
		}

		// Compute hash
		const hash = computeShortSchemaHash(declaredSchema);

		// Return hash with version if specified
		const result = explainStmt.version
			? `version:${explainStmt.version},hash:${hash}`
			: `hash:${hash}`;

		yield [result];
	};

	return {
		params: [],
		run: run as InstructionRun,
		note: `explain schema ${explainStmt.schemaName || 'main'}`
	};
}


