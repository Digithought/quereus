import type { EmissionContext } from '../emission-context.js';
import type { TransactionNode } from '../../planner/nodes/transaction-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { SqlValue } from '../../common/types.js';
import type { VirtualTable } from '../../vtab/table.js';

export function emitTransaction(plan: TransactionNode, ctx: EmissionContext): Instruction {
	// Select the operation function at emit time
	let run: (ctx: RuntimeContext) => Promise<SqlValue | undefined>;
	let note: string;

	switch (plan.operation) {
		case 'begin':
			run = async (rctx: RuntimeContext) => {
				// Call xBegin on all active virtual tables
				const activeVTabs = rctx.activeVTabs || new Set();
				console.log(`BEGIN: Found ${activeVTabs.size} active VirtualTable instances`);
				for (const vtab of activeVTabs) {
					if (vtab.xBegin) {
						try {
							console.log(`Calling xBegin on table: ${vtab.tableName}`);
							await vtab.xBegin();
						} catch (error) {
							console.warn(`Failed to call xBegin on table ${vtab.tableName}:`, error);
							// Continue with other tables rather than failing completely
						}
					}
				}
				return null;
			};
			note = `BEGIN ${plan.mode || 'DEFERRED'}`;
			break;

		case 'commit':
			run = async (rctx: RuntimeContext) => {
				// Call xCommit on all active virtual tables
				const activeVTabs = rctx.activeVTabs || new Set();
				console.log(`COMMIT: Found ${activeVTabs.size} active VirtualTable instances`);
				for (const vtab of activeVTabs) {
					if (vtab.xCommit) {
						try {
							console.log(`Calling xCommit on table: ${vtab.tableName}`);
							await vtab.xCommit();
						} catch (error) {
							console.warn(`Failed to call xCommit on table ${vtab.tableName}:`, error);
							// Continue with other tables rather than failing completely
						}
					}
				}
				return null;
			};
			note = 'COMMIT';
			break;

		case 'rollback':
			if (plan.savepoint) {
				const savepoint = plan.savepoint; // Capture for closure
				run = async (rctx: RuntimeContext) => {
					// Rollback to savepoint on all active virtual tables
					const activeVTabs = rctx.activeVTabs || new Set();
					console.log(`ROLLBACK TO SAVEPOINT: Found ${activeVTabs.size} active VirtualTable instances`);
					for (const vtab of activeVTabs) {
						if (vtab.xRollbackTo) {
							try {
								console.log(`Calling xRollbackTo on table: ${vtab.tableName}`);
								// Convert savepoint name to index (simple hash for now)
								const savepointIndex = hashSavepointName(savepoint);
								await vtab.xRollbackTo(savepointIndex);
							} catch (error) {
								console.warn(`Failed to call xRollbackTo on table ${vtab.tableName}:`, error);
								// Continue with other tables rather than failing completely
							}
						}
					}
					return null;
				};
				note = `ROLLBACK TO SAVEPOINT ${savepoint}`;
			} else {
				run = async (rctx: RuntimeContext) => {
					// Full rollback on all active virtual tables
					const activeVTabs = rctx.activeVTabs || new Set();
					console.log(`ROLLBACK: Found ${activeVTabs.size} active VirtualTable instances`);
					for (const vtab of activeVTabs) {
						if (vtab.xRollback) {
							try {
								console.log(`Calling xRollback on table: ${vtab.tableName}`);
								await vtab.xRollback();
							} catch (error) {
								console.warn(`Failed to call xRollback on table ${vtab.tableName}:`, error);
								// Continue with other tables rather than failing completely
							}
						}
					}
					return null;
				};
				note = 'ROLLBACK';
			}
			break;

		case 'savepoint':
			if (!plan.savepoint) {
				throw new Error('Savepoint name is required for SAVEPOINT operation');
			}
			const savepointName = plan.savepoint; // Capture for closure
			run = async (rctx: RuntimeContext) => {
				// Create savepoint on all active virtual tables
				const activeVTabs = rctx.activeVTabs || new Set();
				console.log(`SAVEPOINT: Found ${activeVTabs.size} active VirtualTable instances`);
				for (const vtab of activeVTabs) {
					if (vtab.xSavepoint) {
						try {
							console.log(`Calling xSavepoint on table: ${vtab.tableName}`);
							// Convert savepoint name to index (simple hash for now)
							const savepointIndex = hashSavepointName(savepointName);
							await vtab.xSavepoint(savepointIndex);
						} catch (error) {
							console.warn(`Failed to call xSavepoint on table ${vtab.tableName}:`, error);
							// Continue with other tables rather than failing completely
						}
					}
				}
				return null;
			};
			note = `SAVEPOINT ${savepointName}`;
			break;

		case 'release':
			if (!plan.savepoint) {
				throw new Error('Savepoint name is required for RELEASE operation');
			}
			const releaseSavepoint = plan.savepoint; // Capture for closure
			run = async (rctx: RuntimeContext) => {
				// Release savepoint on all active virtual tables
				const activeVTabs = rctx.activeVTabs || new Set();
				console.log(`RELEASE SAVEPOINT: Found ${activeVTabs.size} active VirtualTable instances`);
				for (const vtab of activeVTabs) {
					if (vtab.xRelease) {
						try {
							console.log(`Calling xRelease on table: ${vtab.tableName}`);
							// Convert savepoint name to index (simple hash for now)
							const savepointIndex = hashSavepointName(releaseSavepoint);
							await vtab.xRelease(savepointIndex);
						} catch (error) {
							console.warn(`Failed to call xRelease on table ${vtab.tableName}:`, error);
							// Continue with other tables rather than failing completely
						}
					}
				}
				return null;
			};
			note = `RELEASE SAVEPOINT ${releaseSavepoint}`;
			break;

		default:
			throw new Error(`Unsupported transaction operation: ${plan.operation}`);
	}

	return {
		params: [],
		run: run as InstructionRun,
		note
	};
}

// Helper function to register a VirtualTable instance as active
export function registerActiveVTab(rctx: RuntimeContext, vtab: VirtualTable): void {
	if (!rctx.activeVTabs) {
		rctx.activeVTabs = new Set();
	}
	console.log(`Registering VirtualTable: ${vtab.tableName} (total: ${rctx.activeVTabs.size + 1})`);
	rctx.activeVTabs.add(vtab);
}

// Helper function to unregister a VirtualTable instance
export function unregisterActiveVTab(rctx: RuntimeContext, vtab: VirtualTable): void {
	if (rctx.activeVTabs) {
		const wasPresent = rctx.activeVTabs.delete(vtab);
		console.log(`Unregistering VirtualTable: ${vtab.tableName} (was present: ${wasPresent}, remaining: ${rctx.activeVTabs.size})`);
	}
}

// Simple hash function to convert savepoint names to indices
function hashSavepointName(name: string): number {
	let hash = 0;
	for (let i = 0; i < name.length; i++) {
		const char = name.charCodeAt(i);
		hash = ((hash << 5) - hash) + char;
		hash = hash & hash; // Convert to 32-bit integer
	}
	return Math.abs(hash);
}
