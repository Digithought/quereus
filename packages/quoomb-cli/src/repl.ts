import * as readline from 'readline';
import { Database, formatErrorChain, unwrapError } from '@quereus/quereus';
import chalk from 'chalk';
import Table from 'cli-table3';
import { DotCommands } from './commands/dot-commands.js';
import { handleDotCommand, loadEnabledPlugins } from './commands/dot-commands.js';

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
      prompt: this.getPrompt(),
      completer: this.completer.bind(this)
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
    console.log('🚀 Quoomb Interactive SQL Shell');
    console.log('Type .help for available commands, or enter SQL statements');
    console.log('');

    // Load enabled plugins at startup
    try {
      await loadEnabledPlugins(this.db);
    } catch (error) {
      console.log(`Warning: Error loading plugins: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    this.rl.prompt();

    this.rl.on('line', async (line: string) => {
      const trimmed = line.trim();

      if (!trimmed) {
        this.rl.prompt();
        return;
      }

      // Handle dot commands
      if (trimmed.startsWith('.')) {
        try {
          // Check if it's a plugin command first
          if (trimmed.startsWith('.plugin')) {
            await handleDotCommand(trimmed, this.db, this.rl);
          } else {
            // Use existing dot commands handler
            const handled = await this.dotCommands.handle(trimmed, this.rl);
            if (!handled) {
              console.log(`Unknown command: ${trimmed}`);
              console.log('Type .help for available commands');
            }
          }
        } catch (error) {
          this.printEnhancedError(error);
        }
        this.rl.prompt();
        return;
      }

      // Handle SQL
      try {
        const results = [];
        for await (const row of this.db.eval(trimmed)) {
          results.push(row);
        }

        if (results.length > 0) {
          console.table(results);
          console.log(`\n${results.length} row(s) returned\n`);
        } else {
          console.log('Query executed successfully\n');
        }
      } catch (error) {
        this.printEnhancedError(error);
      }

      this.rl.prompt();
    });

    this.rl.on('close', () => {
      console.log('\nGoodbye! 👋');
      this.db.close();
      process.exit(0);
    });
  }

  private completer(line: string): [string[], string] {
    const hits = [];

    // Dot command completion
    if (line.startsWith('.')) {
      const dotCommands = [
        '.help',
        '.tables',
        '.schema',
        '.dump',
        '.read',
        '.exit',
        '.plugin',
        '.plugin install',
        '.plugin list',
        '.plugin enable',
        '.plugin disable',
        '.plugin remove',
        '.plugin config',
        '.plugin reload'
      ];

      for (const cmd of dotCommands) {
        if (cmd.startsWith(line)) {
          hits.push(cmd);
        }
      }
    } else {
      // SQL keyword completion
      const sqlKeywords = [
        'SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE',
        'CREATE', 'DROP', 'ALTER', 'TABLE', 'INDEX', 'VIEW',
        'JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'ON',
        'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET',
        'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'EXISTS',
        'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'DISTINCT'
      ];

      const upperLine = line.toUpperCase();
      const lastWord = line.split(/\s+/).pop()?.toUpperCase() || '';

      for (const keyword of sqlKeywords) {
        if (keyword.startsWith(lastWord)) {
          hits.push(line.slice(0, -lastWord.length) + keyword);
        }
      }
    }

    return [hits, line];
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

  close(): void {
    this.rl.close();
  }

  private printEnhancedError(error: any): void {
    if (this.options.color) {
      console.error(chalk.red('━'.repeat(60)));
      console.error(chalk.red.bold('SQL ERROR'));
      console.error(chalk.red('━'.repeat(60)));
    } else {
      console.error('━'.repeat(60));
      console.error('SQL ERROR');
      console.error('━'.repeat(60));
    }

    if (error instanceof Error) {
      const errorChain = unwrapError(error);
      
      if (errorChain.length > 1) {
        // Multiple errors in chain - show formatted chain
        const formattedChain = formatErrorChain(errorChain, false);
        if (this.options.color) {
          // Colorize the error chain
          const colorized = formattedChain
            .replace(/^Error: (.*)$/gm, chalk.red.bold('Error: ') + chalk.red('$1'))
            .replace(/^Caused by: (.*)$/gm, chalk.yellow.bold('Caused by: ') + chalk.yellow('$1'))
            .replace(/\(at line (\d+), column (\d+)\)/g, chalk.cyan('(at line $1, column $2)'));
          console.error(colorized);
        } else {
          console.error(formattedChain);
        }
      } else {
        // Single error - use simpler format
        const errorInfo = errorChain[0];
        let message = errorInfo?.message || error.message;
        
        if (errorInfo?.line && errorInfo?.column) {
          message += ` (at line ${errorInfo.line}, column ${errorInfo.column})`;
        }
        
        if (this.options.color) {
          console.error(chalk.red(message));
        } else {
          console.error(message);
        }
      }
    } else {
      // Fallback for non-Error objects
      const message = typeof error === 'string' ? error : String(error);
      if (this.options.color) {
        console.error(chalk.red(message));
      } else {
        console.error(message);
      }
    }

    if (this.options.color) {
      console.error(chalk.red('━'.repeat(60)));
    } else {
      console.error('━'.repeat(60));
    }
    console.error('');
  }
}
