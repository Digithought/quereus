import { Database } from '../src/core/database';
import { MemoryTableModule } from '../src/vtab/memory-table';
import { assert } from 'chai';

describe('MemoryTableModule', () => {
  let db: Database;
  let memoryModule: MemoryTableModule;

  beforeEach(() => {
    db = new Database();
    memoryModule = new MemoryTableModule();
    db.registerVtabModule('memory', memoryModule);
  });

  afterEach(async () => {
    // Clean up any tables that might have been created
    try {
      await db.exec('DROP TABLE IF EXISTS test_table');
      await db.exec('DROP TABLE IF EXISTS products');
    } catch (err) {
      // Ignore errors during cleanup
    }
  });

  describe('Table Creation', () => {
    it('should create a memory table with various column types', async () => {
      await db.exec(`
        CREATE VIRTUAL TABLE test_table USING memory(
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          price REAL,
          available INTEGER,
          created_at TEXT
        )
      `);

      // Query the schema to verify the table was created
      let tableExists = false;
      await db.exec(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='test_table'`,
        [],
        (row) => {
          tableExists = row[0] === 'test_table';
        }
      );

      assert.isTrue(tableExists, 'Table should exist after creation');
    });

    it('should enforce NOT NULL constraints', async () => {
      await db.exec(`
        CREATE VIRTUAL TABLE test_table USING memory(
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL
        )
      `);

      let errorCaught = false;
      try {
        await db.exec(`INSERT INTO test_table (id) VALUES (1)`);
      } catch (err) {
        errorCaught = true;
        assert.include(err.message.toLowerCase(), 'not null', 'Error should mention NOT NULL constraint');
      }

      assert.isTrue(errorCaught, 'Should throw error for NULL in NOT NULL column');
    });

    it('should enforce PRIMARY KEY constraints', async () => {
      await db.exec(`
        CREATE VIRTUAL TABLE test_table USING memory(
          id INTEGER PRIMARY KEY,
          name TEXT
        )
      `);

      await db.exec(`INSERT INTO test_table (id, name) VALUES (1, 'Test 1')`);

      let errorCaught = false;
      try {
        await db.exec(`INSERT INTO test_table (id, name) VALUES (1, 'Test 2')`);
      } catch (err) {
        errorCaught = true;
        assert.include(err.message.toLowerCase(), 'primary key', 'Error should mention PRIMARY KEY constraint');
      }

      assert.isTrue(errorCaught, 'Should throw error for duplicate PRIMARY KEY');
    });

    it('should apply DEFAULT values', async () => {
      await db.exec(`
        CREATE VIRTUAL TABLE test_table USING memory(
          id INTEGER PRIMARY KEY,
          name TEXT,
          status TEXT DEFAULT 'active',
          count INTEGER DEFAULT 0
        )
      `);

      await db.exec(`INSERT INTO test_table (id, name) VALUES (1, 'Test')`);

      let status: string;
      let count: number;

      await db.exec(
        `SELECT status, count FROM test_table WHERE id = 1`,
        [],
        (row) => {
          status = row[0];
          count = row[1];
        }
      );

      assert.equal(status, 'active', 'DEFAULT text value should be applied');
      assert.equal(count, 0, 'DEFAULT integer value should be applied');
    });
  });

  describe('Data Operations', () => {
    beforeEach(async () => {
      // Create a test table for data operations
      await db.exec(`
        CREATE VIRTUAL TABLE products USING memory(
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT,
          price REAL,
          in_stock INTEGER DEFAULT 0
        )
      `);
    });

    it('should insert and retrieve data correctly', async () => {
      await db.exec(`
        INSERT INTO products (id, name, category, price, in_stock) VALUES
        (1, 'Laptop', 'Electronics', 999.99, 10),
        (2, 'Headphones', 'Electronics', 149.99, 20)
      `);

      const products: any[] = [];
      await db.exec(
        `SELECT * FROM products ORDER BY id`,
        [],
        (row, columns) => {
          const product: Record<string, any> = {};
          columns.forEach((col, index) => {
            product[col] = row[index];
          });
          products.push(product);
        }
      );

      assert.equal(products.length, 2, 'Should retrieve 2 products');
      assert.equal(products[0].name, 'Laptop', 'First product should be Laptop');
      assert.equal(products[1].name, 'Headphones', 'Second product should be Headphones');
      assert.equal(products[0].price, 999.99, 'Price should be stored correctly');
      assert.equal(products[0].in_stock, 10, 'Stock should be stored correctly');
    });

    it('should update data correctly', async () => {
      await db.exec(`
        INSERT INTO products (id, name, category, price, in_stock) VALUES
        (1, 'Laptop', 'Electronics', 999.99, 10)
      `);

      await db.exec(`
        UPDATE products SET price = 899.99, in_stock = 15 WHERE id = 1
      `);

      let price: number;
      let stock: number;

      await db.exec(
        `SELECT price, in_stock FROM products WHERE id = 1`,
        [],
        (row) => {
          price = row[0];
          stock = row[1];
        }
      );

      assert.equal(price, 899.99, 'Price should be updated');
      assert.equal(stock, 15, 'Stock should be updated');
    });

    it('should delete data correctly', async () => {
      await db.exec(`
        INSERT INTO products (id, name, category, price, in_stock) VALUES
        (1, 'Laptop', 'Electronics', 999.99, 10),
        (2, 'Headphones', 'Electronics', 149.99, 20),
        (3, 'Keyboard', 'Electronics', 79.99, 30)
      `);

      await db.exec(`DELETE FROM products WHERE id = 2`);

      let count = 0;
      await db.exec(
        `SELECT COUNT(*) FROM products`,
        [],
        (row) => {
          count = row[0];
        }
      );

      assert.equal(count, 2, 'Should have 2 products after deletion');

      let hasHeadphones = false;
      await db.exec(
        `SELECT * FROM products WHERE name = 'Headphones'`,
        [],
        () => {
          hasHeadphones = true;
        }
      );

      assert.isFalse(hasHeadphones, 'Headphones should be deleted');
    });
  });

  describe('Query Capabilities', () => {
    beforeEach(async () => {
      // Create and populate a test table
      await db.exec(`
        CREATE VIRTUAL TABLE products USING memory(
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          category TEXT,
          price REAL,
          in_stock INTEGER DEFAULT 0
        )
      `);

      await db.exec(`
        INSERT INTO products (id, name, category, price, in_stock) VALUES
        (1, 'Laptop', 'Electronics', 999.99, 10),
        (2, 'Headphones', 'Electronics', 149.99, 20),
        (3, 'Keyboard', 'Electronics', 79.99, 30),
        (4, 'Monitor', 'Electronics', 299.99, 15),
        (5, 'Coffee Mug', 'Kitchen', 12.99, 100),
        (6, 'Water Bottle', 'Kitchen', 9.99, 75),
        (7, 'Backpack', 'Accessories', 59.99, 30)
      `);
    });

    it('should support WHERE clause filtering', async () => {
      let count = 0;
      await db.exec(
        `SELECT COUNT(*) FROM products WHERE category = 'Electronics'`,
        [],
        (row) => {
          count = row[0];
        }
      );

      assert.equal(count, 4, 'Should find 4 Electronics products');
    });

    it('should support ORDER BY clause', async () => {
      const productNames: string[] = [];
      await db.exec(
        `SELECT name FROM products ORDER BY price DESC`,
        [],
        (row) => {
          productNames.push(row[0]);
        }
      );

      assert.equal(productNames[0], 'Laptop', 'Most expensive item should be first');
      assert.equal(productNames[productNames.length - 1], 'Water Bottle', 'Least expensive item should be last');
    });

    it('should support LIMIT clause', async () => {
      const products: string[] = [];
      await db.exec(
        `SELECT name FROM products ORDER BY id LIMIT 3`,
        [],
        (row) => {
          products.push(row[0]);
        }
      );

      assert.equal(products.length, 3, 'Should return only 3 products');
      assert.deepEqual(products, ['Laptop', 'Headphones', 'Keyboard'], 'Should return first 3 products by ID');
    });

    it('should support GROUP BY and aggregate functions', async () => {
      const results: Array<{ category: string, count: number, avgPrice: number }> = [];
      await db.exec(
        `SELECT category, COUNT(*) as count, AVG(price) as avgPrice
         FROM products
         GROUP BY category
         ORDER BY count DESC`,
        [],
        (row) => {
          results.push({
            category: row[0],
            count: row[1],
            avgPrice: row[2]
          });
        }
      );

      assert.equal(results.length, 3, 'Should return 3 categories');
      assert.equal(results[0].category, 'Electronics', 'Electronics should have most products');
      assert.equal(results[0].count, 4, 'Electronics should have 4 products');
      assert.approximately(results[0].avgPrice, 382.49, 0.01, 'Average price should be calculated correctly');
    });
  });

  describe('Transaction Support', () => {
    beforeEach(async () => {
      await db.exec(`
        CREATE VIRTUAL TABLE test_table USING memory(
          id INTEGER PRIMARY KEY,
          value TEXT
        )
      `);
    });

    it('should support committing transactions', async () => {
      await db.exec('BEGIN TRANSACTION');
      await db.exec(`INSERT INTO test_table (id, value) VALUES (1, 'test1')`);
      await db.exec(`INSERT INTO test_table (id, value) VALUES (2, 'test2')`);
      await db.exec('COMMIT');

      let count = 0;
      await db.exec(
        `SELECT COUNT(*) FROM test_table`,
        [],
        (row) => {
          count = row[0];
        }
      );

      assert.equal(count, 2, 'Both records should be committed');
    });

    it('should support rolling back transactions', async () => {
      // Insert one record outside transaction
      await db.exec(`INSERT INTO test_table (id, value) VALUES (1, 'test1')`);

      // Start transaction
      await db.exec('BEGIN TRANSACTION');
      await db.exec(`INSERT INTO test_table (id, value) VALUES (2, 'test2')`);
      await db.exec(`INSERT INTO test_table (id, value) VALUES (3, 'test3')`);
      await db.exec('ROLLBACK');

      let count = 0;
      await db.exec(
        `SELECT COUNT(*) FROM test_table`,
        [],
        (row) => {
          count = row[0];
        }
      );

      assert.equal(count, 1, 'Only the record outside transaction should remain');
    });
  });

  describe('Error Handling', () => {
    beforeEach(async () => {
      await db.exec(`
        CREATE VIRTUAL TABLE test_table USING memory(
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          value INTEGER CHECK(value > 0)
        )
      `);
    });

    it('should handle syntax errors gracefully', async () => {
      let errorCaught = false;
      try {
        await db.exec(`SELCT * FROM test_table`); // Intentional typo
      } catch (err) {
        errorCaught = true;
        assert.include(err.message.toLowerCase(), 'syntax', 'Error should mention syntax');
      }

      assert.isTrue(errorCaught, 'Should catch syntax errors');
    });

    it('should handle constraint violations', async () => {
      let errorCaught = false;
      try {
        await db.exec(`INSERT INTO test_table (id, name, value) VALUES (1, 'test', -5)`);
      } catch (err) {
        errorCaught = true;
        assert.include(err.message.toLowerCase(), 'check', 'Error should mention CHECK constraint');
      }

      assert.isTrue(errorCaught, 'Should catch CHECK constraint violations');
    });

    it('should handle missing table errors', async () => {
      let errorCaught = false;
      try {
        await db.exec(`SELECT * FROM nonexistent_table`);
      } catch (err) {
        errorCaught = true;
        assert.include(err.message.toLowerCase(), 'table', 'Error should mention missing table');
      }

      assert.isTrue(errorCaught, 'Should catch missing table errors');
    });
  });

  describe('Module Registration', () => {
    it('should allow multiple memory table modules with different names', async () => {
      const memoryModule2 = new MemoryTableModule();
      db.registerVtabModule('mem2', memoryModule2);

      await db.exec(`
        CREATE VIRTUAL TABLE table1 USING memory(id INTEGER PRIMARY KEY, data TEXT)
      `);

      await db.exec(`
        CREATE VIRTUAL TABLE table2 USING mem2(id INTEGER PRIMARY KEY, data TEXT)
      `);

      await db.exec(`INSERT INTO table1 (id, data) VALUES (1, 'data1')`);
      await db.exec(`INSERT INTO table2 (id, data) VALUES (1, 'data2')`);

      let data1: string;
      let data2: string;

      await db.exec(
        `SELECT data FROM table1 WHERE id = 1`,
        [],
        (row) => {
          data1 = row[0];
        }
      );

      await db.exec(
        `SELECT data FROM table2 WHERE id = 1`,
        [],
        (row) => {
          data2 = row[0];
        }
      );

      assert.equal(data1, 'data1', 'Data in first table should be correct');
      assert.equal(data2, 'data2', 'Data in second table should be correct');

      // Clean up
      await db.exec('DROP TABLE table1');
      await db.exec('DROP TABLE table2');
    });

    it('should reject registering a module with an existing name', () => {
      const duplicateModule = new MemoryTableModule();

      let errorCaught = false;
      try {
        db.registerVtabModule('memory', duplicateModule);
      } catch (err) {
        errorCaught = true;
        assert.include(err.message.toLowerCase(), 'already registered', 'Error should mention already registered module');
      }

      assert.isTrue(errorCaught, 'Should reject duplicate module registration');
    });
  });
});
