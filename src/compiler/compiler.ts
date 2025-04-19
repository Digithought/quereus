/**
 * SQL Compiler for SQLiter
 *
 * Translates SQL AST into VDBE instructions
 */

import { StatusCode, type SqlValue, SqlDataType } from '../common/types';
import { SqliteError } from '../common/errors';
import { Opcode } from '../common/constants';
import { createInstruction, type VdbeInstruction, type P4Vtab } from '../vdbe/instruction';
import type { VdbeProgram } from '../vdbe/program';
import type { Database } from '../core/database';
import type { SchemaManager } from '../schema/manager';
import type { TableSchema } from '../schema/table';
import * as AST from '../parser/ast';

/**
 * Compiler class translating SQL AST nodes to VDBE programs
 */
export class Compiler {
  private db: Database;
  private sql: string = '';
  private constants: SqlValue[] = [];
  private instructions: VdbeInstruction[] = [];
  private numMemCells = 0;
  private numCursors = 0;
  private parameters: Map<number | string, { memIdx: number }> = new Map();
  private columnAliases: string[] = [];
  private tableSchemas: Map<number, TableSchema> = new Map();
  private resultColumns: { name: string, table?: string, expr?: AST.Expression }[] = [];

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Compile an AST node into a VDBE program
   */
  compile(ast: AST.AstNode, sql: string): VdbeProgram {
    // Reset state
    this.sql = sql;
    this.constants = [];
    this.instructions = [];
    this.numMemCells = 0;
    this.numCursors = 0;
    this.parameters = new Map();
    this.columnAliases = [];
    this.tableSchemas = new Map();
    this.resultColumns = [];

    // Add initial Init instruction
    this.emit(Opcode.Init, 0, 0, 0, null, 0, "Start of program");

    // Compile by node type
    switch (ast.type) {
      case 'select':
        this.compileSelect(ast as AST.SelectStmt);
        break;
      default:
        throw new SqliteError(`Unsupported statement type: ${ast.type}`, StatusCode.ERROR);
    }

    // End program with Halt
    this.emit(Opcode.Halt, StatusCode.OK, 0, 0, null, 0, "End of program");

    // Create program
    return {
      instructions: this.instructions,
      constants: this.constants,
      numMemCells: this.numMemCells,
      numCursors: this.numCursors,
      parameters: this.parameters,
      columnNames: this.columnAliases,
      sql: this.sql
    };
  }

  /**
   * Compile a SELECT statement
   */
  private compileSelect(stmt: AST.SelectStmt): void {
    // Allocate memory cells for result columns
    const resultBase = this.allocateMemoryCells(stmt.columns.length);

    // Process FROM clause first to set up cursors
    if (stmt.from && stmt.from.length > 0) {
      this.compileFrom(stmt.from);
    }

    // Process WHERE clause
    if (stmt.where) {
      this.compileWhere(stmt.where);
    }

    // Generate column expressions
    let colIdx = 0;
    for (const column of stmt.columns) {
      if (column.type === 'all') {
        // Expand * to all columns from tables
        // For simplicity in this implementation, we'll treat * as a special case
        // In a full implementation, you'd enumerate all columns from all tables
        this.emit(Opcode.Null, 0, resultBase + colIdx, 0, null, 0, "Wildcard column (simplified)");

        // In a real implementation, we'd expand this to multiple columns
        this.resultColumns.push({ name: '*', table: column.table });
        this.columnAliases.push(column.table ? `${column.table}.*` : '*');
        colIdx++;
      } else if (column.expr) {
        // Regular column expression
        const targetReg = resultBase + colIdx;
        this.compileExpression(column.expr, targetReg);

        // Track column name/alias for result set
        let colName = '';

        if (column.alias) {
          colName = column.alias;
        } else if (column.expr.type === 'column') {
          colName = column.expr.name;
        } else {
          colName = `col${colIdx + 1}`;
        }

        this.columnAliases.push(colName);
        this.resultColumns.push({
          name: colName,
          expr: column.expr
        });

        colIdx++;
      }
    }

    // Generate ResultRow instruction
    this.emit(
      Opcode.ResultRow,
      resultBase,
      stmt.columns.length,
      0,
      null,
      0,
      "Output result row"
    );
  }

