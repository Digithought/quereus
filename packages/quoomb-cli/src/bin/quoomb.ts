#!/usr/bin/env node

import { Command } from 'commander';
import { REPL } from '../repl.js';
import { Database } from '@quereus/quereus';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import Table from 'cli-table3';

const program = new Command();

program
  .name('quoomb')
  .description('Quoomb - Interactive REPL for Quereus SQL engine')
  .version('0.0.1')
  .option('-j, --json', 'output results as JSON instead of ASCII table')
  .option('-f, --file <path>', 'execute SQL from file and exit')
  .option('-c, --cmd <sql>', 'execute SQL command and exit')
  .option('--no-color', 'disable colored output')
  .action(async (options) => {
    try {
      if (options.file) {
        await executeFile(options.file, options);
      } else if (options.cmd) {
        await executeCommand(options.cmd, options);
      } else {
        console.log(chalk.blue('Welcome to Quoomb - Quereus SQL REPL'));
        console.log(chalk.gray('Type .help for available commands or enter SQL to execute'));
        console.log(chalk.gray('Use Ctrl+C or .exit to quit\n'));

        const repl = new REPL(options);
        await repl.start();
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

async function executeFile(filePath: string, options: any): Promise<void> {
  try {
    const sql = await fs.readFile(filePath, 'utf-8');
    await executeCommand(sql.trim(), options);
  } catch (error) {
    throw new Error(`Failed to read file '${filePath}': ${error instanceof Error ? error.message : error}`);
  }
}

async function executeCommand(sql: string, options: any): Promise<void> {
  const db = new Database();
  const startTime = Date.now();

  try {
    // Check if this is a query that returns results
    const trimmedSql = sql.trim().toLowerCase();
    if (trimmedSql.startsWith('select') || trimmedSql.startsWith('with')) {
      const results = [];
      for await (const row of db.eval(sql)) {
        results.push(row);
      }

      const endTime = Date.now();

      if (options.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        printTable(results, options);
      }

      if (options.color !== false) {
        console.error(chalk.gray(`${results.length} row(s) (${endTime - startTime}ms)`));
      } else {
        console.error(`${results.length} row(s) (${endTime - startTime}ms)`);
      }
    } else {
      // Execute statement without expecting results
      await db.exec(sql);
      const endTime = Date.now();

      if (options.color !== false) {
        console.error(chalk.green(`Query executed successfully (${endTime - startTime}ms)`));
      } else {
        console.error(`Query executed successfully (${endTime - startTime}ms)`);
      }
    }
  } catch (error) {
    const endTime = Date.now();
    if (options.color !== false) {
      console.error(chalk.red(`Query failed (${endTime - startTime}ms)`));
    } else {
      console.error(`Query failed (${endTime - startTime}ms)`);
    }
    throw error;
  } finally {
    await db.close();
  }
}

function printTable(results: any[], options: any): void {
  if (results.length === 0) {
    console.log(options.color !== false ? chalk.yellow('No rows returned') : 'No rows returned');
    return;
  }

  const columns = Object.keys(results[0]);
  const table = new Table({
    head: columns.map(col => options.color !== false ? chalk.cyan(col) : col),
    style: {
      head: options.color !== false ? ['cyan'] : []
    }
  });

  for (const row of results) {
    const values = columns.map(col => {
      const value = row[col];
      if (value === null) return options.color !== false ? chalk.gray('NULL') : 'NULL';
      if (typeof value === 'string') return value;
      return String(value);
    });
    table.push(values);
  }

  console.log(table.toString());
}

program.parse();
