#!/usr/bin/env node

/**
 * Quereus PlanViz CLI - Visual query plan inspection tool
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { writeFileSync } from 'fs';
import process from 'process';
import { Database } from '@quereus/quereus';
import { InstructionProgram, PlanNode, PlanVisualizer } from './visualizer.js';

const program = new Command();

interface CliOptions {
	phase: 'logical' | 'physical' | 'emitted';
	format: 'tree' | 'json' | 'mermaid';
	output?: string;
	open?: boolean;
	verbose?: boolean;
}

program
	.name('quereus-planviz')
	.description('Visual query plan inspection tool for Quereus')
	.version('0.1.0');

program
	.argument('[file]', 'SQL file to analyze (or read from stdin)')
	.option('-p, --phase <phase>', 'Plan phase to show', 'physical')
	.option('-f, --format <format>', 'Output format', 'tree')
	.option('-o, --output <file>', 'Output file (default: stdout)')
	.option('--open', 'Open browser with Mermaid live view (when format=mermaid)')
	.option('-v, --verbose', 'Verbose output')
	.action(async (file: string | undefined, options: CliOptions) => {
		try {
			await planvizMain(file, options);
		} catch (error) {
			console.error(chalk.red('Error:'), error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	});

async function planvizMain(file: string | undefined, options: CliOptions): Promise<void> {
	// Validate options
	if (!['logical', 'physical', 'emitted'].includes(options.phase)) {
		throw new Error(`Invalid phase: ${options.phase}`);
	}
	if (!['tree', 'json', 'mermaid'].includes(options.format)) {
		throw new Error(`Invalid format: ${options.format}`);
	}

	// Read SQL input
	let sql: string;
	if (file) {
		if (options.verbose) {
			console.error(chalk.blue('Reading SQL from:'), file);
		}
		sql = readFileSync(file, 'utf-8');
	} else {
		if (options.verbose) {
			console.error(chalk.blue('Reading SQL from stdin...'));
		}
		sql = await readStdin();
	}

	sql = sql.trim();
	if (!sql) {
		throw new Error('No SQL input provided');
	}

	if (options.verbose) {
		console.error(chalk.blue('SQL:'), sql.length > 100 ? sql.substring(0, 100) + '...' : sql);
	}

	// Set up database with test schema
	const db = new Database();
	try {
		await setupTestSchema(db);

		// Analyze SQL and get plan
		const stmt = db.prepare(sql);
		let plan: PlanNode | InstructionProgram;

		switch (options.phase) {
			case 'logical':
				plan = stmt.compile();
				break;
			case 'physical':
				plan = stmt.compile(); // In current implementation, physical = logical
				break;
			case 'emitted':
				// Get the emitted instruction program as string
				const program = stmt.getDebugProgram();
				plan = { type: 'program', program };
				break;
		}

		// Generate visualization
		const visualizer = new PlanVisualizer();
		let output: string;

		switch (options.format) {
			case 'tree':
				output = visualizer.renderTree(plan, options.phase);
				break;
			case 'json':
				output = visualizer.renderJson(plan);
				break;
			case 'mermaid':
				output = visualizer.renderMermaid(plan, options.phase);
				break;
			default:
				throw new Error(`Unsupported format: ${options.format}`);
		}

		// Output result
		if (options.output) {
			writeFileSync(options.output, output);
			if (options.verbose) {
				console.error(chalk.green('Written to:'), options.output);
			}
		} else {
			console.log(output);
		}

		// Open browser if requested
		if (options.open && options.format === 'mermaid') {
			await openMermaidLive(output);
		}

	} finally {
		await db.close();
	}
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];

	return new Promise((resolve, reject) => {
		process.stdin.on('data', (chunk) => {
			chunks.push(chunk);
		});

		process.stdin.on('end', () => {
			resolve(Buffer.concat(chunks).toString('utf-8'));
		});

		process.stdin.on('error', reject);
	});
}

async function setupTestSchema(db: Database): Promise<void> {
	// Set up a standard test schema for plan visualization
	await db.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			age INTEGER,
			dept_id INTEGER
		) USING memory();

		CREATE TABLE departments (
			id INTEGER PRIMARY KEY,
			name TEXT NOT NULL,
			budget REAL
		) USING memory();

		CREATE TABLE orders (
			id INTEGER PRIMARY KEY,
			user_id INTEGER,
			amount REAL,
			order_date TEXT
		) USING memory();
	`);
}

async function openMermaidLive(mermaidCode: string): Promise<void> {
	// Encode the Mermaid code for the URL
	const encoded = Buffer.from(JSON.stringify({ code: mermaidCode, mermaid: {} })).toString('base64');
	const url = `https://mermaid.live/edit#base64:${encoded}`;

	console.error(chalk.yellow('Opening Mermaid Live Editor:'), url);

	// Try to open browser (platform-specific)
	const { spawn } = await import('child_process');

	const platform = process.platform;
	let command: string;
	let args: string[];

	switch (platform) {
		case 'darwin': // macOS
			command = 'open';
			args = [url];
			break;
		case 'win32': // Windows
			command = 'start';
			args = ['', url];
			break;
		default: // Linux and others
			command = 'xdg-open';
			args = [url];
			break;
	}

	try {
		spawn(command, args, { detached: true, stdio: 'ignore' });
	} catch (error) {
		console.error(chalk.yellow('Could not open browser automatically. Please visit:'), url);
	}
}

program.parse();
