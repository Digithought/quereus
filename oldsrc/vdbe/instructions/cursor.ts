import { QuereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Handler, VmCtx, Status, MemoryCell } from '../handler-types.js';
import type { VdbeInstruction } from '../instruction.js';
import { Opcode } from '../opcodes.js';
import type { TableSchema } from '../../schema/table.js';
import type { VirtualTable } from '../../vtab/table.js';
import type { BaseModuleConfig } from '../../vtab/module.js';
import { createLogger } from '../../common/logger.js';

const log = createLogger('vdbe:cursor');
const errorLog = log.extend('error');
const warnLog = log.extend('warn');

export function registerHandlers(handlers: Handler[]) {
	// --- Result Row ---
	handlers[Opcode.ResultRow] = (ctx, inst) => {
		const startOffset = inst.p1;
		const count = inst.p2;

		const startIdx = ctx.framePointer + startOffset;
		if (startIdx < 0 || startIdx + count > ctx.stackPointer) {
			throw new QuereusError(
				`ResultRow stack access out of bounds: FP=${ctx.framePointer} ` +
				`Offset=${startOffset} Count=${count} SP=${ctx.stackPointer}`,
				StatusCode.INTERNAL
			);
		}

		// Extract the MemoryCell objects for the current row using getStackValue
		const rowCells: MemoryCell[] = [];
		for (let i = 0; i < count; i++) {
			// Construct a MemoryCell object. Note: This assumes MemoryCell only needs 'value'.
			// If MemoryCell has other properties (like type flags) managed by VDBE,
			// we might need to expose the raw stack or a getMemoryCell function.
			rowCells.push({ value: ctx.getStack(startIdx + i) });
		}

		// Call the statement's method to store the current row data
		ctx.stmt.setCurrentRow(rowCells);

		// Set the yield flag, but don't return ROW directly
		ctx.hasYielded = true;
		return undefined; // Let VdbeRuntime return ROW based on hasYielded flag
	};

	// --- Cursor Management (Async) ---
	const openVtabCursor = async (ctx: VmCtx, inst: VdbeInstruction): Promise<Status> => {
		const cIdx = inst.p1;
		// Cast p4 to the expected P4Vtab type or similar structure
		const p4Info = inst.p4 as { type: 'vtab', tableSchema: TableSchema } | undefined;

		if (!p4Info || !p4Info.tableSchema) {
			throw new QuereusError("OpenRead/OpenWrite called without valid p4 table schema info", StatusCode.INTERNAL);
		}
		const tableSchema = p4Info.tableSchema; // Extract the actual schema

		if (!tableSchema.vtabModuleName) {
			// Keep the detailed error message using the extracted tableSchema
			throw new QuereusError(`Table schema for ${tableSchema.name} is missing vtabModuleName`, StatusCode.INTERNAL);
		}

		const moduleInfo = ctx.db._getVtabModule(tableSchema.vtabModuleName);
		if (!moduleInfo) {
			throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' not found`, StatusCode.ERROR);
		}
		const module = moduleInfo.module;
		if (typeof module.xConnect !== 'function') {
			throw new QuereusError(`Virtual table module '${tableSchema.vtabModuleName}' does not implement xConnect`, StatusCode.MISUSE);
		}

		let vtabInstance: VirtualTable;
		try {
			const options: BaseModuleConfig = {};
			vtabInstance = module.xConnect(
				ctx.db,
				moduleInfo.auxData,
				tableSchema.vtabModuleName,
				tableSchema.schemaName,
				tableSchema.name,
				options
			);
		} catch (e: any) {
			const message = e instanceof Error ? e.message : String(e);
			throw new QuereusError(`Module '${tableSchema.vtabModuleName}' xConnect failed for table '${tableSchema.name}': ${message}`, e instanceof QuereusError ? e.code : StatusCode.ERROR, e instanceof Error ? e : undefined);
		}

		if (typeof vtabInstance.xOpen !== 'function') {
			throw new QuereusError(`Virtual table instance for '${tableSchema.name}' does not implement xOpen`, StatusCode.MISUSE);
		}
		const cursorInstance = await vtabInstance.xOpen();

		const vdbeCursor = ctx.getCursor(cIdx);
		if (!vdbeCursor) {
			await cursorInstance?.close();
			await vtabInstance?.xDisconnect();
			throw new QuereusError(`VDBE cursor slot ${cIdx} not found during OpenRead/Write`, StatusCode.INTERNAL);
		}

		if (vdbeCursor.instance) await vdbeCursor.instance.close();
		if (vdbeCursor.vtab) await vdbeCursor.vtab.xDisconnect();

		vdbeCursor.instance = cursorInstance;
		vdbeCursor.vtab = vtabInstance;
		vdbeCursor.isEphemeral = false;
		vdbeCursor.sortedResults = null;

		return undefined;
	};

	handlers[Opcode.OpenRead] = openVtabCursor;
	handlers[Opcode.OpenWrite] = openVtabCursor;

	handlers[Opcode.Close] = async (ctx, inst) => {
		const cIdx = inst.p1;
		const vdbeCursor = ctx.getCursor(cIdx);

		if (vdbeCursor) {
			if (vdbeCursor.instance) {
				try {
					await vdbeCursor.instance.close();
				} catch (e) {
					errorLog(`Error closing VTab cursor instance (idx ${cIdx}): %O`, e);
				} finally {
					vdbeCursor.instance = null;
				}
			}

			if (vdbeCursor.vtab) {
				if (typeof vdbeCursor.vtab.xDisconnect === 'function') {
					try {
						await vdbeCursor.vtab.xDisconnect();
					} catch (e) {
						errorLog(`Error disconnecting VTab table instance (idx ${cIdx}, name: ${vdbeCursor.vtab.tableName}): %O`, e);
					}
				} else {
					warnLog(`VTab instance for cursor ${cIdx} (table: ${vdbeCursor.vtab.tableName}) does not implement xDisconnect.`);
				}
				vdbeCursor.vtab = null;
			}

			if (vdbeCursor.sortedResults) {
				vdbeCursor.sortedResults = null;
			}
			vdbeCursor.isEphemeral = false;
		}
		return undefined;
	};
}
