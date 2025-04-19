import { Database } from '../../src/core/database';
import { Parser } from '../../src/parser/parser';
import { Compiler } from '../../src/compiler/compiler';
import { Opcode } from '../../src/common/constants';
import { MemoryTableModule } from '../../src/vtab/memory-table';
import { assert } from 'chai';

describe('SQL Compiler', () => {
  let parser: Parser;
  let compiler: Compiler;
  let db: Database;

  beforeEach(async () => {
    db = new Database();
    const memoryModule = new MemoryTableModule();
    db.registerVtabModule('memory', memoryModule);

    // Create a test table
    await db.exec(`
      CREATE VIRTUAL TABLE test_table USING memory(
        id INTEGER PRIMARY KEY,
        name TEXT,
        age INTEGER
      )
    `);

    parser = new Parser();
    compiler = new Compiler(db);
  });

  afterEach(async () => {
    await db.close();
  });

  describe('Basic compilation', () => {
    it('should compile a simple SELECT statement', () => {
      const ast = parser.parse('SELECT id, name FROM test_table');
      const program = compiler.compile(ast);

      // Check that program was generated
      assert.isTrue(program.instructions.length > 0);
      assert.isTrue(program.numMemCells > 0);
      assert.isTrue(program.numCursors > 0);

      // Check that the program starts with Init and ends with Halt
      assert.equal(program.instructions[0].opcode, Opcode.Init);
      assert.equal(program.instructions[program.instructions.length - 1].opcode, Opcode.Halt);

      // Check that we have column names
      assert.equal(program.columnNames.length, 2);
      assert.include(program.columnNames, 'id');
      assert.include(program.columnNames, 'name');

      // Check for essential instructions (VTable operations)
      const hasOpenRead = program.instructions.some(i => i.opcode === Opcode.OpenRead);
      const hasVFilter = program.instructions.some(i => i.opcode === Opcode.VFilter);
      const hasVColumn = program.instructions.some(i => i.opcode === Opcode.VColumn);
      const hasResultRow = program.instructions.some(i => i.opcode === Opcode.ResultRow);

      assert.isTrue(hasOpenRead, 'Missing OpenRead instruction');
      assert.isTrue(hasVFilter, 'Missing VFilter instruction');
      assert.isTrue(hasVColumn, 'Missing VColumn instruction');
      assert.isTrue(hasResultRow, 'Missing ResultRow instruction');
    });

    it('should compile a SELECT with WHERE clause', () => {
      const ast = parser.parse('SELECT name FROM test_table WHERE age > 30');
      const program = compiler.compile(ast);

      // Check for WHERE clause handling (comparison instructions)
      const hasComparison = program.instructions.some(i =>
        i.opcode === Opcode.Gt || i.opcode === Opcode.Lt ||
        i.opcode === Opcode.Ge || i.opcode === Opcode.Le ||
        i.opcode === Opcode.Eq || i.opcode === Opcode.Ne
      );

      assert.isTrue(hasComparison, 'Missing comparison instruction for WHERE clause');

      // Should have flow control for WHERE condition
      const hasIfTrue = program.instructions.some(i => i.opcode === Opcode.IfTrue);
      const hasIfFalse = program.instructions.some(i => i.opcode === Opcode.IfFalse);

      assert.isTrue(hasIfTrue || hasIfFalse, 'Missing conditional jump for WHERE clause');
    });

    it('should compile a query with parameters', () => {
      const ast = parser.parse('SELECT * FROM test_table WHERE age = ?');
      const program = compiler.compile(ast);

      // Should have parameter mapping
      assert.isTrue(program.parameters.size > 0, 'No parameters registered');

      // Parameter should map to a register
      const param = program.parameters.get(1);
      assert.exists(param);
      assert.isNumber(param?.memIdx);
    });
  });

  describe('Constants handling', () => {
    it('should store literals in constant pool', () => {
      const ast = parser.parse("SELECT * FROM test_table WHERE name = 'Test'");
      const program = compiler.compile(ast);

      // Should have at least one constant
      assert.isTrue(program.constants.length > 0, 'No constants in program');

      // Should have the string literal in constants
      const hasTestString = program.constants.some(c => c === 'Test');
      assert.isTrue(hasTestString, "String literal 'Test' not found in constants");
    });

    it('should handle different literal types', () => {
      const ast = parser.parse("SELECT * FROM test_table WHERE id = 1 AND name = 'Test' AND age = 30.5");
      const program = compiler.compile(ast);

      // Should have different types of constants
      const hasNumber = program.constants.some(c => typeof c === 'number');
      const hasString = program.constants.some(c => typeof c === 'string');

      assert.isTrue(hasNumber, 'No numeric constants found');
      assert.isTrue(hasString, 'No string constants found');
    });
  });

  describe('Error handling', () => {
    it('should handle invalid table references', () => {
      const ast = parser.parse('SELECT * FROM nonexistent_table');

      assert.throws(() => {
        compiler.compile(ast);
      }, /Table not found/);
    });
  });
});
