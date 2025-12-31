import { expect } from 'chai';
import {
  serializeChangeSet,
  deserializeChangeSet,
  serializeHLCForTransport,
  deserializeHLCFromTransport,
} from '../src/serialization.js';
import { generateSiteId, type ChangeSet, type HLC } from '@quereus/plugin-sync';

describe('Serialization', () => {
  describe('HLC serialization', () => {
    it('should round-trip an HLC', () => {
      const siteId = generateSiteId();
      const hlc: HLC = {
        wallTime: BigInt(Date.now()),
        counter: 42,
        siteId,
      };

      const serialized = serializeHLCForTransport(hlc);
      expect(serialized).to.be.a('string');

      const deserialized = deserializeHLCFromTransport(serialized);
      expect(deserialized.wallTime).to.equal(hlc.wallTime);
      expect(deserialized.counter).to.equal(hlc.counter);
      expect(deserialized.siteId).to.deep.equal(hlc.siteId);
    });
  });

  describe('ChangeSet serialization', () => {
    it('should round-trip a ChangeSet with column changes', () => {
      const siteId = generateSiteId();
      const hlc: HLC = {
        wallTime: BigInt(Date.now()),
        counter: 1,
        siteId,
      };

      const changeSet: ChangeSet = {
        siteId,
        transactionId: 'tx-123',
        hlc,
        changes: [
          {
            type: 'column',
            schema: 'main',
            table: 'users',
            pk: [1],
            column: 'name',
            value: 'Alice',
            hlc,
          },
        ],
        schemaMigrations: [],
      };

      const serialized = serializeChangeSet(changeSet);
      expect(serialized.siteId).to.be.a('string');
      expect(serialized.transactionId).to.equal('tx-123');
      expect(serialized.hlc).to.be.a('string');
      expect(serialized.changes).to.have.lengthOf(1);
      expect(serialized.changes[0].hlc).to.be.a('string');

      const deserialized = deserializeChangeSet(serialized);
      expect(deserialized.siteId).to.deep.equal(siteId);
      expect(deserialized.transactionId).to.equal('tx-123');
      expect(deserialized.hlc.wallTime).to.equal(hlc.wallTime);
      expect(deserialized.changes).to.have.lengthOf(1);
      expect(deserialized.changes[0].type).to.equal('column');
      const change = deserialized.changes[0];
      if (change.type === 'column') {
        expect(change.column).to.equal('name');
        expect(change.value).to.equal('Alice');
      }
    });

    it('should round-trip a ChangeSet with delete changes', () => {
      const siteId = generateSiteId();
      const hlc: HLC = {
        wallTime: BigInt(Date.now()),
        counter: 2,
        siteId,
      };

      const changeSet: ChangeSet = {
        siteId,
        transactionId: 'tx-456',
        hlc,
        changes: [
          {
            type: 'delete',
            schema: 'main',
            table: 'users',
            pk: [99],
            hlc,
          },
        ],
        schemaMigrations: [],
      };

      const serialized = serializeChangeSet(changeSet);
      const deserialized = deserializeChangeSet(serialized);

      expect(deserialized.changes[0].type).to.equal('delete');
      expect(deserialized.changes[0].pk).to.deep.equal([99]);
    });

    it('should round-trip a ChangeSet with schema migrations', () => {
      const siteId = generateSiteId();
      const hlc: HLC = {
        wallTime: BigInt(Date.now()),
        counter: 3,
        siteId,
      };

      const changeSet: ChangeSet = {
        siteId,
        transactionId: 'tx-789',
        hlc,
        changes: [],
        schemaMigrations: [
          {
            type: 'create_table',
            schema: 'main',
            table: 'new_table',
            ddl: 'CREATE TABLE new_table (id INTEGER PRIMARY KEY)',
            hlc,
            schemaVersion: 1,
          },
        ],
      };

      const serialized = serializeChangeSet(changeSet);
      expect(serialized.schemaMigrations).to.have.lengthOf(1);

      const deserialized = deserializeChangeSet(serialized);
      expect(deserialized.schemaMigrations).to.have.lengthOf(1);
      expect(deserialized.schemaMigrations[0].type).to.equal('create_table');
      expect(deserialized.schemaMigrations[0].ddl).to.include('CREATE TABLE');
    });
  });
});

