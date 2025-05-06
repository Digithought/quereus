import type * as AST from '../parser/ast';
import type { TableSchema } from '../schema/table';
import type { IndexConstraint, IndexConstraintUsage } from '../vtab/indexInfo';
import type { ArgumentMap } from './handlers';
import type { SubqueryCorrelationResult } from './correlation.js';

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

export type CteStrategy = 'materialized' | 'view';

export interface CteInfo {
	node: AST.CommonTableExpr;
	strategy: CteStrategy;
	subroutineStartAddr?: number;
	materializedCursor?: number;
	cursorIdx?: number;
	schema?: TableSchema;
	resultBaseReg?: number;
	numCols?: number;
	isCompiled?: boolean;
}

export interface SubroutineInfo {
	startAddr: number;
	frameSize?: number;
	numArgs?: number;
	argMap?: ArgumentMap;
	correlation?: SubqueryCorrelationResult;
	regSubqueryHasNullOutput?: number;
}

export interface CursorPlanningResult {
	idxNum: number;
	idxStr: string | null;
	nArgs: number;
	usage: IndexConstraintUsage[];
	constraints: ReadonlyArray<IndexConstraint>;
	constraintExpressions: ReadonlyMap<number, AST.Expression>;
	handledWhereNodes: ReadonlySet<AST.Expression>;
	nOrderBy: number;
	aOrderBy: ReadonlyArray<{
		iColumn: number;
		desc: boolean;
	}>;
	colUsed: bigint;
	idxFlags: number;
	cost: number;
	rows: bigint;
	orderByConsumed: boolean;
}
