/**
 * Memory Table Module Demo
 *
 * This example demonstrates how to use the MemoryTableModule in SQLiter
 * to create and work with in-memory tables.
 */

import { Database } from '../src/core/database';
import { MemoryTableModule } from '../src/vtab/memory-table';

async function runDemo() {
  console.log('SQLiter Memory Table Module Demo');
  console.log('================================\n');

  // Create a new database instance
  const db = new Database();

  // Create and register the MemoryTableModule
  const memoryModule = new MemoryTableModule();
  db.registerVtabModule('memory', memoryModule);

  console.log('Creating products table...');

  // Create a virtual memory table for products
  await db.exec(`
    CREATE TABLE products USING memory(
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      price REAL,
      in_stock INTEGER DEFAULT 0
    )
  `);

  console.log('Inserting sample products...');

  // Insert sample data
  await db.exec(`
    INSERT INTO products (id, name, category, price, in_stock) VALUES
    (1, 'Laptop', 'Electronics', 999.99, 12),
    (2, 'Smartphone', 'Electronics', 699.50, 25),
    (3, 'Headphones', 'Electronics', 149.99, 40),
    (4, 'Coffee Mug', 'Kitchen', 12.99, 100),
    (5, 'Water Bottle', 'Kitchen', 9.99, 75),
    (6, 'Backpack', 'Accessories', 59.99, 30),
    (7, 'USB Cable', 'Electronics', 14.50, 60)
  `);

  // Query 1: Select all products
  console.log('\nAll Products:');
  await db.exec(
    `SELECT id, name, price FROM products ORDER BY id`,
    [],
    (row) => {
      console.log(`${row[0]}: ${row[1]} - $${row[2]}`);
    }
  );

  // Query 2: Filter by category
  console.log('\nElectronics Products:');
  await db.exec(
    `SELECT id, name, price FROM products WHERE category = 'Electronics' ORDER BY price DESC`,
    [],
    (row) => {
      console.log(`${row[0]}: ${row[1]} - $${row[2]}`);
    }
  );

  // Query 3: Aggregate function
  console.log('\nProduct Statistics:');
  await db.exec(
    `SELECT
      category,
      COUNT(*) as product_count,
      AVG(price) as avg_price,
      SUM(in_stock) as total_stock
    FROM products
    GROUP BY category
    ORDER BY product_count DESC`,
    [],
    (row) => {
      console.log(`${row[0]}: ${row[1]} products, Avg price: $${row[2].toFixed(2)}, Stock: ${row[3]} units`);
    }
  );

  // Updating data
  console.log('\nUpdating product prices...');
  await db.exec(`
    UPDATE products
    SET price = price * 0.9
    WHERE category = 'Electronics'
  `);

  console.log('After 10% discount on Electronics:');
  await db.exec(
    `SELECT id, name, price FROM products WHERE category = 'Electronics' ORDER BY id`,
    [],
    (row) => {
      console.log(`${row[0]}: ${row[1]} - $${row[2].toFixed(2)}`);
    }
  );

  // Using transactions
  console.log('\nPerforming transaction...');
  try {
    await db.exec('BEGIN TRANSACTION');

    // Delete a product
    await db.exec(`DELETE FROM products WHERE id = 7`);

    // Add a new product
    await db.exec(`
      INSERT INTO products (id, name, category, price, in_stock)
      VALUES (8, 'Wireless Mouse', 'Electronics', 29.99, 45)
    `);

    // Update stock
    await db.exec(`
      UPDATE products
      SET in_stock = in_stock - 5
      WHERE category = 'Electronics'
    `);

    await db.exec('COMMIT');
    console.log('Transaction completed successfully');
  } catch (error) {
    await db.exec('ROLLBACK');
    console.error('Transaction failed:', error);
  }

  // Final product list
  console.log('\nFinal Product List:');
  await db.exec(
    `SELECT id, name, category, price, in_stock FROM products ORDER BY category, id`,
    [],
    (row) => {
      console.log(`${row[0]}: ${row[1]} (${row[2]}) - $${row[3].toFixed(2)} - Stock: ${row[4]}`);
    }
  );

  // Demonstrate error handling
  console.log('\nDemonstrating error handling:');
  try {
    await db.exec(`
      INSERT INTO products (id, name, category, price)
      VALUES (1, 'Duplicate ID Product', 'Test', 19.99)
    `);
  } catch (error) {
    console.log(`Expected error caught: ${error.message}`);
  }

  // Clean up (optional in this case since it's all in-memory)
  console.log('\nCleaning up...');
  await db.exec('DROP TABLE products');
  console.log('Demo completed');
}

// Run the demo
runDemo().catch(error => {
  console.error('Demo failed with error:', error);
});
