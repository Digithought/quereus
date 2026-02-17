/**
 * Tests for StoreEventEmitter.
 */

import { expect } from 'chai';
import {
	StoreEventEmitter,
	type SchemaChangeEvent,
	type DataChangeEvent,
} from '../src/common/events.js';

describe('StoreEventEmitter', () => {
	let emitter: StoreEventEmitter;

	beforeEach(() => {
		emitter = new StoreEventEmitter();
	});

	describe('schema change events', () => {
		it('emits to subscribers', () => {
			const events: SchemaChangeEvent[] = [];
			emitter.onSchemaChange(e => events.push(e));
			emitter.emitSchemaChange({ type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users' });
			expect(events).to.have.length(1);
			expect(events[0].objectName).to.equal('users');
		});

		it('unsubscribe stops delivery', () => {
			const events: SchemaChangeEvent[] = [];
			const unsub = emitter.onSchemaChange(e => events.push(e));
			unsub();
			emitter.emitSchemaChange({ type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users' });
			expect(events).to.have.length(0);
		});
	});

	describe('data change events', () => {
		it('emits to subscribers', () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));
			emitter.emitDataChange({ type: 'insert', schemaName: 'main', tableName: 'users' });
			expect(events).to.have.length(1);
		});

		it('unsubscribe stops delivery', () => {
			const events: DataChangeEvent[] = [];
			const unsub = emitter.onDataChange(e => events.push(e));
			unsub();
			emitter.emitDataChange({ type: 'insert', schemaName: 'main', tableName: 'users' });
			expect(events).to.have.length(0);
		});

		it('supports multiple listeners', () => {
			let count = 0;
			emitter.onDataChange(() => count++);
			emitter.onDataChange(() => count++);
			emitter.emitDataChange({ type: 'insert', schemaName: 'main', tableName: 'users' });
			expect(count).to.equal(2);
		});
	});

	describe('batching', () => {
		it('queues events during batch', () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));
			emitter.startBatch();
			emitter.emitDataChange({ type: 'insert', schemaName: 'main', tableName: 'users' });
			expect(events).to.have.length(0);
		});

		it('flushBatch delivers queued events', () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));
			emitter.startBatch();
			emitter.emitDataChange({ type: 'insert', schemaName: 'main', tableName: 'users' });
			emitter.emitDataChange({ type: 'update', schemaName: 'main', tableName: 'users' });
			emitter.flushBatch();
			expect(events).to.have.length(2);
		});

		it('discardBatch drops queued events', () => {
			const events: DataChangeEvent[] = [];
			emitter.onDataChange(e => events.push(e));
			emitter.startBatch();
			emitter.emitDataChange({ type: 'insert', schemaName: 'main', tableName: 'users' });
			emitter.discardBatch();
			expect(events).to.have.length(0);
		});
	});

	describe('listener error handling', () => {
		it('continues to other listeners when one throws', () => {
			let secondCalled = false;
			emitter.onDataChange(() => { throw new Error('boom'); });
			emitter.onDataChange(() => { secondCalled = true; });
			emitter.emitDataChange({ type: 'insert', schemaName: 'main', tableName: 'users' });
			expect(secondCalled).to.be.true;
		});
	});

	describe('hasListeners / hasDataListeners / hasSchemaListeners', () => {
		it('returns false when no listeners', () => {
			expect(emitter.hasListeners()).to.be.false;
			expect(emitter.hasDataListeners()).to.be.false;
			expect(emitter.hasSchemaListeners()).to.be.false;
		});

		it('returns true for data listeners', () => {
			emitter.onDataChange(() => {});
			expect(emitter.hasListeners()).to.be.true;
			expect(emitter.hasDataListeners()).to.be.true;
			expect(emitter.hasSchemaListeners()).to.be.false;
		});

		it('returns true for schema listeners', () => {
			emitter.onSchemaChange(() => {});
			expect(emitter.hasListeners()).to.be.true;
			expect(emitter.hasSchemaListeners()).to.be.true;
			expect(emitter.hasDataListeners()).to.be.false;
		});
	});

	describe('removeAllListeners', () => {
		it('removes all listeners', () => {
			emitter.onDataChange(() => {});
			emitter.onSchemaChange(() => {});
			emitter.removeAllListeners();
			expect(emitter.hasListeners()).to.be.false;
		});
	});

	describe('remote event tracking', () => {
		it('marks matching schema event as remote', () => {
			const events: SchemaChangeEvent[] = [];
			emitter.onSchemaChange(e => events.push(e));
			emitter.expectRemoteSchemaEvent({ type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users' });
			emitter.emitSchemaChange({ type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users' });
			expect(events[0].remote).to.be.true;
		});

		it('does not mark non-matching event as remote', () => {
			const events: SchemaChangeEvent[] = [];
			emitter.onSchemaChange(e => events.push(e));
			emitter.expectRemoteSchemaEvent({ type: 'create', objectType: 'table', schemaName: 'main', objectName: 'other' });
			emitter.emitSchemaChange({ type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users' });
			expect(events[0].remote).to.be.undefined;
		});

		it('clearExpectedRemoteSchemaEvent prevents remote marking', () => {
			const events: SchemaChangeEvent[] = [];
			emitter.onSchemaChange(e => events.push(e));
			emitter.expectRemoteSchemaEvent({ type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users' });
			emitter.clearExpectedRemoteSchemaEvent({ type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users' });
			emitter.emitSchemaChange({ type: 'create', objectType: 'table', schemaName: 'main', objectName: 'users' });
			expect(events[0].remote).to.be.undefined;
		});
	});
});

