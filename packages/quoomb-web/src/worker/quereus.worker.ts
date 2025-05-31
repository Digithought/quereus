import * as Comlink from 'comlink';
import { Database, type SqlValue } from '@quereus/quereus';
import type { QuereusWorkerAPI, TableInfo, ColumnInfo } from './types.js';
import Papa from 'papaparse';

class QuereusWorker implements QuereusWorkerAPI {
  private db: Database | null = null;

  async initialize(): Promise<void> {
    try {
      this.db = new Database();
      // Database is ready for use
    } catch (error) {
      throw new Error(`Failed to initialize Quereus database: ${error instanceof Error ? error.message : error}`);
    }
  }

  async executeQuery(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<Record<string, SqlValue>[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const results: Record<string, SqlValue>[] = [];

      for await (const row of this.db.eval(sql, params)) {
        results.push(row);
      }

      return results;
    } catch (error) {
      throw new Error(`Query execution failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async executeStatement(sql: string, params?: SqlValue[] | Record<string, SqlValue>): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      if (params) {
        const stmt = await this.db.prepare(sql);
        try {
          await stmt.run(params);
        } finally {
          await stmt.finalize();
        }
      } else {
        await this.db.exec(sql);
      }
    } catch (error) {
      throw new Error(`Statement execution failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async explainQuery(sql: string): Promise<any> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const explainSql = `EXPLAIN QUERY PLAN ${sql}`;
      const results: Record<string, SqlValue>[] = [];

      for await (const row of this.db.eval(explainSql)) {
        results.push(row);
      }

      return results;
    } catch (error) {
      throw new Error(`Query explanation failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async listTables(): Promise<Array<{ name: string; type: string }>> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      const results: Array<{ name: string; type: string }> = [];

      for await (const row of this.db.eval(`
        SELECT name, type FROM sqlite_schema
        WHERE type IN ('table', 'view')
        ORDER BY name
      `)) {
        results.push({
          name: row.name as string,
          type: row.type as string,
        });
      }

      return results;
    } catch (error) {
      throw new Error(`Failed to list tables: ${error instanceof Error ? error.message : error}`);
    }
  }

  async getTableSchema(tableName: string): Promise<TableInfo> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      // Get table definition
      const tableResults: Array<{ name: string; type: string; sql: string }> = [];
      for await (const row of this.db.eval(`
        SELECT name, type, sql FROM sqlite_schema
        WHERE name = ? AND sql IS NOT NULL
      `, [tableName])) {
        tableResults.push({
          name: row.name as string,
          type: row.type as string,
          sql: row.sql as string,
        });
      }

      if (tableResults.length === 0) {
        throw new Error(`Table '${tableName}' not found`);
      }

      const table = tableResults[0];

      // Get column information
      const columns: ColumnInfo[] = [];
      for await (const row of this.db.eval(`PRAGMA table_info(${tableName})`)) {
        columns.push({
          name: row.name as string,
          type: (row.type as string) || 'TEXT',
          nullable: !(row.notnull as boolean),
          defaultValue: row.dflt_value as SqlValue,
          primaryKey: row.pk as boolean,
        });
      }

      return {
        name: table.name,
        type: table.type as 'table' | 'view' | 'index',
        sql: table.sql,
        columns,
      };
    } catch (error) {
      throw new Error(`Failed to get table schema: ${error instanceof Error ? error.message : error}`);
    }
  }

  async importCsv(csvData: string, tableName: string): Promise<{ rowsImported: number }> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      // Parse CSV
      const parseResult = Papa.parse(csvData, {
        header: true,
        skipEmptyLines: true,
        transform: (value, field) => {
          // Try to convert numbers
          if (value === '') return null;
          const num = Number(value);
          if (!isNaN(num) && value === num.toString()) {
            return num;
          }
          return value;
        }
      });

      if (parseResult.errors.length > 0) {
        throw new Error(`CSV parsing errors: ${parseResult.errors.map(e => e.message).join(', ')}`);
      }

      if (parseResult.data.length === 0) {
        return { rowsImported: 0 };
      }

      // Sanitize table name
      const sanitizedTableName = tableName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^[0-9]/, '_$&');

      // Infer column types from data
      const firstRow = parseResult.data[0] as Record<string, any>;
      const columns = Object.keys(firstRow).map(col => {
        const sampleValues = parseResult.data.slice(0, 10).map(row => (row as any)[col]);
        const hasNumbers = sampleValues.some(val => typeof val === 'number');
        const hasStrings = sampleValues.some(val => typeof val === 'string' && val !== '');

        let type = 'TEXT';
        if (hasNumbers && !hasStrings) {
          type = 'REAL';
        } else if (hasNumbers) {
          type = 'TEXT'; // Mixed, so use TEXT
        }

        return `"${col}" ${type}`;
      });

      // Create table
      const createSql = `CREATE TABLE "${sanitizedTableName}" (${columns.join(', ')})`;
      await this.db.exec(createSql);

      // Insert data
      const columnNames = Object.keys(firstRow);
      const placeholders = columnNames.map(() => '?').join(', ');
      const insertSql = `INSERT INTO "${sanitizedTableName}" (${columnNames.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`;

      const stmt = await this.db.prepare(insertSql);
      let insertCount = 0;

      try {
        for (const row of parseResult.data) {
          const values = columnNames.map(col => (row as any)[col]);
          await stmt.run(values);
          insertCount++;
        }
      } finally {
        await stmt.finalize();
      }

      return { rowsImported: insertCount };
    } catch (error) {
      throw new Error(`CSV import failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.db.close();
      } catch (error) {
        console.warn('Error closing database:', error);
      }
      this.db = null;
    }
  }
}

// Expose the worker API via Comlink
const worker = new QuereusWorker();
Comlink.expose(worker);
