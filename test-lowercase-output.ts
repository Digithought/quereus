import { parse } from './packages/quereus/src/parser/index.js';
import { astToString } from './packages/quereus/src/util/ast-stringify.js';

// Test cases to verify lowercase output
const testCases = [
    // Function names
    "SELECT COUNT(*), SUM(amount), MAX(id) FROM users",
    
    // Join types  
    "SELECT * FROM a INNER JOIN b ON a.id = b.id",
    "SELECT * FROM a LEFT JOIN b ON a.id = b.id",
    
    // Window functions with frame types
    "SELECT SUM(x) OVER (ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM t",
    "SELECT AVG(x) OVER (RANGE UNBOUNDED PRECEDING EXCLUDE CURRENT ROW) FROM t",
    
    // Order by with nulls
    "SELECT * FROM t ORDER BY x DESC NULLS FIRST, y ASC NULLS LAST",
    
    // Collate
    "SELECT * FROM t WHERE name COLLATE NOCASE = 'test'",
    "CREATE TABLE t (name TEXT COLLATE BINARY)",
    
    // Drop statements
    "DROP TABLE IF EXISTS users",
    "DROP VIEW myview",
    "DROP INDEX idx_name",
    
    // Transactions
    "BEGIN IMMEDIATE TRANSACTION",
    "BEGIN EXCLUSIVE",
    
    // Pragma
    "PRAGMA FOREIGN_KEYS = ON",
    
    // Table-valued functions in FROM
    "SELECT * FROM JSON_EACH(data)"
];

console.log("Testing lowercase SQL output...\n");

for (const sql of testCases) {
    try {
        console.log(`Input:  ${sql}`);
        const ast = parse(sql);
        const output = astToString(ast);
        console.log(`Output: ${output}`);
        console.log('---');
    } catch (error) {
        console.log(`Error parsing: ${error.message}`);
        console.log('---');
    }
}