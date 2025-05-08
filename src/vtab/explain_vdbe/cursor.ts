import { VirtualTableCursor } from '../cursor.js';
import type { VdbeProgramTable } from './table.js';
import type { VdbeInstruction } from '../../vdbe/instruction.js';
import { Opcode } from '../../vdbe/opcodes.js';
import type { SqliteContext } from '../../func/context.js';
import { StatusCode } from '../../common/types.js';
import { SqliteError } from '../../common/errors.js';
import { safeJsonStringify } from '../../util/serialization.js';

/**
 * Represents a cursor for iterating over VDBE instructions.
 */
export class VdbeProgramCursor extends VirtualTableCursor<VdbeProgramTable> {
    private readonly instructions: ReadonlyArray<VdbeInstruction>;
    private readonly constants: ReadonlyArray<any>;
    private currentIndex: number = -1;

    constructor(table: VdbeProgramTable) {
        super(table);
        this.instructions = table.program.instructions;
        this.constants = table.program.constants;
        this._isEof = this.instructions.length === 0;
        if (!this._isEof) {
            this.currentIndex = 0; // Position at first instruction
        }
    }

    async filter(/* Filter args are ignored */): Promise<void> {
        this.currentIndex = this.instructions.length > 0 ? 0 : -1;
        this._isEof = this.instructions.length === 0;
    }

    async next(): Promise<void> {
        if (this._isEof) return;

        this.currentIndex++;
        if (this.currentIndex >= this.instructions.length) {
            this._isEof = true;
            this.currentIndex = this.instructions.length; // Position past end
        }
    }

    column(context: SqliteContext, columnIndex: number): number {
        if (this._isEof || this.currentIndex < 0 || this.currentIndex >= this.instructions.length) {
            context.resultNull();
            return StatusCode.OK;
        }

        const currentInstr = this.instructions[this.currentIndex];
        let value: any;

        switch (columnIndex) {
            case 0: // addr
                value = this.currentIndex;
                break;
            case 1: // opcode
                value = Opcode[currentInstr.opcode];
                break;
            case 2: // p1
                value = currentInstr.p1;
                break;
            case 3: // p2
                value = currentInstr.p2;
                break;
            case 4: // p3
                value = currentInstr.p3;
                break;
            case 5: // p4
                value = currentInstr.p4;
                break;
            case 6: // p5
                value = currentInstr.p5;
                break;
            case 7: // comment
                value = currentInstr.comment ?? null;
                break;
            default:
                context.resultError(`Invalid column index ${columnIndex} for vdbe_program`);
                return StatusCode.RANGE;
        }

        if (columnIndex === 5 && value !== null && typeof value === 'object') {
            try {
                value = safeJsonStringify(value);
            } catch {
                value = '[unstringifiable P4]';
            }
        }

        context.resultValue(value ?? null);
        return StatusCode.OK;
    }

    // rowid is not applicable
    async rowid(): Promise<bigint> {
        throw new SqliteError("vdbe_program table has no rowid", StatusCode.MISUSE);
    }

    async close(): Promise<void> {
        this.currentIndex = -1;
        this._isEof = true;
    }
}
