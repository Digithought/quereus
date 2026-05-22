/**
 * AST-level round-trip property test.
 *
 * `parse(stringify(ast)) ≡ ast` is asserted structurally for generated AST
 * instances (not SQL strings). Driving from ASTs is deliberate — driving
 * from SQL strings would couple the test to whatever shapes the parser
 * happens to surface today, and miss exactly the kind of field the
 * stringifier silently drops (issues #21, #23).
 *
 * Arbitraries produce AST nodes typed against `parser/ast.ts` — when a
 * node type changes shape, the compile breaks. The comparator
 * (`emit-roundtrip-comparator.ts`) absorbs documented default-equivalences
 * so the property tests structural fidelity rather than identity.
 */

import { expect } from 'chai';
import * as fc from 'fast-check';
import { parse } from '../src/parser/index.js';
import { astToString } from '../src/emit/ast-stringify.js';
import { ConflictResolution } from '../src/common/constants.js';
import type * as AST from '../src/parser/ast.js';
import { assertAstEquivalent, astEquivalent } from './emit-roundtrip-comparator.js';
import { safeJsonStringify } from '../src/util/serialization.js';
import type { RowOp } from '../src/common/types.js';

// ------------------------------------------------------------------------
// Leaf arbitraries
// ------------------------------------------------------------------------

/** Unquoted-safe identifier the parser will accept without a contextual-keyword fight. */
const identArb: fc.Arbitrary<string> = fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/)
	// Avoid keyword clashes by sampling letter-prefixed names. The lexer keyword
	// table is large; we keep the alphabet small and rely on a denylist for the
	// common landmines.
	.filter(s => !RESERVED_AS_IDENT.has(s));

const RESERVED_AS_IDENT = new Set<string>([
	'select', 'from', 'where', 'and', 'or', 'not', 'null', 'true', 'false',
	'table', 'index', 'view', 'create', 'drop', 'alter', 'rename', 'column',
	'add', 'set', 'primary', 'key', 'unique', 'check', 'default', 'collate',
	'references', 'foreign', 'cascade', 'restrict', 'on', 'delete', 'update',
	'insert', 'into', 'values', 'using', 'with', 'as', 'asc', 'desc',
	'between', 'in', 'exists', 'case', 'when', 'then', 'else', 'end',
	'group', 'by', 'having', 'order', 'limit', 'offset', 'distinct', 'all',
	'inner', 'left', 'right', 'full', 'outer', 'cross', 'join', 'union',
	'intersect', 'except', 'diff', 'cast', 'is', 'like', 'glob', 'match',
	'regexp', 'begin', 'commit', 'rollback', 'savepoint', 'release',
	'pragma', 'analyze', 'temp', 'temporary', 'if', 'integer', 'real', 'text',
	'blob', 'numeric', 'declare', 'schema', 'version', 'apply', 'explain',
	'seed', 'assertion', 'constraint', 'generated', 'always', 'stored', 'virtual',
	'context', 'tags', 'nulls', 'first', 'last', 'rows', 'range', 'over',
	'partition', 'preceding', 'following', 'unbounded', 'current', 'row',
	'returning', 'option', 'maxrecursion', 'lateral', 'recursive', 'no', 'action',
	'conflict', 'abort', 'fail', 'ignore', 'replace', 'rollback', 'deferrable',
	'initially', 'deferred', 'immediate',
	// builtin function names that the stringifier lowercases; safer to avoid as identifiers.
	'count', 'sum', 'avg', 'min', 'max', 'length', 'substr', 'abs',
]);

/** Distinct identifier pairs. Helps avoid name collisions in multi-column shapes. */
function uniqueIdents(n: number): fc.Arbitrary<string[]> {
	return fc.uniqueArray(identArb, { minLength: n, maxLength: n });
}

