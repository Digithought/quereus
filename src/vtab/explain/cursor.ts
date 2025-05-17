import type { QueryPlanStep } from '../../core/explain.js';
import type { SqliterContext } from '../../func/context.js';
import { StatusCode } from '../../common/types.js';
import type { SqlValue } from '../../common/types.js';
import { VirtualTableCursor } from '../cursor.js';
import { SqliterError } from '../../common/errors.js';
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

    column(context: SqliterContext, columnIndex: number): number {
        if (this._isEof || this.currentIndex < 0 || this.currentIndex >= this.planSteps.length) {
            context.resultNull();
            return StatusCode.OK;
        }

        const currentStep = this.planSteps[this.currentIndex];
        let value: SqlValue | undefined | null;

        // Column order must match QUERY_PLAN_COLUMNS in module.ts
        switch (columnIndex) {
            case 0: value = currentStep.id; break;
            case 1: value = currentStep.parentId; break;
            case 2: value = currentStep.subqueryLevel; break;
            case 3: value = currentStep.op; break;
            case 4: value = currentStep.detail; break;
            case 5: value = currentStep.objectName; break;
            case 6: value = currentStep.alias; break;
            case 7: value = currentStep.estimatedCost; break;
            case 8: value = currentStep.estimatedRows; break; // Ensure BigInt is handled if SqlValue supports it or convert to number/string
            case 9: value = currentStep.idxNum; break;
            case 10: value = currentStep.idxStr; break;
            case 11: value = currentStep.orderByConsumed ? 1 : 0; break;
            case 12: value = currentStep.constraintsDesc; break;
            case 13: value = currentStep.orderByDesc; break;
            case 14: value = currentStep.joinType; break;
            case 15: value = currentStep.isCorrelated ? 1 : 0; break;
            default:
                context.resultError(`Invalid column index ${columnIndex} for query_plan`);
                return StatusCode.RANGE;
        }

        // Handle BigInt for estimatedRows if it can be very large - Down convert to number if in range
        if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
            context.resultValue(Number(value));
        } else {
            context.resultValue(value ?? null); // Ensure undefined becomes null
        }
        return StatusCode.OK;
    }

    // rowid is not applicable for this virtual table
    async rowid(): Promise<bigint> {
        throw new SqliterError("query_plan table has no rowid", StatusCode.MISUSE);
    }

    async close(): Promise<void> {
        this.currentIndex = -1;
        this._isEof = true;
    }

    async* rows(): AsyncIterable<import('../../common/types.js').Row> {
        if (!this.table.tableSchema) { // Access schema via table instance
            throw new SqliteError("QueryPlanCursor: Schema not found for rows() iteration.", StatusCode.INTERNAL);
        }

        while (!this.eof()) {
            if (this.currentIndex < 0 || this.currentIndex >= this.planSteps.length) {
                // Should not happen if eof() is false, but as a safeguard
                throw new SqliteError("QueryPlanCursor: Invalid current index while not EOF.", StatusCode.INTERNAL);
            }
            const currentStep = this.planSteps[this.currentIndex];
            const row: SqlValue[] = [
                currentStep.id, // Not nullable
                currentStep.parentId ?? null, // Coalesce undefined to null
                currentStep.subqueryLevel, // Not nullable
                currentStep.op, // Not nullable
                currentStep.detail ?? null, // Coalesce undefined to null
                currentStep.objectName ?? null, // Coalesce undefined to null
                currentStep.alias ?? null, // Coalesce undefined to null
                currentStep.estimatedCost ?? null, // Coalesce undefined to null
                (currentStep.estimatedRows === undefined || currentStep.estimatedRows === null) ? null : ((typeof currentStep.estimatedRows === 'bigint' && currentStep.estimatedRows <= BigInt(Number.MAX_SAFE_INTEGER) && currentStep.estimatedRows >= BigInt(Number.MIN_SAFE_INTEGER)) ? Number(currentStep.estimatedRows) : currentStep.estimatedRows),
                currentStep.idxNum ?? null, // Coalesce undefined to null
                currentStep.idxStr ?? null, // Already handles null, ensure undefined also becomes null
                currentStep.orderByConsumed ? 1 : 0, // Not nullable
                currentStep.constraintsDesc ?? null, // Coalesce undefined to null
                currentStep.orderByDesc ?? null, // Coalesce undefined to null
                currentStep.joinType ?? null, // Coalesce undefined to null
                currentStep.isCorrelated ? 1 : 0 // Not nullable
            ];
            yield row;
            await this.next();
        }
    }
}
