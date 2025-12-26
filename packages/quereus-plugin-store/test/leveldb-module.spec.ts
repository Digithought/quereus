/**
 * Integration tests for LevelDB module with full CRUD operations, events, and statistics.
 */

import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Database } from '@quereus/quereus';
import { LevelDBModule } from '../src/leveldb/module.js';
import { StoreEventEmitter, type DataChangeEvent, type SchemaChangeEvent } from '../src/common/events.js';

describe('LevelDBModule Integration', function() {
  this.timeout(60000); // 60 second timeout for all tests

  let testDir: string;
  let db: Database;
  let module: LevelDBModule;
  let eventEmitter: StoreEventEmitter;
  let dataEvents: DataChangeEvent[];
  let schemaEvents: SchemaChangeEvent[];

  beforeEach(async function() {
    // Create a unique temp directory for each test
    testDir = path.join(os.tmpdir(), `quereus-leveldb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(testDir, { recursive: true });

    // Create event emitter and track events
    eventEmitter = new StoreEventEmitter();
    dataEvents = [];
    schemaEvents = [];
    eventEmitter.onDataChange((event) => dataEvents.push(event));
    eventEmitter.onSchemaChange((event) => schemaEvents.push(event));

    // Create database and module
    db = new Database();
    module = new LevelDBModule(eventEmitter);
    db.registerVtabModule('leveldb', module);
  });

  afterEach(async function() {
    await db.close();
    // Close all module stores to release file locks
    await module.closeAll();
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('Table creation and schema events', () => {
    it('should emit schema change event on table creation', async () => {
      await db.exec(`
        create table test_table (
          id integer primary key,
          name text,
          value real
        ) using leveldb (path = '${testDir.replace(/\\/g, '/')}')
      `);

      expect(schemaEvents.length).to.equal(1);
      expect(schemaEvents[0].type).to.equal('create');
      expect(schemaEvents[0].objectType).to.equal('table');
      expect(schemaEvents[0].objectName).to.equal('test_table');
      expect(schemaEvents[0].ddl).to.include('test_table');
    });

    it('should emit schema change event on table drop', async () => {
      await db.exec(`
        create table drop_test (
          id integer primary key
        ) using leveldb (path = '${testDir.replace(/\\/g, '/')}')
      `);
      schemaEvents.length = 0; // Clear creation event

      await db.exec('drop table drop_test');

      expect(schemaEvents.length).to.equal(1);
      expect(schemaEvents[0].type).to.equal('drop');
      expect(schemaEvents[0].objectType).to.equal('table');
      expect(schemaEvents[0].objectName).to.equal('drop_test');
    });
  });

  describe('CRUD operations and data events', () => {
    beforeEach(async () => {
      await db.exec(`
        create table users (
          id integer primary key,
          name text,
          email text
        ) using leveldb (path = '${testDir.replace(/\\/g, '/')}')
      `);
      schemaEvents.length = 0;
    });

    it('should insert rows and emit data change events', async () => {
      await db.exec(`insert into users (id, name, email) values (1, 'Alice', 'alice@example.com')`);

      expect(dataEvents.length).to.equal(1);
      expect(dataEvents[0].type).to.equal('insert');
      expect(dataEvents[0].tableName).to.equal('users');
      expect(dataEvents[0].newRow).to.deep.equal([1, 'Alice', 'alice@example.com']);
    });

    it('should update rows and emit data change events', async () => {
      await db.exec(`insert into users (id, name, email) values (1, 'Alice', 'alice@example.com')`);
      dataEvents.length = 0;

      await db.exec(`update users set name = 'Alicia' where id = 1`);

      expect(dataEvents.length).to.equal(1);
      expect(dataEvents[0].type).to.equal('update');
      expect(dataEvents[0].oldRow).to.deep.equal([1, 'Alice', 'alice@example.com']);
      expect(dataEvents[0].newRow).to.deep.equal([1, 'Alicia', 'alice@example.com']);
    });

    it('should delete rows and emit data change events', async () => {
      await db.exec(`insert into users (id, name, email) values (1, 'Alice', 'alice@example.com')`);
      dataEvents.length = 0;

      await db.exec(`delete from users where id = 1`);

      expect(dataEvents.length).to.equal(1);
      expect(dataEvents[0].type).to.equal('delete');
      expect(dataEvents[0].oldRow).to.deep.equal([1, 'Alice', 'alice@example.com']);
    });

    it('should query inserted data', async () => {
      await db.exec(`insert into users (id, name, email) values (1, 'Alice', 'alice@example.com')`);
      await db.exec(`insert into users (id, name, email) values (2, 'Bob', 'bob@example.com')`);

      const result: any[] = [];
      for await (const row of db.eval('select * from users order by id')) {
        result.push(row);
      }

      expect(result.length).to.equal(2);
      expect(result[0].id).to.equal(1);
      expect(result[0].name).to.equal('Alice');
      expect(result[1].id).to.equal(2);
      expect(result[1].name).to.equal('Bob');
    });
  });

  describe('Statistics tracking', () => {
    beforeEach(async () => {
      await db.exec(`
        create table stats_test (
          id integer primary key,
          data text
        ) using leveldb (path = '${testDir.replace(/\\/g, '/')}')
      `);
    });

    it('should track row count after inserts', async () => {
      for (let i = 0; i < 10; i++) {
        await db.exec(`insert into stats_test (id, data) values (${i}, 'data${i}')`);
      }

      const table = module.getTable('main', 'stats_test');
      expect(table).to.not.be.undefined;
      const rowCount = await table!.getEstimatedRowCount();
      expect(rowCount).to.equal(10);
    });

    it('should track row count after deletes', async () => {
      for (let i = 0; i < 10; i++) {
        await db.exec(`insert into stats_test (id, data) values (${i}, 'data${i}')`);
      }
      await db.exec(`delete from stats_test where id < 5`);

      const table = module.getTable('main', 'stats_test');
      const rowCount = await table!.getEstimatedRowCount();
      expect(rowCount).to.equal(5);
    });
  });

  describe('Transaction support', () => {
    beforeEach(async () => {
      await db.exec(`
        create table txn_test (
          id integer primary key,
          value text
        ) using leveldb (path = '${testDir.replace(/\\/g, '/')}')
      `);
      schemaEvents.length = 0;
      dataEvents.length = 0;
    });

    it('should commit transaction and emit events', async () => {
      await db.exec('begin');
      await db.exec(`insert into txn_test (id, value) values (1, 'one')`);
      await db.exec(`insert into txn_test (id, value) values (2, 'two')`);

      // Events should not be emitted yet during transaction
      expect(dataEvents.length).to.equal(0);

      await db.exec('commit');

      // Events should be emitted after commit
      expect(dataEvents.length).to.equal(2);
      expect(dataEvents[0].type).to.equal('insert');
      expect(dataEvents[0].newRow).to.deep.equal([1, 'one']);
      expect(dataEvents[1].newRow).to.deep.equal([2, 'two']);

      // Data should be persisted
      const result: any[] = [];
      for await (const row of db.eval('select * from txn_test order by id')) {
        result.push(row);
      }
      expect(result.length).to.equal(2);
    });

    it('should rollback transaction and discard changes', async () => {
      // Insert initial data
      await db.exec(`insert into txn_test (id, value) values (1, 'one')`);
      dataEvents.length = 0;

      await db.exec('begin');
      await db.exec(`insert into txn_test (id, value) values (2, 'two')`);
      await db.exec(`update txn_test set value = 'modified' where id = 1`);
      await db.exec('rollback');

      // No events should be emitted for rolled-back operations
      expect(dataEvents.length).to.equal(0);

      // Original data should be unchanged
      const result: any[] = [];
      for await (const row of db.eval('select * from txn_test order by id')) {
        result.push(row);
      }
      expect(result.length).to.equal(1);
      expect(result[0].value).to.equal('one');
    });

    it('should support savepoints', async () => {
      await db.exec('begin');
      await db.exec(`insert into txn_test (id, value) values (1, 'one')`);
      await db.exec('savepoint sp1');
      await db.exec(`insert into txn_test (id, value) values (2, 'two')`);
      await db.exec('rollback to savepoint sp1');
      await db.exec(`insert into txn_test (id, value) values (3, 'three')`);
      await db.exec('commit');

      // Should have 2 events: insert 1 and insert 3 (insert 2 was rolled back)
      expect(dataEvents.length).to.equal(2);

      const result: any[] = [];
      for await (const row of db.eval('select * from txn_test order by id')) {
        result.push(row);
      }
      expect(result.length).to.equal(2);
      expect(result[0].id).to.equal(1);
      expect(result[1].id).to.equal(3);
    });
  });
});

