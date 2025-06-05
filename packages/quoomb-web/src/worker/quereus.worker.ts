import * as Comlink from 'comlink';
import { Database, type SqlValue, dynamicLoadModule } from '@quereus/quereus';
import type { QuereusWorkerAPI, TableInfo, ColumnInfo, CsvPreview, PlanGraph, PlanGraphNode, PluginManifest } from './types.js';
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
      // Use Quereus's query_plan() function with parameterized query to avoid escaping issues
      console.log('Original SQL:', sql);

      const results: Record<string, SqlValue>[] = [];

      // Try using parameterized query instead of string interpolation
      for await (const row of this.db.eval('SELECT * FROM query_plan(?)', [sql])) {
        results.push(row);
      }

      return results;
    } catch (error) {
      console.error('Query plan error:', error);
      throw new Error(`Query explanation failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async explainProgram(sql: string): Promise<Record<string, SqlValue>[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      console.log('Explaining program for SQL:', sql);

      const results: Record<string, SqlValue>[] = [];

      // Use Quereus's scheduler_program() function
      for await (const row of this.db.eval('SELECT * FROM scheduler_program(?)', [sql])) {
        results.push(row);
      }

      return results;
    } catch (error) {
      console.error('Program explanation error:', error);
      throw new Error(`Program explanation failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async executionTrace(sql: string): Promise<Record<string, SqlValue>[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      console.log('Getting execution trace for SQL:', sql);

      const results: Record<string, SqlValue>[] = [];

      // Use Quereus's execution_trace() function to get detailed instruction-level trace
      for await (const row of this.db.eval('SELECT * FROM execution_trace(?)', [sql])) {
        results.push(row);
      }

      return results;
    } catch (error) {
      console.error('Execution trace error:', error);
      throw new Error(`Execution trace failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async rowTrace(sql: string): Promise<Record<string, SqlValue>[]> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      console.log('Getting row trace for SQL:', sql);

      const results: Record<string, SqlValue>[] = [];

      // Use Quereus's row_trace() function to get detailed row-level trace
      for await (const row of this.db.eval('SELECT * FROM row_trace(?)', [sql])) {
        results.push(row);
      }

      return results;
    } catch (error) {
      console.error('Row trace error:', error);
      throw new Error(`Row trace failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  async explainPlanGraph(sql: string, options?: { withActual?: boolean }): Promise<PlanGraph> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      console.log('Getting plan graph for SQL:', sql, 'withActual:', options?.withActual);

      // Get the base query plan
      const planResults: Record<string, SqlValue>[] = [];
      for await (const row of this.db.eval('SELECT * FROM query_plan(?)', [sql])) {
        planResults.push(row);
      }

      // Get actual execution data if requested
      let traceResults: Record<string, SqlValue>[] = [];
      if (options?.withActual) {
        try {
          // First execute the query to get actual timing data
          await this.db.eval(sql);

          // Then get execution trace
          for await (const row of this.db.eval('SELECT * FROM execution_trace(?)', [sql])) {
            traceResults.push(row);
          }
        } catch (error) {
          console.warn('Could not get actual execution data:', error);
          // Continue with estimated data only
        }
      }

      // Convert to graph structure
      return this.buildPlanGraph(planResults, traceResults, sql);
    } catch (error) {
      console.error('Plan graph error:', error);
      throw new Error(`Plan graph failed: ${error instanceof Error ? error.message : error}`);
    }
  }

  private buildPlanGraph(planRows: Record<string, SqlValue>[], traceRows: Record<string, SqlValue>[], originalSql: string): PlanGraph {
    // Build a simple linear plan structure from the plan data
    // This is a simplified version - real implementation would need to parse the actual plan structure
    const nodes: PlanGraphNode[] = [];
    let totalEstCost = 0;
    let totalEstRows = 0;
    let totalActTime = 0;

    // Create nodes from plan data
    planRows.forEach((row, index) => {
      const estCost = (row.est_cost as number) || 0;
      const estRows = (row.est_rows as number) || 0;

      totalEstCost += estCost;
      totalEstRows += estRows;

      // Use the proper fields from query_plan schema
      const op = (row.op as string) || 'UNKNOWN';
      const detail = (row.detail as string) || '';
      const objectName = (row.object_name as string) || null;
      const alias = (row.alias as string) || null;
      const nodeType = (row.node_type as string) || '';
      const subqueryLevel = (row.subquery_level as number) || 0;

      // Find corresponding trace data
      const traceRow = traceRows.find(trace =>
        (trace.step_id as number) === index + 1
      );

      const actTimeMs = traceRow ? (traceRow.duration_ms as number) : undefined;
      const actRows = traceRow ? (traceRow.rows_processed as number) : undefined;

      if (actTimeMs) totalActTime += actTimeMs;

      nodes.push({
        id: `node-${index}`,
        opcode: op, // Use the proper 'op' field
        estCost,
        estRows,
        actTimeMs,
        actRows,
        sqlSpan: undefined, // TODO: Extract from plan if available
        extra: {
          detail,
          objectName: objectName || undefined,
          alias: alias || undefined,
          nodeType,
          subqueryLevel,
          selectid: row.selectid,
          order: row.order
        },
        children: []
      });
    });

    // For now, create a simple linear tree (each node's child is the next node)
    // Real implementation would parse the actual tree structure from selectid/order
    for (let i = 0; i < nodes.length - 1; i++) {
      nodes[i].children = [nodes[i + 1]];
    }

    const root = nodes[0] || {
      id: 'root',
      opcode: 'EMPTY',
      estCost: 0,
      estRows: 0,
      children: []
    };

    return {
      root,
      totals: {
        estCost: totalEstCost,
        estRows: totalEstRows,
        actTimeMs: totalActTime > 0 ? totalActTime : undefined
      }
    };
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

  async previewCsv(csvData: string): Promise<CsvPreview> {
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

      // Filter out warnings that shouldn't block import
      const actualErrors = parseResult.errors.filter(error => {
        // Allow delimiter detection warnings to pass through
        if (error.message && error.message.includes('Unable to auto-detect delimiting character')) {
          return false;
        }
        // Allow other non-critical warnings
        if (error.type === 'Quotes' || error.type === 'Delimiter') {
          return false;
        }
        return true;
      });

      if (parseResult.data.length === 0) {
        return {
          columns: [],
          sampleRows: [],
          totalRows: 0,
          errors: actualErrors.map(e => e.message),
          inferredTypes: {}
        };
      }

      const firstRow = parseResult.data[0] as Record<string, any>;
      const originalColumns = Object.keys(firstRow);

      // Sanitize column names (same logic as import)
      const sanitizedColumns = originalColumns.map((col, index) => {
        let sanitizedCol = col.trim();
        if (!sanitizedCol) {
          sanitizedCol = `column_${index + 1}`;
        }
        sanitizedCol = sanitizedCol.replace(/[^a-zA-Z0-9_]/g, '_');
        if (/^[0-9]/.test(sanitizedCol)) {
          sanitizedCol = 'col_' + sanitizedCol;
        }
        // Ensure not empty after sanitization
        if (!sanitizedCol || sanitizedCol === '_'.repeat(sanitizedCol.length)) {
          sanitizedCol = `column_${index + 1}`;
        }
        return sanitizedCol;
      });

      // Infer column types from data (same logic as import)
      const inferredTypes: Record<string, string> = {};
      sanitizedColumns.forEach((sanitizedCol, index) => {
        const originalCol = originalColumns[index];
        const sampleValues = parseResult.data.slice(0, 10).map(row => (row as any)[originalCol]);
        const hasNumbers = sampleValues.some(val => typeof val === 'number');
        const hasStrings = sampleValues.some(val => typeof val === 'string' && val !== '');

        let type = 'TEXT';
        if (hasNumbers && !hasStrings) {
          type = 'REAL';
        }

        inferredTypes[sanitizedCol] = type;
      });

      // Create sample rows with sanitized column names
      const sampleRows = parseResult.data.slice(0, 5).map(row => {
        const sanitizedRow: Record<string, any> = {};
        originalColumns.forEach((originalCol, index) => {
          const sanitizedCol = sanitizedColumns[index];
          sanitizedRow[sanitizedCol] = (row as any)[originalCol];
        });
        return sanitizedRow;
      });

      return {
        columns: sanitizedColumns, // Return sanitized column names
        sampleRows,
        totalRows: parseResult.data.length,
        errors: actualErrors.map(e => e.message), // Only show actual errors
        inferredTypes
      };
    } catch (error) {
      throw new Error(`CSV preview failed: ${error instanceof Error ? error.message : error}`);
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

      // Filter out warnings that shouldn't block import
      const actualErrors = parseResult.errors.filter(error => {
        // Allow delimiter detection warnings to pass through
        if (error.message && error.message.includes('Unable to auto-detect delimiting character')) {
          return false;
        }
        // Allow other non-critical warnings
        if (error.type === 'Quotes' || error.type === 'Delimiter') {
          return false;
        }
        return true;
      });

      if (actualErrors.length > 0) {
        throw new Error(`CSV parsing errors: ${actualErrors.map(e => e.message).join(', ')}`);
      }

      if (parseResult.data.length === 0) {
        return { rowsImported: 0 };
      }

      // Better table name sanitization - ensure it's a valid SQL identifier
      let sanitizedTableName = tableName.trim();
      if (!sanitizedTableName) {
        sanitizedTableName = 'imported_table';
      }
      // Replace invalid characters with underscores
      sanitizedTableName = sanitizedTableName.replace(/[^a-zA-Z0-9_]/g, '_');
      // Ensure it doesn't start with a number
      if (/^[0-9]/.test(sanitizedTableName)) {
        sanitizedTableName = 'table_' + sanitizedTableName;
      }
      // Ensure it's not empty after sanitization
      if (!sanitizedTableName || sanitizedTableName === '_'.repeat(sanitizedTableName.length)) {
        sanitizedTableName = 'imported_table';
      }

      console.log('Sanitized table name:', sanitizedTableName);

      // Infer column types from data
      const firstRow = parseResult.data[0] as Record<string, any>;
      const columnNames = Object.keys(firstRow);

      if (columnNames.length === 0) {
        throw new Error('No columns found in CSV data');
      }

      // Sanitize column names and build column definitions
      const columnDefs = columnNames.map((col, index) => {
        // Sanitize column name
        let sanitizedCol = col.trim();
        if (!sanitizedCol) {
          sanitizedCol = `column_${index + 1}`;
        }
        sanitizedCol = sanitizedCol.replace(/[^a-zA-Z0-9_]/g, '_');
        if (/^[0-9]/.test(sanitizedCol)) {
          sanitizedCol = 'col_' + sanitizedCol;
        }
        // Ensure not empty after sanitization
        if (!sanitizedCol || sanitizedCol === '_'.repeat(sanitizedCol.length)) {
          sanitizedCol = `column_${index + 1}`;
        }

        // Infer type
        const sampleValues = parseResult.data.slice(0, 10).map(row => (row as any)[col]);
        const hasNumbers = sampleValues.some(val => typeof val === 'number');
        const hasStrings = sampleValues.some(val => typeof val === 'string' && val !== '');

        let type = 'TEXT';
        if (hasNumbers && !hasStrings) {
          type = 'REAL';
        }

        return `${sanitizedCol} ${type}`;
      });

      // Create table with proper SQL syntax - no quotes around column names in definition
      const createSql = `CREATE TABLE ${sanitizedTableName} (${columnDefs.join(', ')})`;
      console.log('CREATE TABLE SQL:', createSql);

      try {
        await this.db.exec(createSql);
      } catch (createError) {
        console.error('CREATE TABLE failed:', createError);
        throw new Error(`Failed to create table: ${createError instanceof Error ? createError.message : createError}`);
      }

      // Insert data with proper column mapping
      const sanitizedColumnNames = columnNames.map((col, index) => {
        let sanitizedCol = col.trim();
        if (!sanitizedCol) {
          sanitizedCol = `column_${index + 1}`;
        }
        sanitizedCol = sanitizedCol.replace(/[^a-zA-Z0-9_]/g, '_');
        if (/^[0-9]/.test(sanitizedCol)) {
          sanitizedCol = 'col_' + sanitizedCol;
        }
        if (!sanitizedCol || sanitizedCol === '_'.repeat(sanitizedCol.length)) {
          sanitizedCol = `column_${index + 1}`;
        }
        return sanitizedCol;
      });

      const placeholders = sanitizedColumnNames.map(() => '?').join(', ');
      const insertSql = `INSERT INTO ${sanitizedTableName} (${sanitizedColumnNames.join(', ')}) VALUES (${placeholders})`;
      console.log('INSERT SQL:', insertSql);

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

  async loadModule(url: string, config?: Record<string, SqlValue>): Promise<PluginManifest | undefined> {
    if (!this.db) {
      throw new Error('Database not initialized');
    }

    try {
      return await dynamicLoadModule(url, this.db, config ?? {});
    } catch (error) {
      console.error('Failed to load module:', error);
      throw error;
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
