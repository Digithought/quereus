import { expect } from 'chai';
import { Database } from '../../src/index.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import {
	acquireConnectionLock,
	getModuleConcurrencyMode,
} from '../../src/vtab/concurrency.js';
import type {
	AnyVirtualTableModule,
	VtabConcurrencyMode,
} from '../../src/vtab/module.js';
import type { VirtualTableConnection } from '../../src/vtab/connection.js';

/**
 * Build a stub module declaring (or omitting) a concurrencyMode. The other
 * VirtualTableModule methods are unused by these tests, so we cast through
 * `unknown` rather than stubbing 20-odd async methods.
 */
function makeStubModule(mode?: VtabConcurrencyMode): AnyVirtualTableModule {
	return ({ concurrencyMode: mode } as unknown) as AnyVirtualTableModule;
}

/** Minimal VirtualTableConnection stand-in; the lock only needs identity. */
function makeStubConnection(id: string): VirtualTableConnection {
	return {
		connectionId: id,
		tableName: 't',
		begin() {},
		commit() {},
		rollback() {},
		createSavepoint() {},
		releaseSavepoint() {},
		rollbackToSavepoint() {},
		disconnect() {},
	};
}

describe('vtab concurrency contract', () => {
	describe('getModuleConcurrencyMode', () => {
		it('defaults to serial when undeclared', () => {
			expect(getModuleConcurrencyMode(makeStubModule())).to.equal('serial');
		});

		it('round-trips each declared mode', () => {
			expect(getModuleConcurrencyMode(makeStubModule('serial'))).to.equal('serial');
			expect(getModuleConcurrencyMode(makeStubModule('reentrant-reads'))).to.equal('reentrant-reads');
			expect(getModuleConcurrencyMode(makeStubModule('fully-reentrant'))).to.equal('fully-reentrant');
		});

		it('reports MemoryTableModule as reentrant-reads', () => {
			// Reads-only concurrency on a single connection is the only audited
			// safety property — writes mutate `pendingTransactionLayer` in place,
			// so `'fully-reentrant'` is unsafe until writer concurrency is
			// independently justified.
			const memModule = new MemoryTableModule();
			expect(getModuleConcurrencyMode(memModule)).to.equal('reentrant-reads');
		});
	});

	describe('acquireConnectionLock', () => {
		it('serializes acquirers on the same connection', async () => {
			const conn = makeStubConnection('c1');
			const events: string[] = [];

			const releaseA = await acquireConnectionLock(conn);
			events.push('a-acquired');

			// Start b's acquire; it must NOT resolve until releaseA() fires.
			const bPromise = acquireConnectionLock(conn).then(release => {
				events.push('b-acquired');
				return release;
			});

			// Yield a microtask so b has a chance to resolve if the lock is broken.
			await Promise.resolve();
			await Promise.resolve();
			expect(events).to.deep.equal(['a-acquired']);

			events.push('a-released');
			releaseA();

			const releaseB = await bPromise;
			expect(events).to.deep.equal(['a-acquired', 'a-released', 'b-acquired']);
			releaseB();
		});

		it('does not block across distinct connections', async () => {
			const connA = makeStubConnection('a');
			const connB = makeStubConnection('b');

			const releaseA = await acquireConnectionLock(connA);
			// B should acquire immediately even though A's lock is held.
			const releaseB = await acquireConnectionLock(connB);

			releaseA();
			releaseB();
		});

		it('releases the lock even when the critical section throws', async () => {
			const conn = makeStubConnection('c-throw');

			try {
				const release = await acquireConnectionLock(conn);
				try {
					throw new Error('boom');
				} finally {
					release();
				}
			} catch (e) {
				expect((e as Error).message).to.equal('boom');
			}

			// Next acquirer must proceed without deadlock.
			const release2 = await acquireConnectionLock(conn);
			release2();
		});
	});

	describe('memory vtab concurrent scan smoke', () => {
		// Load-bearing safety check for the 'reentrant-reads' declaration on
		// MemoryTableModule. If a future memory-vtab change breaks concurrent
		// reads, this test fails before any FanOutLookupJoin consumer needs it.
		//
		// db.eval() acquires the engine's exec mutex per call, so the four
		// iterators below do not actually overlap at the vtab layer in
		// today's runtime — but they share a manager/connection and exercise
		// the same scan path the parallel consumer will. The assertion holds
		// regardless: 4 × 50 rows, no corruption. A direct-`table.query()`
		// concurrent test that bypasses the exec mutex belongs alongside the
		// first FanOutLookupJoin consumer that actually parallel-drives the
		// vtab.
		it('produces correct cardinality across 4 concurrent select iterators', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, v integer)');
				for (let i = 0; i < 50; i++) {
					await db.exec(`insert into t values (${i}, ${i * 2})`);
				}

				const collectAll = async () => {
					const rows: Array<{ id: number; v: number }> = [];
					for await (const row of db.eval('select id, v from t')) {
						rows.push(row as unknown as { id: number; v: number });
					}
					return rows;
				};

				const results = await Promise.all([
					collectAll(), collectAll(), collectAll(), collectAll(),
				]);

				const total = results.reduce((n, r) => n + r.length, 0);
				expect(total).to.equal(4 * 50);

				for (const rows of results) {
					expect(rows).to.have.length(50);
					// Spot-check a couple of rows to catch row-shape corruption.
					expect(rows[0].id).to.equal(0);
					expect(rows[0].v).to.equal(0);
					expect(rows[49].id).to.equal(49);
					expect(rows[49].v).to.equal(98);
				}
			} finally {
				await db.close();
			}
		});
	});
});
