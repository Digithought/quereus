#!/usr/bin/env node

/**
 * Quereus PlanViz CLI - Visual query plan inspection tool
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { readFileSync, writeFileSync } from 'fs';
import process from 'process';
import { Database } from '@quereus/quereus';
import { type InstructionProgram, type PlanNode, PlanVisualizer } from './visualizer.js';

const VALID_PHASES = ['logical', 'physical', 'emitted'] as const;
const VALID_FORMATS = ['tree', 'json', 'mermaid'] as const;

type Phase = typeof VALID_PHASES[number];
type Format = typeof VALID_FORMATS[number];

interface CliOptions {
	phase: Phase;
	format: Format;
	output?: string;
	open?: boolean;
	verbose?: boolean;
}

const cliProgram = new Command();

cliProgram
	.name('quereus-planviz')
	.description('Visual query plan inspection tool for Quereus')
	.version('0.1.0');

cliProgram
	.argument('[file]', 'SQL file to analyze (or read from stdin)')
	.option('-p, --phase <phase>', `Plan phase to show (${VALID_PHASES.join(', ')})`, 'physical')
	.option('-f, --format <format>', `Output format (${VALID_FORMATS.join(', ')})`, 'tree')
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
	if (!(VALID_PHASES as readonly string[]).includes(options.phase)) {
		throw new Error(`Invalid phase: ${options.phase}. Must be one of: ${VALID_PHASES.join(', ')}`);
	}
	if (!(VALID_FORMATS as readonly string[]).includes(options.format)) {
		throw new Error(`Invalid format: ${options.format}. Must be one of: ${VALID_FORMATS.join(', ')}`);
	}

	const sql = await readSqlInput(file, options.verbose);

	if (options.verbose) {
		console.error(chalk.blue('SQL:'), sql.length > 100 ? sql.substring(0, 100) + '...' : sql);
	}

	const db = new Database();
	try {
		await setupTestSchema(db);

		const plan = getPlan(db, sql, options.phase);

		const visualizer = new PlanVisualizer();
		const output = renderOutput(visualizer, plan, options);

		if (options.output) {
			writeFileSync(options.output, output);
			if (options.verbose) {
				console.error(chalk.green('Written to:'), options.output);
			}
		} else {
			console.log(output);
		}

		if (options.open && options.format === 'mermaid') {
			await openMermaidLive(output);
		}
	} finally {
		await db.close();
	}
}

async function readSqlInput(file: string | undefined, verbose?: boolean): Promise<string> {
	let sql: string;
	if (file) {
		if (verbose) console.error(chalk.blue('Reading SQL from:'), file);
		sql = readFileSync(file, 'utf-8');
	} else {
		if (verbose) console.error(chalk.blue('Reading SQL from stdin...'));
		sql = await readStdin();
	}

	sql = sql.trim();
	if (!sql) throw new Error('No SQL input provided');
	return sql;
}

function getPlan(db: Database, sql: string, phase: Phase): PlanNode | InstructionProgram {
	const stmt = db.prepare(sql);
	switch (phase) {
		case 'logical':
		case 'physical':
			// getDebugPlan returns serialized JSON; parse to get the PlanNode-shaped object
			return JSON.parse(stmt.getDebugPlan());
		case 'emitted':
			return { type: 'program', program: stmt.getDebugProgram() };
	}
}

function renderOutput(visualizer: PlanVisualizer, plan: PlanNode | InstructionProgram, options: CliOptions): string {
	switch (options.format) {
		case 'tree': return visualizer.renderTree(plan, options.phase);
		case 'json': return visualizer.renderJson(plan);
		case 'mermaid': return visualizer.renderMermaid(plan, options.phase);
	}
}

async function readStdin(): Promise<string> {
	const chunks: string[] = [];

	return new Promise((resolve, reject) => {
		process.stdin.setEncoding('utf-8');
		process.stdin.on('data', (chunk: string) => chunks.push(chunk));
		process.stdin.on('end', () => resolve(chunks.join('')));
		process.stdin.on('error', reject);
	});
}

async function setupTestSchema(db: Database): Promise<void> {
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
	const encoded = Buffer.from(JSON.stringify({ code: mermaidCode, mermaid: {} })).toString('base64');
	const url = `https://mermaid.live/edit#base64:${encoded}`;

	console.error(chalk.yellow('Opening Mermaid Live Editor:'), url);

	const { spawn } = await import('child_process');

	const platform = process.platform;
	let command: string;
	let args: string[];

	switch (platform) {
		case 'darwin':
			command = 'open';
			args = [url];
			break;
		case 'win32':
			command = 'cmd';
			args = ['/c', 'start', '', url];
			break;
		default:
			command = 'xdg-open';
			args = [url];
			break;
	}

	try {
		spawn(command, args, { detached: true, stdio: 'ignore' });
	} catch {
		console.error(chalk.yellow('Could not open browser automatically. Please visit:'), url);
	}
}

cliProgram.parse();
