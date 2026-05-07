import { Database } from './dist/src/index.js';

const db = new Database();

// Mimic earlier section that creates and drops u2_a (to make 'drop table u2_a' work)
await db.exec(`create table u2_a (k text primary key, x text not null)`);
await db.exec(`insert into u2_a values ('r1', 'dup')`);
await db.exec(`create unique index u2_a_x on u2_a(x)`);

// Now the setup part of this block, as the test framework runs:
const setup = `drop table u2_a;
create table u2_b (k integer primary key, x text not null);
insert into u2_b values (1, 'a'), (2, 'b');
create unique index u2_b_x on u2_b(x);`;

await db.exec(setup);

// Inspect table schema
const sm = db.schemaManager;
const ts = sm.getTable('main', 'u2_b');
console.log('indexes:', JSON.stringify(ts.indexes));
console.log('uniqueConstraints:', JSON.stringify(ts.uniqueConstraints));

try {
    const stmt = db.prepare(`insert into u2_b values (3, 'a')`);
    try {
        for await (const _row of stmt.iterateRows()) {/* drain */}
    } finally {
        await stmt.finalize();
    }
    console.log('INSERT (prepared) SUCCEEDED (unexpected)');
} catch (e) {
    console.log('INSERT (prepared) REJECTED:', e.message);
}

// Read all rows
for await (const row of db.eval(`select * from u2_b order by k`)) {
    console.log(row);
}

await db.close();
