import { SqliteError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';
import type { Handler, VmCtx, Status } from '../handler-types.js';
import type { VdbeInstruction } from '../instruction.js';
import { Opcode } from '../opcodes.js';
import type { TableSchema } from '../../schema/table.js';
import type { VirtualTable } from '../../vtab/table.js';
import type { BaseModuleConfig } from '../../vtab/module.js';

export function registerHandlers(handlers: Handler[]) {
	// --- Result Row ---
	handlers[Opcode.ResultRow] = (ctx, inst) => {
		const startOffset = inst.p1;
		const count = inst.p2;

		const startIdx = ctx.framePointer + startOffset;
		if (startIdx < 0 || startIdx + count > ctx.stackPointer) {
			throw new SqliteError(
				`ResultRow stack access out of bounds: FP=${ctx.framePointer} ` +
				`Offset=${startOffset} Count=${count} SP=${ctx.stackPointer}`,
				StatusCode.INTERNAL
			);
		}

		// This requires access to the statement object through ctx
		// We'll rely on the executor to handle this in the run method
		ctx.hasYielded = true;
		return StatusCode.ROW;
	};

	// --- Cursor Management (Async) ---
	const openVtabCursor = async (ctx: VmCtx, inst: VdbeInstruction): Promise<Status> => {
		const cIdx = inst.p1;
		const tableSchema = inst.p4 as TableSchema | undefined;

		if (!tableSchema) {
			throw new SqliteError("OpenRead/OpenWrite called without table schema", StatusCode.INTERNAL);
		}

		if (!tableSchema.vtabModuleName) {
			throw new SqliteError(`Table schema for ${tableSchema.name} is missing vtabModuleName`, StatusCode.INTERNAL);
		}

		const moduleInfo = ctx.db._getVtabModule(tableSchema.vtabModuleName);
		if (!moduleInfo) {
			throw new SqliteError(`Virtual table module '${tableSchema.vtabModuleName}' not found`, StatusCode.ERROR);
		}
		const module = moduleInfo.module;
		if (typeof module.xConnect !== 'function') {
			throw new SqliteError(`Virtual table module '${tableSchema.vtabModuleName}' does not implement xConnect`, StatusCode.MISUSE);
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
			throw new SqliteError(`Module '${tableSchema.vtabModuleName}' xConnect failed for table '${tableSchema.name}': ${message}`, e instanceof SqliteError ? e.code : StatusCode.ERROR, e instanceof Error ? e : undefined);
		}

		if (typeof vtabInstance.xOpen !== 'function') {
			throw new SqliteError(`Virtual table instance for '${tableSchema.name}' does not implement xOpen`, StatusCode.MISUSE);
		}
		const cursorInstance = await vtabInstance.xOpen();

		const vdbeCursor = ctx.getCursor(cIdx);
		if (!vdbeCursor) {
			await cursorInstance?.close();
			await vtabInstance?.xDisconnect();
			throw new SqliteError(`VDBE cursor slot ${cIdx} not found during OpenRead/Write`, StatusCode.INTERNAL);
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
					console.error(`Error closing VTab cursor instance (idx ${cIdx}):`, e);
				} finally {
					vdbeCursor.instance = null;
				}
			}

			if (vdbeCursor.vtab) {
				if (typeof vdbeCursor.vtab.xDisconnect === 'function') {
					try {
						await vdbeCursor.vtab.xDisconnect();
					} catch (e) {
						console.error(`Error disconnecting VTab table instance (idx ${cIdx}, name: ${vdbeCursor.vtab.tableName}):`, e);
					}
				} else {
					console.warn(`VTab instance for cursor ${cIdx} (table: ${vdbeCursor.vtab.tableName}) does not implement xDisconnect.`);
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
