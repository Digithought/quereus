import type * as AST from '../parser/ast.js';
import type {
	TableSchema,
	RowConstraintSchema,
	UniqueConstraintSchema,
	ForeignKeyConstraintSchema,
	PrimaryKeyColumnDefinition,
} from './table.js';

/**
 * Lens layer — per-logical-table mapping slots.
 *
 * A logical schema (`Schema.kind === 'logical'`) declares tables as pure design
 * (columns + logical constraints, no module / index / storage). At
 * `apply schema X` the lens compiler ({@link ./lens-compiler.ts}) aligns each
 * logical table against a basis schema and produces an inlined effective view
 * body — the query processor then sees an ordinary view (registered via
 * `Schema.addView`), so reads ride the standard view-resolution path and writes
 * ride view-updateability with zero new runtime.
 *
 * The {@link LensSlot} is the home for the logical-table spec (columns / types /
 * constraints) that a `ViewSchema` cannot carry. The override / prover tickets
 * consume the slot; this ticket only populates and stores it.
 *
 * See `docs/lens.md` for the full design.
 */

/** A resolved reference to the basis schema a lens slot aligns against. */
export interface SchemaRef {
	/** Schema name of the basis schema (lowercased, as stored in the manager). */
	schemaName: string;
}

/**
 * A logical constraint carried verbatim from the logical declaration onto the
 * compiled view body. The prover ticket routes these to enforcement; this
 * ticket only stores them. Reuses the existing constraint-schema shapes rather
 * than re-modelling (see `docs/lens.md` § Constraint Attachment).
 */
export type LogicalConstraint =
	| { kind: 'primaryKey'; columns: ReadonlyArray<PrimaryKeyColumnDefinition> }
	| { kind: 'check'; constraint: RowConstraintSchema }
	| { kind: 'unique'; constraint: UniqueConstraintSchema }
	| { kind: 'foreignKey'; constraint: ForeignKeyConstraintSchema };

/**
 * The per-logical-table mapping slot. Populated at lens-compile time
 * (the `apply schema X` step for a logical schema).
 */
export interface LensSlot {
	/**
	 * The logical spec: columns + constraints, built from the declared
	 * `CreateTableStmt`. `vtabModule` is undefined and `isLogical` is true —
	 * a logical table is a design, not a module-backed relation.
	 */
	logicalTable: TableSchema;
	/** The basis schema this slot aligns against. */
	defaultBasis: SchemaRef;
	/**
	 * Explicit override body. Always undefined in this ticket — the
	 * `declare lens for X over Y` override surface lands in
	 * `lens-explicit-overrides-and-attribute-merge`.
	 */
	override?: AST.SelectStmt;
	/** The effective body — produced by the default mapper. */
	compiledBody: AST.SelectStmt;
	/**
	 * The logical spec's constraints, verbatim. Routed to enforcement by the
	 * prover ticket (`lens-prover-and-constraint-attachment`); stored as-is here.
	 */
	attachedConstraints: ReadonlyArray<LogicalConstraint>;
}

/**
 * Collects the logical spec's constraints into the verbatim
 * {@link LogicalConstraint} list stored on the lens slot. The primary key is
 * always included (even the empty / singleton key — see `docs/lens.md`
 * § The Default Mapper); the prover decides how to realize each.
 */
export function buildLogicalConstraints(logicalTable: TableSchema): LogicalConstraint[] {
	const result: LogicalConstraint[] = [];
	result.push({ kind: 'primaryKey', columns: logicalTable.primaryKeyDefinition });
	for (const c of logicalTable.checkConstraints) {
		result.push({ kind: 'check', constraint: c });
	}
	for (const c of logicalTable.uniqueConstraints ?? []) {
		result.push({ kind: 'unique', constraint: c });
	}
	for (const c of logicalTable.foreignKeys ?? []) {
		result.push({ kind: 'foreignKey', constraint: c });
	}
	return result;
}