/** Conflict resolution other than ABORT (the default, dropped by the stringifier). */
const conflictResArb: fc.Arbitrary<ConflictResolution | undefined> = fc.oneof(
	fc.constant(undefined),
	fc.constantFrom(
		ConflictResolution.ROLLBACK,
		ConflictResolution.FAIL,
		ConflictResolution.IGNORE,
		ConflictResolution.REPLACE,
	),
);

const rowOpArb: fc.Arbitrary<RowOp> = fc.constantFrom('insert', 'update', 'delete');
const rowOpSubsetArb: fc.Arbitrary<RowOp[]> = fc.uniqueArray(rowOpArb, { minLength: 0, maxLength: 3 });

const fkActionArb: fc.Arbitrary<AST.ForeignKeyAction> = fc.constantFrom('setNull', 'setDefault', 'cascade', 'restrict');

// ------------------------------------------------------------------------
// Expression arbitraries (kept small — DDL is the focus; expression
// coverage is provided transitively via CHECK/DEFAULT/CTE bodies)
// ------------------------------------------------------------------------

/** Literal: integer (small range so toString round-trips cleanly). */
const intLiteralArb: fc.Arbitrary<AST.LiteralExpr> = fc.integer({ min: 0, max: 1_000_000 })
	.map(value => ({ type: 'literal' as const, value }));

/** Literal: negative integer (parsed as unary minus wrapping a positive literal,
 *  so we don't model it directly as a `LiteralExpr`). */

/** Literal: string. */
const strLiteralArb: fc.Arbitrary<AST.LiteralExpr> = fc.stringMatching(/^[a-zA-Z0-9 _.,!?-]{0,20}$/)
	.map(value => ({ type: 'literal' as const, value }));

/** Literal: null. */
const nullLiteralArb: fc.Arbitrary<AST.LiteralExpr> = fc.constant({
	type: 'literal' as const,
	value: null,
});

const literalArb: fc.Arbitrary<AST.LiteralExpr> = fc.oneof(intLiteralArb, strLiteralArb, nullLiteralArb);

/** Column reference (just a bare name, no table qualifier — keeps comparator simple). */
const columnRefArb: fc.Arbitrary<AST.ColumnExpr> = identArb.map(name => ({
	type: 'column' as const,
	name,
}));

/** Simple expression: literal or column reference. */
const simpleExprArb: fc.Arbitrary<AST.Expression> = fc.oneof(literalArb, columnRefArb);

/**
 * Comparison binary expression — `col > 0` etc. Restricted to one shape so
 * we don't have to model operator precedence in the arbitrary.
 */
const checkExprArb: fc.Arbitrary<AST.BinaryExpr> = fc.tuple(
	columnRefArb,
	fc.constantFrom('>', '<', '>=', '<=', '=', '!='),
	intLiteralArb,
).map(([left, operator, right]): AST.BinaryExpr => ({
	type: 'binary',
	operator,
	left,
	right,
}));

// ------------------------------------------------------------------------
// Column constraints
// ------------------------------------------------------------------------

