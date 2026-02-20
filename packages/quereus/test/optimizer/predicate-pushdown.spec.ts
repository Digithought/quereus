import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Predicate push-down (supported-only fragments)', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database();
  });

  afterEach(async () => {
    await db.close();
  });

  async function setup(): Promise<void> {
    await db.exec("CREATE TABLE ptab (id INTEGER PRIMARY KEY, name TEXT) USING memory");
    await db.exec("INSERT INTO ptab VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie')");
  }

  it('keeps residual FILTER above Retrieve when only part of predicate is supported', async () => {
    await setup();
    // id = 1 is supported (equality on PK) but LIKE is not handled by memory index planning
    const q = "SELECT name FROM ptab WHERE id = 1 AND name LIKE '%li%'";
    const rows: any[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS filters FROM query_plan(?) WHERE op = 'FILTER'", [q])) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    expect(rows[0].filters).to.equal(1);

    const access: any[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS accesses FROM query_plan(?) WHERE op IN ('SEQSCAN','INDEXSCAN','INDEXSEEK')", [q])) {
      access.push(r);
    }
    expect(access).to.have.lengthOf(1);
    expect(access[0].accesses).to.equal(1);
  });

  it('handles key-equality with residual arithmetic, keeping residual filter above index seek', async () => {
    await setup();
    const q = "SELECT name FROM ptab WHERE id = 2 AND (id + 0) > 0";
    const rows: any[] = [];
    for await (const r of db.eval("SELECT COUNT(*) AS filters FROM query_plan(?) WHERE op = 'FILTER'", [q])) {
      rows.push(r);
    }
    expect(rows).to.have.lengthOf(1);
    // IndexSeek handles id = 2 internally; residual (id + 0) > 0 stays as FILTER
    expect(rows[0].filters).to.equal(1);
  });
});


