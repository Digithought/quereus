/**
 * Simple Query Example
 *
 * Demonstrates the use of the SQLiter engine to create, populate and query
 * a memory table using the full SQL query engine.
 */

import { Database, MemoryTableModule, StatusCode } from '../src';

async function main() {
  try {
    console.log('SQLiter Simple Query Example');
    console.log('===========================\n');

    // Create a new database connection
    const db = new Database();
    console.log('Database created');

    // Register the memory table module
    const memoryModule = new MemoryTableModule();
    db.registerVtabModule('memory', memoryModule);
    console.log('Memory table module registered');

    // Create a virtual table using our memory module
    console.log('\nCreating users table...');
    await db.exec(`
      CREATE VIRTUAL TABLE users USING memory(
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        age INTEGER,
        active INTEGER DEFAULT 1
      )
    `);
    console.log('Table created successfully');

    // Insert some test data
    console.log('\nInserting test data...');
    await db.exec(`
      INSERT INTO users (id, name, email, age) VALUES
      (1, 'John Doe', 'john@example.com', 35),
      (2, 'Jane Smith', 'jane@example.com', 28),
      (3, 'Bob Johnson', 'bob@example.com', 42),
      (4, 'Alice Williams', 'alice@example.com', 31),
      (5, 'Charlie Brown', 'charlie@example.com', 25)
    `);
    console.log('Data inserted successfully');

    // Perform queries
    console.log('\nRunning simple SELECT query:');
    await db.exec(
      'SELECT id, name, email FROM users ORDER BY id',
      (row, columns) => {
        console.log(`${row.id}: ${row.name} (${row.email})`);
      }
    );

    // Query with WHERE clause
    console.log('\nRunning query with WHERE clause:');
    await db.exec(
      'SELECT name, age FROM users WHERE age > 30 ORDER BY age DESC',
      (row, columns) => {
        console.log(`${row.name} - ${row.age} years old`);
      }
    );

    // Query with parameters
    console.log('\nRunning query with parameters:');
    await db.exec(
      'SELECT * FROM users WHERE age >= ? AND age <= ?',
      [30, 40],
      (row, columns) => {
        console.log(`${row.name} - ${row.age} years old - ${row.email}`);
      }
    );

    // Update data
    console.log('\nUpdating data...');
    await db.exec(`UPDATE users SET active = 0 WHERE id = 3`);

    // Verify update
    console.log('\nVerifying update:');
    await db.exec(
      'SELECT name, active FROM users ORDER BY id',
      (row, columns) => {
        console.log(`${row.name} - Active: ${row.active ? 'Yes' : 'No'}`);
      }
    );

    // Delete data
    console.log('\nDeleting data...');
    await db.exec(`DELETE FROM users WHERE age < 30`);

    // Verify deletion
    console.log('\nVerifying deletion:');
    await db.exec(
      'SELECT name, age FROM users ORDER BY id',
      (row, columns) => {
        console.log(`${row.name} - ${row.age} years old`);
      }
    );

    // Using prepared statements and stepping through results
    console.log('\nUsing prepared statement:');
    const stmt = await db.prepare('SELECT id, name, email FROM users WHERE age > ?');
    stmt.bind(1, 30);

    let result = await stmt.step();
    while (result === StatusCode.ROW) {
      const row = stmt.getAsObject();
      console.log(`${row.id}: ${row.name} (${row.email})`);
      result = await stmt.step();
    }

    await stmt.finalize();

    // Clean up
    console.log('\nCleaning up...');
    await db.exec('DROP TABLE users');
    await db.close();
    console.log('Database closed');

    console.log('\nExample completed successfully');
  } catch (error) {
    console.error('Error:', error);
  }
}

// Run the example
main().catch(console.error);