const columnConstraintArb: fc.Arbitrary<AST.ColumnConstraint> = fc.oneof(
	// PRIMARY KEY [ASC|DESC] [ON CONFLICT ...]
	fc.record({
		direction: fc.oneof<('asc' | 'desc' | undefined)[]>(fc.constant(undefined), fc.constant('asc'), fc.constant('desc')),
		onConflict: conflictResArb,
	}).map(({ direction, onConflict }): AST.ColumnConstraint => {
		const c: AST.ColumnConstraint = { type: 'primaryKey' };
		if (direction !== undefined) c.direction = direction;
		if (onConflict !== undefined) c.onConflict = onConflict;
		return c;
	}),
	// NOT NULL [ON CONFLICT ...]
	conflictResArb.map((onConflict): AST.ColumnConstraint => {
		const c: AST.ColumnConstraint = { type: 'notNull' };
		if (onConflict !== undefined) c.onConflict = onConflict;
		return c;
	}),
	// UNIQUE [ON CONFLICT ...]
	conflictResArb.map((onConflict): AST.ColumnConstraint => {
		const c: AST.ColumnConstraint = { type: 'unique' };
		if (onConflict !== undefined) c.onConflict = onConflict;
		return c;
	}),
	// CHECK [ON ops] (<expr>) [ON CONFLICT ...]
	fc.record({
		expr: checkExprArb,
		operations: rowOpSubsetArb,
		onConflict: conflictResArb,
	}).map(({ expr, operations, onConflict }): AST.ColumnConstraint => {
		const c: AST.ColumnConstraint = { type: 'check', expr };
		// Only set operations if non-empty (matches the parser's "absent vs explicit" representation:
		// when ON is missing the parser leaves the field undefined; when ON is present it always
		// produces a non-empty list).
		if (operations.length > 0) c.operations = operations;
		if (onConflict !== undefined) c.onConflict = onConflict;
		return c;
	}),
	// DEFAULT <expr>
	literalArb.map((expr): AST.ColumnConstraint => ({ type: 'default', expr })),
	// COLLATE <name>
	fc.constantFrom('binary', 'nocase', 'rtrim').map((collation): AST.ColumnConstraint => ({
		type: 'collate',
		collation,
	})),
	// REFERENCES tbl [(col)] [ON DELETE ...] [ON UPDATE ...]
	fc.record({
		fkTable: identArb,
		fkColumn: fc.option(identArb, { nil: undefined }),
		onDelete: fc.option(fkActionArb, { nil: undefined }),
		onUpdate: fc.option(fkActionArb, { nil: undefined }),
	}).map(({ fkTable, fkColumn, onDelete, onUpdate }): AST.ColumnConstraint => {
		const fk: AST.ForeignKeyClause = { table: fkTable };
		if (fkColumn) fk.columns = [fkColumn];
		if (onDelete) fk.onDelete = onDelete;
		if (onUpdate) fk.onUpdate = onUpdate;
		return { type: 'foreignKey', foreignKey: fk };
	}),
	// GENERATED ALWAYS AS (<expr>) [STORED|VIRTUAL]
	fc.record({
		expr: simpleExprArb,
		stored: fc.boolean(),
	}).map(({ expr, stored }): AST.ColumnConstraint => ({
		type: 'generated',
		generated: { expr, stored },
	})),
);

// ------------------------------------------------------------------------
// Column definitions
// ------------------------------------------------------------------------

const dataTypeArb: fc.Arbitrary<string | undefined> = fc.oneof(
	fc.constant(undefined),
	fc.constantFrom('integer', 'text', 'real', 'blob', 'numeric'),
);

/**
 * A column definition for CREATE TABLE.
 *
 * To stay inside the parser's accepted subset, generated columns are
 * forbidden from co-existing with DEFAULT (the parser tolerates either
 * but they collide semantically in some engines), and PK/NotNull/Unique
 * are emitted at most once each. We don't aim for *every* legal SQL
 * column — just every (constraint, attribute) crossing that exercises
 * `columnConstraintsToString`.
 */
function makeColumnDefArb(name: string): fc.Arbitrary<AST.ColumnDef> {
	return fc.record({
		dataType: dataTypeArb,
		// Restrict to one constraint per column to keep the arbitrary in a region
		// the parser accepts uniformly. Cross-product of multiple constraints in
		// one column would require modelling exclusion rules (e.g. PRIMARY KEY +
		// NOT NULL is fine but PRIMARY KEY + GENERATED is not).
		constraint: fc.option(columnConstraintArb, { nil: undefined }),
	}).map(({ dataType, constraint }): AST.ColumnDef => ({
		name,
		dataType,
		constraints: constraint ? [constraint] : [],
	}));
}

// ------------------------------------------------------------------------
// Table constraints
// ------------------------------------------------------------------------

