import type { EmissionContext } from '../emission-context.js';
import type { TransactionNode } from '../../planner/nodes/transaction-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { SqlValue } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import { quereusError } from '../../common/errors.js';
import { StatusCode } from '../../common/types.js';

const log = createLogger('runtime:emit:transaction');

export function emitTransaction(plan: TransactionNode, _ctx: EmissionContext): Instruction {
	// Select the operation function at emit time
	let run: (ctx: RuntimeContext) => Promise<SqlValue | undefined>;
	let note: string;

	switch (plan.operation) {
		case 'begin': {
			run = async (rctx: RuntimeContext) => {
				log('BEGIN: Starting explicit transaction');
				await rctx.db._beginTransaction('explicit');
				return null;
			};
			note = 'BEGIN';
			break;
		}

		case 'commit': {
			run = async (rctx: RuntimeContext) => {
				log('COMMIT: Committing transaction');
				await rctx.db._commitTransaction();
				return null;
			};
			note = 'COMMIT';
			break;
		}

		case 'rollback': {
			if (plan.savepoint) {
				const savepointName = plan.savepoint;
				run = async (rctx: RuntimeContext) => {
					log(`ROLLBACK TO SAVEPOINT ${savepointName}`);

					// TransactionManager validates the name and rolls back change/event layers.
					// Returns the depth index that connections should roll back to.
					const targetDepth = rctx.db._rollbackToSavepoint(savepointName);

					// Roll back each connection to the target savepoint depth
					const connections = rctx.db.getAllConnections();
					for (const connection of connections) {
						await connection.rollbackToSavepoint(targetDepth);
					}
					return null;
				};
				note = `ROLLBACK TO SAVEPOINT ${plan.savepoint}`;
			} else {
				run = async (rctx: RuntimeContext) => {
					log('ROLLBACK: Rolling back transaction');
					await rctx.db._rollbackTransaction();
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
			const savepointName = plan.savepoint;
			run = async (rctx: RuntimeContext) => {
				// Ensure we're in a transaction first (savepoints require transaction context)
				await rctx.db._ensureTransaction();

				// Upgrade implicit transaction to explicit - savepoints mean the user
				// wants transaction control, so we shouldn't auto-commit
				rctx.db._upgradeToExplicitTransaction();

				// TransactionManager tracks the name and creates change/event layers
				const depth = rctx.db._createSavepoint(savepointName);

				const connections = rctx.db.getAllConnections();
				log(`SAVEPOINT ${savepointName} (depth ${depth}): ${connections.length} connections`);

				for (const connection of connections) {
					await connection.createSavepoint(depth);
				}
				return null;
			};
			note = `SAVEPOINT ${plan.savepoint}`;
			break;
		}

		case 'release': {
			if (!plan.savepoint) {
				quereusError('Savepoint name is required for RELEASE operation', StatusCode.MISUSE);
			}
			const savepointName = plan.savepoint;
			run = async (rctx: RuntimeContext) => {
				log(`RELEASE SAVEPOINT ${savepointName}`);

				// TransactionManager validates the name and releases change/event layers
				const targetDepth = rctx.db._releaseSavepoint(savepointName);

				// Release each connection's savepoint at the target depth
				const connections = rctx.db.getAllConnections();
				for (const connection of connections) {
					await connection.releaseSavepoint(targetDepth);
				}
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