  /**
   * Compile the FROM clause
   */
  private compileFrom(sources: AST.FromClause[]): void {
    // For simple implementation, just handle the first table source
    if (sources.length > 0) {
      const source = sources[0];

      if (source.type === 'table') {
        const cursor = this.allocateCursor();
        const tableName = source.table.name;
        const schemaName = source.table.schema || 'main';

        // Look up table schema
        const tableSchema = this.db._findTable(tableName, schemaName);
        if (!tableSchema) {
          throw new SqliteError(`Table not found: ${schemaName}.${tableName}`, StatusCode.ERROR);
        }

        this.tableSchemas.set(cursor, tableSchema);

        // Open a cursor to the table
        if (tableSchema.isVirtual && tableSchema.vtabInstance) {
          // For virtual table
          this.emit(
            Opcode.OpenRead,
            cursor,
            0,  // db index (0 for main)
            0,
            tableSchema, // P4 contains table schema
            0,
            `Open virtual table ${schemaName}.${tableName}`
          );

          // Immediately run VFilter with empty args to start scanning
          this.emit(
            Opcode.VFilter,
            cursor,
            this.instructions.length + 2, // Jump to next instruction after if no rows
            0, // No filter args for now
            { idxNum: 0, idxStr: null, nArgs: 0 },
            0,
            `Initial scan of ${tableName}`
          );
        } else {
          // For regular table (not implemented in this simplified version)
          throw new SqliteError("Regular tables not implemented - only virtual tables supported", StatusCode.ERROR);
        }
      } else {
        throw new SqliteError("JOIN not implemented in this simplified version", StatusCode.ERROR);
      }
    }
  }

  /**
   * Compile the WHERE clause
   */
  private compileWhere(expr: AST.Expression): void {
    // In a simplified implementation, we'll just handle basic WHERE clauses
    // by evaluating the expression into a register and checking if true
    const whereReg = this.allocateMemoryCells(1);
    this.compileExpression(expr, whereReg);

    // Test if the where condition is false
    const endAddr = this.instructions.length + 2;
    this.emit(
      Opcode.IfFalse,
      whereReg,
      endAddr, // Jump to VNext
      0,
      null,
      0,
      "Skip row if WHERE clause is false"
    );
  }

  /**
   * Compile a cursor loop for scanning a virtual table
   */
  private compileCursorLoop(cursor: number, bodyStartAddr: number): void {
    // VNext advances to next row
    this.emit(
      Opcode.VNext,
      cursor,
      this.instructions.length + 2, // Address to jump if at EOF
      0,
      null,
      0,
      "Advance to next row"
    );

    // If we have more rows, go back to body start
    this.emit(
      Opcode.Goto,
      0,
      bodyStartAddr,
      0,
      null,
      0,
      "Loop back for next row"
    );
  }

  /**
   * Compile an expression
   */
  private compileExpression(expr: AST.Expression, targetReg: number): void {
    switch (expr.type) {
      case 'literal':
        this.compileLiteral(expr, targetReg);
        break;
      case 'column':
        this.compileColumn(expr, targetReg);
        break;
      case 'binary':
        this.compileBinary(expr, targetReg);
        break;
      case 'function':
        this.compileFunction(expr, targetReg);
        break;
      case 'parameter':
        this.compileParameter(expr, targetReg);
        break;
      default:
        throw new SqliteError(`Unsupported expression type: ${(expr as any).type}`, StatusCode.ERROR);
    }
  }

  /**
   * Compile a literal expression
   */
  private compileLiteral(expr: AST.LiteralExpr, targetReg: number): void {
    const value = expr.value;

    // Handle by value type
    if (value === null) {
      this.emit(Opcode.Null, 0, targetReg, 0, null, 0, "NULL literal");
    } else if (typeof value === 'number') {
      if (Number.isInteger(value) && value >= -32768 && value <= 32767) {
        // Small integer, use direct value
        this.emit(Opcode.Integer, value, targetReg, 0, null, 0, `Integer literal: ${value}`);
      } else if (Number.isInteger(value)) {
        // Larger integer, use constant pool
        const constIdx = this.addConstant(value);
        this.emit(Opcode.Int64, 0, targetReg, 0, constIdx, 0, `Integer literal: ${value}`);
      } else {
        // Float
        const constIdx = this.addConstant(value);
        this.emit(Opcode.Real, 0, targetReg, 0, constIdx, 0, `Float literal: ${value}`);
      }
    } else if (typeof value === 'string') {
      const constIdx = this.addConstant(value);
      this.emit(Opcode.String8, 0, targetReg, 0, constIdx, 0, `String literal: '${value}'`);
    } else if (typeof value === 'bigint') {
      const constIdx = this.addConstant(value);
      this.emit(Opcode.Int64, 0, targetReg, 0, constIdx, 0, `BigInt literal: ${value}`);
    } else if (value instanceof Uint8Array) {
      const constIdx = this.addConstant(value);
      this.emit(Opcode.Blob, value.length, targetReg, 0, constIdx, 0, "BLOB literal");
    } else {
      throw new SqliteError(`Unsupported literal type: ${typeof value}`, StatusCode.ERROR);
    }
  }

