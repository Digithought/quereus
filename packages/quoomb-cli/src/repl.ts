import * as readline from 'readline';
import { Database } from '@quereus/quereus';
import chalk from 'chalk';
import Table from 'cli-table3';
import { DotCommands } from './commands/dot-commands.js';

interface REPLOptions {
  json?: boolean;
  color?: boolean;
}

export class REPL {
  private db: Database;
  private rl: readline.Interface;
  private dotCommands: DotCommands;
  private options: REPLOptions;

  constructor(options: REPLOptions = {}) {
    this.options = { color: true, ...options };
    this.db = new Database();
    this.dotCommands = new DotCommands(this.db);

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.getPrompt()
    });

    this.setupSignalHandlers();
  }

  private getPrompt(): string {
    return this.options.color ? chalk.green('quoomb> ') : 'quoomb> ';
  }

  private setupSignalHandlers(): void {
    this.rl.on('SIGINT', () => {
      console.log('\nReceived SIGINT. Use .exit to quit.');
      this.rl.prompt();
    });
  }

  async start(): Promise<void> {
    this.rl.prompt();

    this.rl.on('line', async (line) => {
      const trimmed = line.trim();

      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      try {
        if (trimmed.startsWith('.')) {
          await this.handleDotCommand(trimmed);
        } else {
          await this.handleSQL(trimmed);
        }
      } catch (error) {
        this.printError(error);
      }

      this.rl.prompt();
    });

    this.rl.on('close', async () => {
      console.log('\nGoodbye!');
      await this.cleanup();
      process.exit(0);
    });
  }

  private async handleDotCommand(command: string): Promise<void> {
    const parts = command.slice(1).split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);

    switch (cmd) {
      case 'help':
        this.printHelp();
        break;
      case 'exit':
      case 'quit':
        this.rl.close();
        break;
      case 'tables':
        await this.dotCommands.listTables();
        break;
      case 'schema':
        await this.dotCommands.showSchema(args[0]);
        break;
      case 'import':
        await this.dotCommands.importCsv(args[0]);
        break;
      case 'export':
        await this.dotCommands.exportQuery(args[0], args[1]);
        break;
      default:
        console.log(chalk.red(`Unknown command: .${cmd}`));
        console.log('Type .help for available commands');
    }
  }

  private async handleSQL(sql: string): Promise<void> {
    const startTime = Date.now();

    try {
      // Check if this is a query that returns results
      const trimmedSql = sql.trim().toLowerCase();
      if (trimmedSql.startsWith('select') || trimmedSql.startsWith('with')) {
        const results = [];
        for await (const row of this.db.eval(sql)) {
          results.push(row);
        }

        const endTime = Date.now();
        this.printResults(results, endTime - startTime);
      } else {
        // Execute statement without expecting results
        await this.db.exec(sql);
        const endTime = Date.now();
        console.log(chalk.green(`✓ Query executed successfully (${endTime - startTime}ms)`));
      }
    } catch (error) {
      const endTime = Date.now();
      console.log(chalk.red(`✗ Query failed (${endTime - startTime}ms)`));
      throw error;
    }
  }

  private printResults(results: any[], executionTime: number): void {
    if (results.length === 0) {
      console.log(chalk.yellow('No rows returned'));
      return;
    }

    if (this.options.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      this.printTable(results);
    }

    console.log(chalk.gray(`\n${results.length} row(s) (${executionTime}ms)`));
  }

  private printTable(results: any[]): void {
    if (results.length === 0) return;

    const columns = Object.keys(results[0]);
    const table = new Table({
      head: columns.map(col => this.options.color ? chalk.cyan(col) : col),
      style: {
        head: this.options.color ? ['cyan'] : []
      }
    });

    for (const row of results) {
      const values = columns.map(col => {
        const value = row[col];
        if (value === null) return this.options.color ? chalk.gray('NULL') : 'NULL';
        if (typeof value === 'string') return value;
        return String(value);
      });
      table.push(values);
    }

    console.log(table.toString());
  }

  private printError(error: any): void {
    if (this.options.color) {
      console.error(chalk.red('Error:'), error.message || error);
    } else {
      console.error('Error:', error.message || error);
    }
  }

  private printHelp(): void {
    const help = `
Available commands:
  .help                    Show this help message
  .exit, .quit             Exit the REPL
  .tables                  List all tables
  .schema [table]          Show table schema
  .import <file.csv>       Import CSV file as table
  .export <sql> <file>     Export query results to file

SQL commands:
  Enter any SQL statement to execute it

Examples:
  CREATE TABLE users (id INTEGER, name TEXT);
  INSERT INTO users VALUES (1, 'Alice');
  SELECT * FROM users;
  .import data.csv
  .export "SELECT * FROM users" output.json
`;
    console.log(this.options.color ? chalk.yellow(help) : help);
  }

  private async cleanup(): Promise<void> {
    try {
      await this.db.close();
    } catch (error) {
      // Ignore cleanup errors
    }
  }
}
