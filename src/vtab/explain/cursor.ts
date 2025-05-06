import { VirtualTable } from '../table.js';
import type { QueryPlanModule } from './module.js';
import type { Database, QueryPlanStep } from '../../core/database.js';
import type { TableSchema } from '../../schema/table.js';
import type { SqliteContext } from '../../func/context.js';
import { StatusCode } from '../../common/types.js';
import type { SqlValue } from '../../common/types.js';
import { VirtualTableCursor } from '../cursor.js';
import { SqliteError } from '../../common/errors.js';
import type { QueryPlanTable } from './table.js';

/**
 * Represents a cursor for iterating over query plan steps.
 */
export class QueryPlanCursor extends VirtualTableCursor<QueryPlanTable> {
    private readonly planSteps: ReadonlyArray<QueryPlanStep>;
    private currentIndex: number = -1;

    constructor(table: QueryPlanTable, planSteps: ReadonlyArray<QueryPlanStep>) {
        super(table);
        this.planSteps = planSteps;
        this._isEof = this.planSteps.length === 0;
        if (!this._isEof) {
            this.currentIndex = 0; // Position at first row if available
        }
    }

    async filter(/* Filter args are ignored */): Promise<void> {
        this.currentIndex = this.planSteps.length > 0 ? 0 : -1;
        this._isEof = this.planSteps.length === 0;
    }

    async next(): Promise<void> {
        if (this._isEof) return;

        this.currentIndex++;
        if (this.currentIndex >= this.planSteps.length) {
            this._isEof = true;
            this.currentIndex = this.planSteps.length; // Position past end
        }
    }

    column(context: SqliteContext, columnIndex: number): number {
        if (this._isEof || this.currentIndex < 0 || this.currentIndex >= this.planSteps.length) {
            // Undefined behavior per SQLite, return NULL
            context.resultNull();
            return StatusCode.OK;
        }

        const currentStep = this.planSteps[this.currentIndex];
        let value: SqlValue | undefined;

        switch (columnIndex) {
            case 0: // selectid
                value = currentStep.selectId;
                break;
            case 1: // order
                value = currentStep.order;
                break;
            case 2: // from
                value = currentStep.from;
                break;
            case 3: // detail
                value = currentStep.detail;
                break;
            default:
                context.resultError(`Invalid column index ${columnIndex} for query_plan`);
                return StatusCode.RANGE;
        }

        context.resultValue(value ?? null);
        return StatusCode.OK;
    }

    // rowid is not applicable for this virtual table
    async rowid(): Promise<bigint> {
        throw new SqliteError("query_plan table has no rowid", StatusCode.MISUSE);
    }

    async close(): Promise<void> {
        this.currentIndex = -1;
        this._isEof = true;
    }
}