  /**
   * Compile a column reference
   */
  private compileColumn(expr: AST.ColumnExpr, targetReg: number): void {
    // Find the cursor and column index
    let cursor = -1;
    let colIdx = -1;

    // In a real implementation, we'd scan all tables and match table/column
    // Here we'll just use the first cursor and look for a column by name
    cursor = 0; // Use first cursor

    const tableSchema = this.tableSchemas.get(cursor);
    if (!tableSchema) {
      throw new SqliteError(`No table found for column: ${expr.name}`, StatusCode.ERROR);
    }

    // Find column index in the table schema
    colIdx = tableSchema.columns.findIndex(col => col.name === expr.name);
    if (colIdx === -1) {
      throw new SqliteError(`Column not found: ${expr.name}`, StatusCode.ERROR);
    }

    // For virtual tables, use VColumn
    if (tableSchema.isVirtual) {
      this.emit(
        Opcode.VColumn,
        cursor,
        colIdx,
        targetReg,
        null,
        0,
        `Get column: ${expr.name}`
      );
    } else {
      // For normal tables (not implemented)
      throw new SqliteError("Regular tables not implemented - only virtual tables supported", StatusCode.ERROR);
    }
  }

  /**
   * Compile a binary expression
   */
  private compileBinary(expr: AST.BinaryExpr, targetReg: number): void {
    // Allocate registers for left and right operands
    const leftReg = this.allocateMemoryCells(1);
    const rightReg = this.allocateMemoryCells(1);

    // Compile operands
    this.compileExpression(expr.left, leftReg);
    this.compileExpression(expr.right, rightReg);

    // Generate operation based on operator
    switch (expr.operator.toUpperCase()) {
      case '+':
        this.emit(Opcode.Add, leftReg, rightReg, targetReg, null, 0, "Add");
        break;
      case '-':
        this.emit(Opcode.Subtract, leftReg, rightReg, targetReg, null, 0, "Subtract");
        break;
      case '*':
        this.emit(Opcode.Multiply, leftReg, rightReg, targetReg, null, 0, "Multiply");
        break;
      case '/':
        this.emit(Opcode.Divide, leftReg, rightReg, targetReg, null, 0, "Divide");
        break;
      case 'AND':
        // Evaluate left operand first
        this.emit(Opcode.SCopy, leftReg, targetReg, 0, null, 0, "Copy left operand");

        // If left is false, short-circuit, otherwise evaluate right
        const endAddr = this.instructions.length + 5;
        this.emit(Opcode.IfFalse, targetReg, endAddr, 0, null, 0, "Short-circuit AND if left is false");

        // Evaluate right operand into result
        this.emit(Opcode.SCopy, rightReg, targetReg, 0, null, 0, "Evaluate right operand");
        break;

      case 'OR':
        // Evaluate left operand first
        this.emit(Opcode.SCopy, leftReg, targetReg, 0, null, 0, "Copy left operand");

        // If left is true, short-circuit, otherwise evaluate right
        const endOrAddr = this.instructions.length + 5;
        this.emit(Opcode.IfTrue, targetReg, endOrAddr, 0, null, 0, "Short-circuit OR if left is true");

        // Evaluate right operand into result
        this.emit(Opcode.SCopy, rightReg, targetReg, 0, null, 0, "Evaluate right operand");
        break;

      case '=':
      case '==':
        // Compare values and set result register to 1 or 0
        this.emit(Opcode.Eq, leftReg, this.instructions.length + 3, rightReg, null, 0, "Equal comparison");
        this.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "Set false result");
        this.emit(Opcode.Goto, 0, this.instructions.length + 2, 0, null, 0, "Skip true block");
        this.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "Set true result");
        break;