function makeTableConstraintArb(columnNames: string[]): fc.Arbitrary<AST.TableConstraint> {
	const colName = fc.constantFrom(...columnNames);
	const multiCol = (max: number) => fc.uniqueArray(colName, { minLength: 1, maxLength: Math.min(max, columnNames.length) });

	return fc.oneof(
		// PRIMARY KEY (col [ASC|DESC], ...) [ON CONFLICT ...]
		fc.record({
			cols: multiCol(3),
			directions: fc.array(fc.oneof<('asc' | 'desc' | undefined)[]>(fc.constant(undefined), fc.constant('asc'), fc.constant('desc')), { minLength: 0, maxLength: 3 }),
			onConflict: conflictResArb,
		}).map(({ cols, directions, onConflict }): AST.TableConstraint => {
			const c: AST.TableConstraint = {
				type: 'primaryKey',
				columns: cols.map((name, i) => {
					const e: { name: string; direction?: 'asc' | 'desc' } = { name };
					const d = directions[i];
					if (d !== undefined) e.direction = d;
					return e;
				}),
			};
			if (onConflict !== undefined) c.onConflict = onConflict;
			return c;
		}),
		// UNIQUE (col, ...) [ON CONFLICT ...]
		fc.record({
			cols: multiCol(3),
			onConflict: conflictResArb,
		}).map(({ cols, onConflict }): AST.TableConstraint => {
			const c: AST.TableConstraint = {
				type: 'unique',
				columns: cols.map(name => ({ name })),
			};
			if (onConflict !== undefined) c.onConflict = onConflict;
			return c;
		}),
		// CHECK [ON ops] (<expr>) [ON CONFLICT ...]
		fc.record({
			expr: checkExprArb,
			operations: rowOpSubsetArb,
			onConflict: conflictResArb,
		}).map(({ expr, operations, onConflict }): AST.TableConstraint => {
			const c: AST.TableConstraint = { type: 'check', expr };
			if (operations.length > 0) c.operations = operations;
			if (onConflict !== undefined) c.onConflict = onConflict;
			return c;
		}),
		// FOREIGN KEY (cols) REFERENCES tbl [(cols)] [ON DELETE ...] [ON UPDATE ...]
		fc.record({
			localCols: multiCol(2),
			fkTable: identArb,
			fkColumn: fc.option(identArb, { nil: undefined }),
			onDelete: fc.option(fkActionArb, { nil: undefined }),
			onUpdate: fc.option(fkActionArb, { nil: undefined }),
		}).map(({ localCols, fkTable, fkColumn, onDelete, onUpdate }): AST.TableConstraint => {
			const fk: AST.ForeignKeyClause = { table: fkTable };
			if (fkColumn) fk.columns = [fkColumn];
			if (onDelete) fk.onDelete = onDelete;
			if (onUpdate) fk.onUpdate = onUpdate;
			return {
				type: 'foreignKey',
				columns: localCols.map(name => ({ name })),
				foreignKey: fk,
			};
		}),
	);
}

// ------------------------------------------------------------------------
// CREATE TABLE
// ------------------------------------------------------------------------

const createTableArb: fc.Arbitrary<AST.CreateTableStmt> = fc.tuple(
	identArb,                                  // table name
	uniqueIdents(3),                            // column names (3 fixed so table constraints have something to reference)
	fc.boolean(),                               // ifNotExists
	fc.boolean(),                               // isTemporary
).chain(([tableName, colNames, ifNotExists, isTemporary]) => {
	const columnDefs = colNames.map(name => makeColumnDefArb(name));
	return fc.tuple(
		...columnDefs,
		fc.array(makeTableConstraintArb(colNames), { minLength: 0, maxLength: 2 }),
	).map(([c0, c1, c2, constraints]): AST.CreateTableStmt => ({
		type: 'createTable',
		table: { type: 'identifier', name: tableName },
		ifNotExists,
		isTemporary,
		columns: [c0, c1, c2],
		constraints,
	}));
});

// ------------------------------------------------------------------------
// CREATE VIEW (minimal)
// ------------------------------------------------------------------------

