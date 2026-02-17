/**
 * Tests for TransactionCoordinator.
 */

import { expect } from 'chai';
import { TransactionCoordinator, type TransactionCallbacks } from '../src/common/transaction.js';
import { StoreEventEmitter, type DataChangeEvent } from '../src/common/events.js';
import { InMemoryKVStore } from '../src/common/memory-store.js';

describe('TransactionCoordinator', () => {
	let store: InMemoryKVStore;
	let emitter: StoreEventEmitter;
	let coordinator: TransactionCoordinator;

	beforeEach(() => {
		store = new InMemoryKVStore();
		emitter = new StoreEventEmitter();
		coordinator = new TransactionCoordinator(store, emitter);
	});

	afterEach(async () => {
		await store.close();
	});

	describe('begin / isInTransaction', () => {
		it('starts not in transaction', () => {
			expect(coordinator.isInTransaction()).to.be.false;
		});

		it('enters transaction after begin', () => {
			coordinator.begin();
			expect(coordinator.isInTransaction()).to.be.true;
		});

		it('begin is idempotent when already in transaction', () => {
			coordinator.begin();
			coordinator.begin(); // no-op
			expect(coordinator.isInTransaction()).to.be.true;
		});
	});

	describe('put / delete outside transaction', () => {
		it('throws when put called outside transaction', () => {
			expect(() => coordinator.put(new Uint8Array([1]), new Uint8Array([2]))).to.throw(/outside transaction/i);
		});

		it('throws when delete called outside transaction', () => {
			expect(() => coordinator.delete(new Uint8Array([1]))).to.throw(/outside transaction/i);
		});
	});

	describe('commit', () => {
		it('writes pending operations to the store', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]));
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(coordinator.isInTransaction()).to.be.false;
		});

		it('fires pending events on commit', async () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));

			coordinator.begin();
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			coordinator.queueEvent({ type: 'update', schemaName: 'main', tableName: 't' });
			expect(events).to.have.length(0);
			await coordinator.commit();
			expect(events).to.have.length(2);
		});

		it('commit when not in transaction is a no-op', async () => {
			await coordinator.commit(); // should not throw
		});

		it('notifies callbacks on commit', async () => {
			let committed = false;
			coordinator.registerCallbacks({ onCommit: () => { committed = true; }, onRollback: () => {} });
			coordinator.begin();
			await coordinator.commit();
			expect(committed).to.be.true;
		});
	});

	describe('rollback', () => {
		it('discards pending operations', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.rollback();

			expect(await store.get(new Uint8Array([1]))).to.be.undefined;
			expect(coordinator.isInTransaction()).to.be.false;
		});

		it('discards pending events', () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));

			coordinator.begin();
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			coordinator.rollback();
			expect(events).to.have.length(0);
		});

		it('rollback when not in transaction is a no-op', () => {
			coordinator.rollback(); // should not throw
		});

		it('notifies callbacks on rollback', () => {
			let rolledBack = false;
			coordinator.registerCallbacks({ onCommit: () => {}, onRollback: () => { rolledBack = true; } });
			coordinator.begin();
			coordinator.rollback();
			expect(rolledBack).to.be.true;
		});
	});

	describe('queueEvent outside transaction', () => {
		it('emits immediately when not in transaction', () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			expect(events).to.have.length(1);
		});
	});

	describe('savepoints', () => {
		it('creates and releases savepoint', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]));
			coordinator.releaseSavepoint(0);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
		});

		it('rollback to savepoint discards ops after savepoint', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]));
			coordinator.rollbackToSavepoint(0);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.be.undefined;
		});

		it('rollback to savepoint also discards queued events', async () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));

			coordinator.begin();
			coordinator.queueEvent({ type: 'insert', schemaName: 'main', tableName: 't' });
			coordinator.createSavepoint(0);
			coordinator.queueEvent({ type: 'update', schemaName: 'main', tableName: 't' });
			coordinator.rollbackToSavepoint(0);
			await coordinator.commit();

			expect(events).to.have.length(1);
			expect(events[0].type).to.equal('insert');
		});

		it('nested savepoints', async () => {
			coordinator.begin();
			coordinator.put(new Uint8Array([1]), new Uint8Array([10]));
			coordinator.createSavepoint(0);
			coordinator.put(new Uint8Array([2]), new Uint8Array([20]));
			coordinator.createSavepoint(1);
			coordinator.put(new Uint8Array([3]), new Uint8Array([30]));
			coordinator.rollbackToSavepoint(1);
			await coordinator.commit();

			expect(await store.get(new Uint8Array([1]))).to.deep.equal(new Uint8Array([10]));
			expect(await store.get(new Uint8Array([2]))).to.deep.equal(new Uint8Array([20]));
			expect(await store.get(new Uint8Array([3]))).to.be.undefined;
		});

		it('rollbackToSavepoint with invalid depth throws', () => {
			coordinator.begin();
			expect(() => coordinator.rollbackToSavepoint(5)).to.throw(/not found/i);
		});
	});

	describe('getStore', () => {
		it('returns the underlying store', () => {
			expect(coordinator.getStore()).to.equal(store);
		});
	});
});
