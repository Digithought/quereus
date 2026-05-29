import type * as AST from '../parser/ast.js';
import type { SqlValue } from '../common/types.js';

/**
 * Represents the schema definition of a database view.
 * Views are stored SELECT statements that act like virtual tables.
 */
export interface ViewSchema {
	/** The name of the view */
	name: string;
	/** The name of the schema this view belongs to (e.g., 'main') */
	schemaName: string;
	/** The original SQL text used to create the view */
	sql: string;
	/**
	 * The parsed body AST that defines the view's logic. Any relation-producing
	 * QueryExpr (SELECT / VALUES). DML bodies (INSERT/UPDATE/DELETE with
	 * RETURNING) are rejected at view-creation time because a view body
	 * re-evaluates on every reference — replaying a write per read is incoherent
	 * with view semantics.
	 */
	selectAst: AST.QueryExpr;
	/** Columns explicitly defined in CREATE VIEW (e.g., CREATE VIEW v(a,b) AS...) */
	columns?: ReadonlyArray<string>; // Optional list of explicitly named columns
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing) */
	tags?: Readonly<Record<string, SqlValue>>;
}

/**
 * Schema definition of a materialized view — a "keyed derived relation". The
 * query body is stored once into a backing virtual table (a normal
 * `TableSchema` in the `tables` map); references resolve to that backing table
 * rather than re-expanding the body. Phase 1 is manual full-refresh; the body
 * AST is retained so a later incremental / write-through pass can build on it.
 *
 * Dual-registration: the backing table lives in `Schema.tables`, this record
 * lives in `Schema.materializedViews`. Name-disjointness is enforced across
 * tables, views, and materialized views.
 */
export interface MaterializedViewSchema {
	/** The materialized view's name (the name users reference). */
	name: string;
	/** The schema this MV belongs to (e.g. 'main'). */
	schemaName: string;
	/** Original DDL text (round-trippable via ast-stringify). */
	sql: string;
	/** The parsed body AST — any relation-producing QueryExpr (SELECT / VALUES / compound). */
	selectAst: AST.QueryExpr;
	/** Columns explicitly defined in CREATE MATERIALIZED VIEW (e.g. `mv(a, b)`). */
	columns?: ReadonlyArray<string>;
	/** Arbitrary metadata tags (informational only, does not affect behavior or hashing). */
	tags?: Readonly<Record<string, SqlValue>>;

	/** Backing-table identity. Same schemaName; conventional derived name. */
	backingTableName: string;

	/** Inferred PK of the view output, derived from `keysOf` on the optimized body.
	 *  NOTE: `keysOf` returns column-index arrays WITHOUT direction; `desc` defaults
	 *  false. When `keysOf` yields no usable key, the all-columns key is used
	 *  (Quereus default). Such an MV is incremental-ineligible until Phase 2. */
	primaryKey: ReadonlyArray<{ index: number; desc: boolean }>;

	/** `fnv1aHash(toBase64Url(...))` of the optimized body's structural shape.
	 *  Consumed by the declarative-schema differ (sibling ticket) to detect
	 *  "body changed → rebuild". Populated here even though the differ wiring
	 *  lands next ticket. */
	bodyHash: string;

	/** Body ordering captured from the optimized body (for the materialized-index path).
	 *  v1 stores; the covering ticket consumes. */
	ordering?: ReadonlyArray<{ index: number; desc: boolean }>;

	/** Qualified (lowercased `schema.table`) names of the source tables the body
	 *  reads. Used by the schema-change subscription to mark the MV stale when a
	 *  source is modified or removed. */
	sourceTables: ReadonlyArray<string>;

	/** Staleness flag set by the schema-change subscription when a source table
	 *  is modified/removed in a way that may break the body. */
	stale?: boolean;
}

/** Conventional derived name for a materialized view's backing table. Reserved
 *  prefix; backing tables are hidden from user-facing catalog enumeration. */
export function backingTableNameFor(mvName: string): string {
	return `sqlite_mv_${mvName}`;
}