const simpleSelectArb: fc.Arbitrary<AST.SelectStmt> = fc.tuple(identArb, identArb).map(([col, table]): AST.SelectStmt => ({
	type: 'select',
	columns: [{ type: 'column', expr: { type: 'column', name: col } }],
	from: [{ type: 'table', table: { type: 'identifier', name: table } }],
}));

const createViewArb: fc.Arbitrary<AST.CreateViewStmt> = fc.tuple(
	identArb,
	fc.boolean(),
	fc.option(uniqueIdents(1), { nil: undefined }),
	simpleSelectArb,
	fc.boolean(),
).map(([name, ifNotExists, columns, select, isTemporary]): AST.CreateViewStmt => ({
	type: 'createView',
	view: { type: 'identifier', name },
	ifNotExists,
	isTemporary,
	columns,
	select,
}));

// ------------------------------------------------------------------------
// CREATE INDEX
// ------------------------------------------------------------------------

const indexedColumnArb: fc.Arbitrary<AST.IndexedColumn> = fc.record({
	name: identArb,
	direction: fc.oneof<('asc' | 'desc' | undefined)[]>(fc.constant(undefined), fc.constant('asc'), fc.constant('desc')),
}).map(({ name, direction }) => {
	const c: AST.IndexedColumn = { name };
	if (direction !== undefined) c.direction = direction;
	return c;
});

const createIndexArb: fc.Arbitrary<AST.CreateIndexStmt> = fc.record({
	idxName: identArb,
	tblName: identArb,
	ifNotExists: fc.boolean(),
	isUnique: fc.boolean(),
	columns: fc.array(indexedColumnArb, { minLength: 1, maxLength: 3 }),
	wherePred: fc.option(checkExprArb, { nil: undefined }),
}).map(({ idxName, tblName, ifNotExists, isUnique, columns, wherePred }): AST.CreateIndexStmt => ({
	type: 'createIndex',
	index: { type: 'identifier', name: idxName },
	table: { type: 'identifier', name: tblName },
	ifNotExists,
	isUnique,
	columns,
	where: wherePred,
}));

// ------------------------------------------------------------------------
// CREATE ASSERTION
// ------------------------------------------------------------------------

const createAssertionArb: fc.Arbitrary<AST.CreateAssertionStmt> = fc.record({
	name: identArb,
	check: checkExprArb,
}).map(({ name, check }): AST.CreateAssertionStmt => ({
	type: 'createAssertion',
	name,
	check,
}));

// ------------------------------------------------------------------------
// ALTER TABLE actions
// ------------------------------------------------------------------------

