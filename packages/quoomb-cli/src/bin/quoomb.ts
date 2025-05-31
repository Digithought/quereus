#!/usr/bin/env node

import { Command } from 'commander';
import { REPL } from '../repl.js';
import chalk from 'chalk';

const program = new Command();

program
  .name('quoomb')
  .description('Quoomb - Interactive REPL for Quereus SQL engine')
  .version('0.0.1')
  .option('-j, --json', 'output results as JSON instead of ASCII table')
  .option('-f, --file <path>', 'execute SQL from file and exit')
  .option('--no-color', 'disable colored output')
  .action(async (options) => {
    try {
      if (options.file) {
        // TODO: Implement file execution mode
        console.error('File execution mode not yet implemented');
        process.exit(1);
      } else {
        console.log(chalk.blue('Welcome to Quoomb - Quereus SQL REPL'));
        console.log(chalk.gray('Type .help for available commands or enter SQL to execute'));
        console.log(chalk.gray('Use Ctrl+C or .exit to quit\n'));

        const repl = new REPL(options);
        await repl.start();
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error);
      process.exit(1);
    }
  });

program.parse();
