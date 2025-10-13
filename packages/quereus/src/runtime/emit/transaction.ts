import type { EmissionContext } from '../emission-context.js';
import type { TransactionNode } from '../../planner/nodes/transaction-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

const log = createLogger('runtime:emit:transaction');

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

export function emitTransaction(plan: TransactionNode, _ctx: EmissionContext): Instruction {
	// Select the operation function at emit time
	let run: (ctx: RuntimeContext) => Promise<SqlValue | undefined>;
	let note: string;

	switch (plan.operation) {
		case 'begin': {
			run = async (rctx: RuntimeContext) => {
				const connections = rctx.db.getAllConnections();
				log(`BEGIN: Found ${connections.length} active connections`);

				for (const connection of connections) {
					try {
						await connection.begin();
						log(`BEGIN: Successfully called on connection ${connection.connectionId}`);
					} catch (error) {
						log(`BEGIN: Error on connection ${connection.connectionId}: %O`, error);
						throw error;
					}
				}
				// Reflect explicit transaction state in Database
				rctx.db.markExplicitTransactionStart();
				// Reset any prior change tracking at the start of an explicit transaction
				rctx.db._clearChangeLog();
				return null;
			};
			note = `BEGIN ${plan.mode || 'DEFERRED'}`;
			break;
		}
		case 'commit': {
			run = async (rctx: RuntimeContext) => {
				// Snapshot connections before evaluating deferred constraints
				// (constraint evaluation may open additional connections that shouldn't be committed)
				const connectionsToCommit = rctx.db.getAllConnections();
				log(`COMMIT: Found ${connectionsToCommit.length} active connections`);

				try {
					// Evaluate global assertions and deferred row-level constraints BEFORE committing connections.
					await rctx.db.runGlobalAssertions();
					await rctx.db.runDeferredRowConstraints();

					// Mark coordinated commit to relax layer validation for sibling layers
					rctx.db._beginCoordinatedCommit();
					try {
						// Commit sequentially to avoid race conditions with layer promotion
						for (const connection of connectionsToCommit) {
							try {
								await connection.commit();
								log(`COMMIT: Successfully called on connection ${connection.connectionId}`);
							} catch (error) {
								log(`COMMIT: Error on connection ${connection.connectionId}: %O`, error);
								throw error;
							}
						}
					} finally {
						rctx.db._endCoordinatedCommit();
					}
				} catch (e) {
					// If assertions fail (or a commit throws), rollback all connections
					await Promise.allSettled(rctx.db.getAllConnections().map(c => c.rollback()));
					throw e;
				} finally {
					// Always mark end of explicit transaction and clear change tracking
					rctx.db.markExplicitTransactionEnd();
					rctx.db._clearChangeLog();
				}
				return null;
			};
			note = 'COMMIT';
			break;
		}

		case 'rollback': {
			if (plan.savepoint) {
				const savepointIndex = hashSavepointName(plan.savepoint); // Convert name to index
				run = async (rctx: RuntimeContext) => {
					const connections = rctx.db.getAllConnections();
					log(`ROLLBACK TO SAVEPOINT ${savepointIndex}: Found ${connections.length} active connections`);

					for (const connection of connections) {
						try {
							await connection.rollbackToSavepoint(savepointIndex);
							log(`ROLLBACK TO SAVEPOINT ${savepointIndex}: Successfully called on connection ${connection.connectionId}`);
						} catch (error) {
							log(`ROLLBACK TO SAVEPOINT ${savepointIndex}: Error on connection ${connection.connectionId}: %O`, error);
							throw error;
						}
					}
					// Discard top change layer
					rctx.db._rollbackSavepointLayer();
					return null;
				};
				note = `ROLLBACK TO SAVEPOINT ${plan.savepoint}`;
			} else {
				run = async (rctx: RuntimeContext) => {
					const connections = rctx.db.getAllConnections();
					log(`ROLLBACK: Found ${connections.length} active connections`);

					for (const connection of connections) {
						try {
							await connection.rollback();
							log(`ROLLBACK: Successfully called on connection ${connection.connectionId}`);
						} catch (error) {
							log(`ROLLBACK: Error on connection ${connection.connectionId}: %O`, error);
							throw error;
						}
					}
					// Reflect explicit transaction end and clear change tracking
					rctx.db.markExplicitTransactionEnd();
					rctx.db._clearChangeLog();
					return null;
				};
				note = 'ROLLBACK';
			}
			break;
		}

		case 'savepoint': {
			if (!plan.savepoint) {
				quereusError('Savepoint name is required for SAVEPOINT operation', StatusCode.MISUSE);
			}
			const savepointIndex = hashSavepointName(plan.savepoint); // Convert name to index
			run = async (rctx: RuntimeContext) => {
				const connections = rctx.db.getAllConnections();
				log(`SAVEPOINT ${savepointIndex}: Found ${connections.length} active connections`);

				for (const connection of connections) {
					try {
						await connection.createSavepoint(savepointIndex);
						log(`SAVEPOINT ${savepointIndex}: Successfully called on connection ${connection.connectionId}`);
					} catch (error) {
						log(`SAVEPOINT ${savepointIndex}: Error on connection ${connection.connectionId}: %O`, error);
						throw error;
					}
				}
				// Mark database as in explicit transaction (savepoints require explicit transaction context)
				rctx.db.markExplicitTransactionStart();
				// Track change layer
				rctx.db._beginSavepointLayer();
				return null;
			};
			note = `SAVEPOINT ${plan.savepoint}`;
			break;
		}

		case 'release': {
			if (!plan.savepoint) {
				quereusError('Savepoint name is required for RELEASE operation', StatusCode.MISUSE);
			}
			const releaseSavepointIndex = hashSavepointName(plan.savepoint); // Convert name to index
			run = async (rctx: RuntimeContext) => {
				const connections = rctx.db.getAllConnections();
				log(`RELEASE SAVEPOINT ${releaseSavepointIndex}: Found ${connections.length} active connections`);

				for (const connection of connections) {
					try {
						await connection.releaseSavepoint(releaseSavepointIndex);
						log(`RELEASE SAVEPOINT ${releaseSavepointIndex}: Successfully called on connection ${connection.connectionId}`);
					} catch (error) {
						log(`RELEASE SAVEPOINT ${releaseSavepointIndex}: Error on connection ${connection.connectionId}: %O`, error);
						throw error;
					}
				}
				// Merge top change layer into below
				rctx.db._releaseSavepointLayer();
				return null;
			};
			note = `RELEASE SAVEPOINT ${plan.savepoint}`;
			break;
		}

		default:
			quereusError(
				`Unsupported transaction operation: ${plan.operation}`,
				StatusCode.UNSUPPORTED
			);
	}

	return {
		params: [],
		run: run as InstructionRun,
		note
	};
}