const alterTableArb: fc.Arbitrary<AST.AlterTableStmt> = fc.tuple(
	identArb, // table name
	fc.oneof<AST.AlterTableAction[]>(
		// RENAME TO
		identArb.map(newName => ({ type: 'renameTable', newName })),
		// RENAME COLUMN
		fc.tuple(identArb, identArb).map(([oldName, newName]) => ({
			type: 'renameColumn',
			oldName,
			newName,
		})),
		// ADD COLUMN
		identArb.chain(name => makeColumnDefArb(name)).map(column => ({
			type: 'addColumn',
			column,
		})),
		// DROP COLUMN
		identArb.map(name => ({ type: 'dropColumn', name })),
		// ADD CONSTRAINT — generate a NAMED constraint so the parser's `ADD CONSTRAINT`
		// path is exercised (the unnamed table-constraint path requires the constraint
		// keyword to be present anyway, so we always set a name).
		fc.tuple(identArb, uniqueIdents(2)).chain(([cName, colNames]) =>
			makeTableConstraintArb(colNames).map(c => ({
				type: 'addConstraint' as const,
				constraint: { ...c, name: cName } as AST.TableConstraint,
			})),
		),
		// ALTER PRIMARY KEY (cols)
		uniqueIdents(2).chain(cols => fc.array(fc.oneof<('asc' | 'desc' | undefined)[]>(
			fc.constant(undefined),
			fc.constant('asc'),
			fc.constant('desc'),
		), { minLength: 2, maxLength: 2 }).map(directions => ({
			type: 'alterPrimaryKey' as const,
			columns: cols.map((name, i) => {
				const e: { name: string; direction?: 'asc' | 'desc' } = { name };
				if (directions[i] !== undefined) e.direction = directions[i];
				return e;
			}),
		}))),
		// ALTER COLUMN ... SET NOT NULL / DROP NOT NULL
		fc.tuple(identArb, fc.boolean()).map(([columnName, setNotNull]) => ({
			type: 'alterColumn' as const,
			columnName,
			setNotNull,
		})),
		// ALTER COLUMN ... SET DATA TYPE <type>
		fc.tuple(identArb, fc.constantFrom('integer', 'text', 'real', 'blob', 'numeric')).map(([columnName, setDataType]) => ({
			type: 'alterColumn' as const,
			columnName,
			setDataType,
		})),
		// ALTER COLUMN ... SET DEFAULT <expr>
		fc.tuple(identArb, literalArb).map(([columnName, expr]) => ({
			type: 'alterColumn' as const,
			columnName,
			setDefault: expr,
		})),
		// ALTER COLUMN ... DROP DEFAULT
		identArb.map(columnName => ({
			type: 'alterColumn' as const,
			columnName,
			setDefault: null,
		})),
	),
).map(([tableName, action]): AST.AlterTableStmt => ({
	type: 'alterTable',
	table: { type: 'identifier', name: tableName },
	action,
}));

// ------------------------------------------------------------------------
// DROP
// ------------------------------------------------------------------------

const dropArb: fc.Arbitrary<AST.DropStmt> = fc.record({
	objectType: fc.constantFrom<('table' | 'view' | 'index' | 'assertion')[]>(
		'table', 'view', 'index', 'assertion',
	),
	ifExists: fc.boolean(),
	name: identArb,
}).map(({ objectType, ifExists, name }): AST.DropStmt => ({
	type: 'drop',
	objectType,
	name: { type: 'identifier', name },
	ifExists,
}));

// ------------------------------------------------------------------------
// Transactional + PRAGMA + ANALYZE
// ------------------------------------------------------------------------

const transactionStmtArb: fc.Arbitrary<AST.Statement> = fc.oneof(
	fc.constant<AST.BeginStmt>({ type: 'begin' }),
	fc.constant<AST.CommitStmt>({ type: 'commit' }),
	fc.option(identArb, { nil: undefined }).map((savepoint): AST.RollbackStmt => ({
		type: 'rollback',
		savepoint,
	})),
	identArb.map((name): AST.SavepointStmt => ({ type: 'savepoint', name })),
	identArb.map((savepoint): AST.ReleaseStmt => ({ type: 'release', savepoint })),
);

const pragmaArb: fc.Arbitrary<AST.PragmaStmt> = fc.tuple(identArb, fc.option(intLiteralArb, { nil: undefined }))
	.map(([name, value]): AST.PragmaStmt => {
		const p: AST.PragmaStmt = { type: 'pragma', name };
		if (value) p.value = value;
		return p;
	});

// Note: schema-name-only is not representable in the parser surface
// (`analyze foo` always parses as tableName, not schemaName) and the
// stringifier's `if (stmt.schemaName) return ...` branch produces SQL
// the parser can't undo. Treated as a known gap — see the review handoff.
const analyzeArb: fc.Arbitrary<AST.AnalyzeStmt> = fc.oneof(
	fc.constant<AST.AnalyzeStmt>({ type: 'analyze' }),
	identArb.map(tableName => ({ type: 'analyze' as const, tableName })),
	fc.tuple(identArb, identArb).map(([schemaName, tableName]) => ({
		type: 'analyze' as const,
		schemaName,
		tableName,
	})),
);

