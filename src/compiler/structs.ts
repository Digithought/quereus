import type * as AST from '../parser/ast';
import type { TableSchema } from '../schema/table';
import type { IndexConstraint, IndexConstraintUsage } from '../vtab/indexInfo';
import type { ArgumentMap } from './handlers';

// Define interfaces directly in Compiler for simplicity if not widely shared

export interface ColumnResultInfo {
	targetReg: number;
	sourceCursor: number;
	sourceColumnIndex: number;
	expr?: AST.Expression;
}

export interface HavingContext {
	finalColumnMap: ReadonlyArray<ColumnResultInfo>;
}

export interface CteInfo {
	node: AST.CommonTableExpr;
	strategy: 'inline' | 'materialized';
	subroutineStartAddr?: number;
	materializedCursor?: number;
	cursorIdx?: number;
	schema?: TableSchema;
	resultBaseReg?: number;
	numCols?: number;
}

export interface SubroutineInfo {
	startAddr: number;
	frameSize: number; // Number of locals needed
	numArgs: number; // Number of arguments expected
	argMap: ArgumentMap;
}

export interface CursorPlanningResult {
	idxNum: number;
	idxStr: string | null;
	nArgs: number;
	aConstraint: ReadonlyArray<IndexConstraint>;
	aConstraintUsage: IndexConstraintUsage[];
	constraints: ReadonlyArray<IndexConstraint>;
	constraintExpressions: Map<number, AST.Expression>;
	handledWhereNodes: Set<AST.Expression>;
	nOrderBy: number;
	aOrderBy: ReadonlyArray<{
		iColumn: number;
		desc: boolean;
	}>;
	colUsed: bigint;
	idxFlags: number;
	estimatedCost: number;
	estimatedRows: bigint;
	orderByConsumed: boolean;
}
