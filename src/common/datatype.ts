import type { Expression } from "../parser/ast.js";
import type { DeepReadonly, SqlDataType } from "./types.js";

export type TypeClass = 'scalar' | 'relation' | 'list' | 'void';

export type BaseType = DeepReadonly<{
	typeClass: TypeClass;
}>

/**
 * Type information for scalar values.
 * This is used to determine the type of a scalar value, e.g., for a column reference or a literal.
 */
export type ScalarType = DeepReadonly<BaseType & {
	typeClass: 'scalar';
	/** The type affinity of the scalar value. */
	affinity: SqlDataType;
	/** The optional collation name of the scalar value. */
	collationName?: string;
	/** If nullable, null values are allowed and may be encountered in inference contexts too. */
	nullable: boolean;
	/** Indicates that it is inferred const, computed, or otherwise immutable.  Missing assumes false. */
	isReadOnly?: boolean;
	/** For literals or inferred constants, we can know the specific type */
	datatype?: SqlDataType;
	/** TODO: Based on integrity constraints, in some cases we can know of further restrictions on the set of values, which may enabled certain optimizations. */
	//constraints?: ReadonlyArray<ColumnConstraint>;
}>

export type ColumnDef = {
	name: string;
	type: ScalarType;
	/** The optional default value for the column. */
	default?: Expression;
	/** If true, the column is hidden and not visible to the user.  Absent = false. */
	hidden?: boolean;
	/** If true, the column is generated, not stored.  Absent = false. */
	generated?: boolean;
}

export type ColRef = {
	index: number;
	/** If true, the column is sorted in descending order.  Absent = false. */
	desc?: boolean;
}
/**
 * Type information for relations.
 * This is used to determine the type of a relation, e.g., for a table or a subquery.
 * Foreign keys and externally referencing constraints are not part of the relation type as they are essentially database level.
 */
export type RelationType = DeepReadonly<BaseType & {
	typeClass: 'relation';
	isReadOnly: boolean;
	columns: ColumnDef[];
	/** The unique keys of the relation (the primary key is arbitrarily the first one).
	 * Note that these may or may not be supported by indexes (normally they are), but by definition are unique.
	 * An empty key means the relation can have exactly 0 or 1 rows (TableDum and TableDee respectively).
	 */
	keys: ColRef[][];
	/** The row constraints of the relation - limited to the relation itself. */
	rowConstraints: { name?: string, expr: Expression }[];
}>

export type ListType = DeepReadonly<BaseType & {
	typeClass: 'list';
}>

export type VoidType = DeepReadonly<BaseType & {
	typeClass: 'void';
}>

export function isRelationType(type: BaseType): type is RelationType {
	return type.typeClass === 'relation';
}

export function isScalarType(type: BaseType): type is ScalarType {
	return type.typeClass === 'scalar';
}

export function isListType(type: BaseType): type is ListType {
	return type.typeClass === 'list';
}