// ------------------------------------------------------------------------
// DML smoke (kept tiny — string round-trip already covers most surface)
// ------------------------------------------------------------------------

// Note: legacy `INSERT OR <res>` syntax sets `onConflict`, but the stringifier
// currently emits `on conflict <res>` (a trailing form the parser no longer
// accepts — UPSERT consumed that production). So `onConflict` cannot round-trip.
// Left out of the arbitrary; flagged as a finding in the review handoff.
const insertArb: fc.Arbitrary<AST.InsertStmt> = fc.tuple(
	identArb,
	uniqueIdents(2),
	fc.array(literalArb, { minLength: 2, maxLength: 2 }),
).map(([tbl, colNames, vals]): AST.InsertStmt => ({
	type: 'insert',
	table: { type: 'identifier', name: tbl },
	columns: colNames,
	values: [vals],
}));

const updateArb: fc.Arbitrary<AST.UpdateStmt> = fc.tuple(
	identArb,
	identArb,
	literalArb,
	fc.option(checkExprArb, { nil: undefined }),
).map(([tbl, col, val, wherePred]): AST.UpdateStmt => {
	const stmt: AST.UpdateStmt = {
		type: 'update',
		table: { type: 'identifier', name: tbl },
		assignments: [{ column: col, value: val }],
	};
	if (wherePred) stmt.where = wherePred;
	return stmt;
});

const deleteArb: fc.Arbitrary<AST.DeleteStmt> = fc.tuple(
	identArb,
	fc.option(checkExprArb, { nil: undefined }),
).map(([tbl, wherePred]): AST.DeleteStmt => {
	const stmt: AST.DeleteStmt = {
		type: 'delete',
		table: { type: 'identifier', name: tbl },
	};
	if (wherePred) stmt.where = wherePred;
	return stmt;
});

// ------------------------------------------------------------------------
// Round-trip driver
// ------------------------------------------------------------------------

/**
 * Stringify, re-parse, and compare. On parser/stringifier exceptions or
 * comparator failures, augment the error with the original AST + SQL so
 * fast-check's shrinker has enough context to minimize.
 */
function checkRoundTrip<T extends AST.AstNode>(ast: T): void {
	let sql: string;
	try {
		sql = astToString(ast);
	} catch (e) {
		throw new Error(`Stringify failed for ${safeJsonStringify(ast)}: ${e instanceof Error ? e.message : String(e)}`);
	}
	let reparsed: AST.AstNode;
	try {
		reparsed = parse(sql) as AST.AstNode;
	} catch (e) {
		throw new Error(`Re-parse failed for AST=${safeJsonStringify(ast)}\n  SQL: ${sql}\n  err: ${e instanceof Error ? e.message : String(e)}`);
	}
	try {
		assertAstEquivalent(ast, reparsed);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		throw new Error(`${msg}\n  original AST: ${safeJsonStringify(ast)}\n  SQL:          ${sql}\n  reparsed AST: ${safeJsonStringify(reparsed)}`);
	}
}

// ------------------------------------------------------------------------
// Comparator self-tests — verify it catches drops and tolerates noise
// ------------------------------------------------------------------------