      case '!=':
      case '<>':
        // Compare values and set result register to 1 or 0
        this.emit(Opcode.Ne, leftReg, this.instructions.length + 3, rightReg, null, 0, "Not equal comparison");
        this.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "Set false result");
        this.emit(Opcode.Goto, 0, this.instructions.length + 2, 0, null, 0, "Skip true block");
        this.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "Set true result");
        break;

      case '<':
        this.emit(Opcode.Lt, leftReg, this.instructions.length + 3, rightReg, null, 0, "Less than comparison");
        this.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "Set false result");
        this.emit(Opcode.Goto, 0, this.instructions.length + 2, 0, null, 0, "Skip true block");
        this.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "Set true result");
        break;

      case '<=':
        this.emit(Opcode.Le, leftReg, this.instructions.length + 3, rightReg, null, 0, "Less than or equal comparison");
        this.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "Set false result");
        this.emit(Opcode.Goto, 0, this.instructions.length + 2, 0, null, 0, "Skip true block");
        this.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "Set true result");
        break;

      case '>':
        this.emit(Opcode.Gt, leftReg, this.instructions.length + 3, rightReg, null, 0, "Greater than comparison");
        this.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "Set false result");
        this.emit(Opcode.Goto, 0, this.instructions.length + 2, 0, null, 0, "Skip true block");
        this.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "Set true result");
        break;

      case '>=':
        this.emit(Opcode.Ge, leftReg, this.instructions.length + 3, rightReg, null, 0, "Greater than or equal comparison");
        this.emit(Opcode.Integer, 0, targetReg, 0, null, 0, "Set false result");
        this.emit(Opcode.Goto, 0, this.instructions.length + 2, 0, null, 0, "Skip true block");
        this.emit(Opcode.Integer, 1, targetReg, 0, null, 0, "Set true result");
        break;

      default:
        throw new SqliteError(`Unsupported binary operator: ${expr.operator}`, StatusCode.ERROR);
    }
  }

  /**
   * Compile a function call
   */
  private compileFunction(expr: AST.FunctionExpr, targetReg: number): void {
    // Allocate registers for arguments
    const argRegs = this.allocateMemoryCells(expr.args.length);

    // Compile each argument
    for (let i = 0; i < expr.args.length; i++) {
      this.compileExpression(expr.args[i], argRegs + i);
    }

    // Look up function definition
    const funcDef = this.db._findFunction(expr.name, expr.args.length);
    if (!funcDef) {
      throw new SqliteError(`Function not found: ${expr.name}/${expr.args.length}`, StatusCode.ERROR);
    }

    // Generate function call
    this.emit(
      Opcode.Function,
      0,
      argRegs,
      targetReg,
      { type: 'funcdef', funcDef, nArgs: expr.args.length },
      0,
      `Call function: ${expr.name}`
    );
  }

  /**
   * Compile a parameter reference
   */
  private compileParameter(expr: AST.ParameterExpr, targetReg: number): void {
    // Register this parameter for binding
    const key = expr.name || expr.index!;
    this.parameters.set(key, { memIdx: targetReg });

    // We'll leave the register empty, it will be filled by bound params at runtime
    this.emit(Opcode.Null, 0, targetReg, 0, null, 0, `Parameter placeholder: ${key}`);
  }

  /**
   * Allocate memory cells
   */
  private allocateMemoryCells(count: number): number {
    const base = this.numMemCells;
    this.numMemCells += count;
    return base;
  }

  /**
   * Allocate a cursor
   */
  private allocateCursor(): number {
    return this.numCursors++;
  }

  /**
   * Add a constant to the constant pool
   */
  private addConstant(value: SqlValue): number {
    const idx = this.constants.length;
    this.constants.push(value);
    return idx;
  }

  /**
   * Emit a VDBE instruction
   */
  private emit(
    opcode: Opcode,
    p1: number = 0,
    p2: number = 0,
    p3: number = 0,
    p4: any = null,
    p5: number = 0,
    comment?: string
  ): number {
    const idx = this.instructions.length;
    this.instructions.push(createInstruction(opcode, p1, p2, p3, p4, p5, comment));
    return idx;
  }
}
