import type { SqlValue } from '../common/types';
import type { IndexConstraintOp } from '../common/constants'; // Assuming this exists

export type SelectColumn = { type: 'all' } | { type: 'column', name: string };

export interface WhereClauseSimple {
    column: string;
    operator: IndexConstraintOp.EQ; // Initially just support EQ
    value: SqlValue | { type: 'parameter', key: number | string };
}

export interface SelectAst {
    type: 'SELECT';
    columns: SelectColumn[];
    fromTable: string;
    fromSchema: string | null; // null means search default path (main, temp)
    whereClause: WhereClauseSimple | null;
    // Add orderBy, groupBy, limit etc. later
}

// Add interfaces for other statement types (INSERT, UPDATE, DELETE, CREATE VIRTUAL TABLE) later