describe('AST round-trip comparator: self-tests', () => {
	it('ignores positional metadata', () => {
		const a: AST.LiteralExpr = { type: 'literal', value: 1 };
		const b: AST.LiteralExpr = {
			type: 'literal',
			value: 1,
			loc: { start: { line: 1, column: 0, offset: 0 }, end: { line: 1, column: 1, offset: 1 } },
		};
		assertAstEquivalent(a, b);
	});

	it('treats missing PK direction as equivalent to asc', () => {
		const a: AST.ColumnConstraint = { type: 'primaryKey' };
		const b: AST.ColumnConstraint = { type: 'primaryKey', direction: 'asc' };
		assertAstEquivalent(a, b);
	});

	it('flags a dropped CHECK operations list', () => {
		const a: AST.ColumnConstraint = {
			type: 'check',
			expr: { type: 'literal', value: 1 },
			operations: ['delete'],
		};
		const b: AST.ColumnConstraint = {
			type: 'check',
			expr: { type: 'literal', value: 1 },
		};
		expect(() => assertAstEquivalent(a, b)).to.throw(/operations/);
	});

	it('flags a wrong literal storage class (int vs string)', () => {
		const a: AST.LiteralExpr = { type: 'literal', value: 1 };
		const b: AST.LiteralExpr = { type: 'literal', value: '1' };
		expect(() => assertAstEquivalent(a, b)).to.throw(/value/);
	});

	it('case-folds identifier names', () => {
		const a: AST.IdentifierExpr = { type: 'identifier', name: 'Users' };
		const b: AST.IdentifierExpr = { type: 'identifier', name: 'users' };
		assertAstEquivalent(a, b);
	});

	it('treats undefined onConflict as ABORT', () => {
		const a: AST.ColumnConstraint = { type: 'notNull' };
		const b: AST.ColumnConstraint = { type: 'notNull', onConflict: ConflictResolution.ABORT };
		assertAstEquivalent(a, b);
	});

	it('treats empty CHECK operations array as missing', () => {
		const a: AST.ColumnConstraint = {
			type: 'check',
			expr: { type: 'literal', value: 1 },
			operations: [],
		};
		const b: AST.ColumnConstraint = {
			type: 'check',
			expr: { type: 'literal', value: 1 },
		};
		assertAstEquivalent(a, b);
	});

	it('tags compared key-set + value, order-insensitive', () => {
		astEquivalent(
			{ tags: { a: 1, b: 'x' } },
			{ tags: { b: 'x', a: 1 } },
		);
	});
});

// ------------------------------------------------------------------------
// Property suites — one `it` per AST family so failures localize.
// ------------------------------------------------------------------------

describe('AST round-trip property: DDL', () => {
	it('CREATE TABLE round-trips structurally', () => {
		fc.assert(fc.property(createTableArb, checkRoundTrip), { numRuns: 200 });
	});

	it('CREATE VIEW round-trips structurally', () => {
		fc.assert(fc.property(createViewArb, checkRoundTrip), { numRuns: 100 });
	});

	it('CREATE INDEX round-trips structurally', () => {
		fc.assert(fc.property(createIndexArb, checkRoundTrip), { numRuns: 100 });
	});

	it('CREATE ASSERTION round-trips structurally', () => {
		fc.assert(fc.property(createAssertionArb, checkRoundTrip), { numRuns: 50 });
	});

	it('ALTER TABLE round-trips structurally', () => {
		fc.assert(fc.property(alterTableArb, checkRoundTrip), { numRuns: 200 });
	});

	it('DROP round-trips structurally', () => {
		fc.assert(fc.property(dropArb, checkRoundTrip), { numRuns: 50 });
	});
});

describe('AST round-trip property: transactional + misc', () => {
	it('transaction statements round-trip structurally', () => {
		fc.assert(fc.property(transactionStmtArb, checkRoundTrip), { numRuns: 50 });
	});

	it('PRAGMA round-trips structurally', () => {
		fc.assert(fc.property(pragmaArb, checkRoundTrip), { numRuns: 50 });
	});

	it('ANALYZE round-trips structurally', () => {
		fc.assert(fc.property(analyzeArb, checkRoundTrip), { numRuns: 50 });
	});
});

describe('AST round-trip property: DML smoke', () => {
	it('INSERT round-trips structurally', () => {
		fc.assert(fc.property(insertArb, checkRoundTrip), { numRuns: 50 });
	});

	it('UPDATE round-trips structurally', () => {
		fc.assert(fc.property(updateArb, checkRoundTrip), { numRuns: 50 });
	});

	it('DELETE round-trips structurally', () => {
		fc.assert(fc.property(deleteArb, checkRoundTrip), { numRuns: 50 });
	});
});
