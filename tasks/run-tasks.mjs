#!/usr/bin/env node
/**
 * Task Runner — processes outstanding tasks through the pipeline stages
 * by invoking an agentic CLI tool for each one.
 *
 * Key design choices:
 *   - The task list is snapshotted once at startup.  Tasks created by the agent
 *     during this run are NOT picked up, ensuring each task advances exactly one
 *     stage per invocation of the runner.
 *   - The agent owns the full stage transition: it creates next-stage file(s),
 *     deletes the source task file, and commits everything.  This allows the agent
 *     to split one task into multiple next-stage tasks, adjust priorities, etc.
 *   - Agent logs are captured in tasks/.logs/ (git-ignored), one per task per stage.
 *
 * Usage:
 *   node tasks/run-tasks.mjs [options]
 *
 * Options:
 *   --min-priority <n>   Only process tasks with priority >= n  (default: 3)
 *   --agent <name>       Agent adapter to use: auggie | cursor  (default: auggie)
 *   --dry-run            List tasks that would be processed, don't invoke agent
 *   --stages <list>      Comma-separated stages to process     (default: test,review,implement,plan,fix)
 *   --once               Process one task and exit
 *   --max <n>            Process at most n tasks then exit
 *   --help               Show this help
 */

import { readdir, readFile, access, mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';

// ─── Agent adapters ────────────────────────────────────────────────────────────
// Each adapter returns { cmd, args } for spawning the agent process.
// `instructionFile` is the path to a temp file containing the full prompt.

const agents = {
	auggie: (instructionFile) => ({
		cmd: 'auggie',
		args: ['--print', '--instruction', instructionFile],
	}),

	// Placeholder for Cursor CLI — adjust flags when the CLI ships.
	cursor: (instructionFile) => ({
		cmd: 'cursor',
		args: ['--agent', '--instruction', instructionFile],
	}),
};

// ─── Pipeline stage definitions ────────────────────────────────────────────────
// Forward order (how tasks flow through the pipeline).
// Processing order is REVERSED so we don't encounter our own output.

const STAGE_FORWARD = ['fix', 'plan', 'implement', 'review', 'test'];

/** Map from stage → next stage(s) in the pipeline (for prompt context). */
const NEXT_STAGE = {
	fix: 'implement',
	plan: 'implement',
	implement: 'review',
	review: 'complete',
	test: 'complete',
};

const TRANSITION_INSTRUCTIONS = [
	'You own the full stage transition.  When you are done:',
	'  1. Create the next-stage file(s) in the appropriate tasks/ subfolder.',
	'     You may split one task into multiple next-stage tasks if warranted.',
	'     You may keep or adjust the priority prefix as appropriate.',
	'  2. Delete the original source task file from its current stage folder.',
	'  3. Commit everything with a message like: "task(<stage>): <short description>"',
].join('\n');

const STAGE_INSTRUCTIONS = {
	fix: [
		'You are working a FIX task.  Research and elaborate the bug, forming one or more hypotheses about cause and correction.',
		'Create one or more implementation plans as md file(s) in tasks/implement/.',
		'Include references to key files and documentation.  Add detailed TODO items at the bottom of each new file.',
		TRANSITION_INSTRUCTIONS,
	].join('\n'),

	plan: [
		'You are working a PLAN task.  Research and elaborate on this feature/enhancement.',
		'Create one or more implementation plans as md file(s) in tasks/implement/.',
		'If there are open questions about different options, list the options in the output file.',
		'You may split a large plan into multiple focused implement tasks if the work is naturally separable.',
		'Include references to key files and documentation.  Add detailed TODO items at the bottom of each new file.',
		'After planning, you may proceed to implementation iif: * the plan is concrete; * you haven\'t followed many bunny trails (filling your context); * no unresolved design questions remain.',
		'If you proceed to implement, once complete write a distilled summary (emphasizing testing, validation, and usage) into tasks/review/.',
		TRANSITION_INSTRUCTIONS,
	].join('\n'),

	implement: [
		'You are working an IMPLEMENT task.  The planning is already done — implement the changes described.',
		'Write a distilled summary (emphasizing testing, validation, and usage) into tasks/review/.',
		TRANSITION_INSTRUCTIONS,
	].join('\n'),

	review: [
		'You are working a REVIEW task.',
		'First, ensure there are tests for the functionality.  Try to write tests from the interface without looking at implementation to avoid bias.',
		'Then inspect the code for quality (SPP, DRY, modular, etc.).  Be sure the appropriate architecture docs are up-to-date.  Add new followup tasks if needed.',
		'Write a summary md file in tasks/complete/.',
		TRANSITION_INSTRUCTIONS,
	].join('\n'),

	test: [
		'You are working a TEST task.  Execute the testing plan described.',
		'Run the relevant tests, document results, and fix any issues found.',
		'Write a summary md file in tasks/complete/.',
		TRANSITION_INSTRUCTIONS,
	].join('\n'),
};

// ─── Task discovery ────────────────────────────────────────────────────────────

/** Parse priority number from filename like "3-some-task.md" → 3. Returns 0 if unparseable. */
function parsePriority(filename) {
	const match = basename(filename).match(/^(\d+)-/);
	return match ? parseInt(match[1], 10) : 0;
}

/** Discover all .md task files in a stage folder, filtered by min priority. */
async function discoverTasks(tasksDir, stage, minPriority) {
	const stageDir = join(tasksDir, stage);
	try {
		await access(stageDir, constants.R_OK);
	} catch {
		return [];
	}

	const entries = await readdir(stageDir);
	const tasks = [];

	for (const entry of entries) {
		if (!entry.endsWith('.md')) continue;
		if (entry === 'agents.md') continue;

		const priority = parsePriority(entry);
		if (priority < minPriority) continue;

		tasks.push({
			file: entry,
			path: join(stageDir, entry),
			stage,
			priority,
		});
	}

	// Sort descending by priority (highest first)
	tasks.sort((a, b) => b.priority - a.priority);
	return tasks;
}

// ─── Logging ───────────────────────────────────────────────────────────────────
// Logs are kept in tasks/.logs/<task-name>.<stage>.<timestamp>.log
// so each stage of a task's lifecycle is preserved.

/** Return the .logs dir path, ensuring it exists. */
async function ensureLogsDir(tasksDir) {
	const logsDir = join(tasksDir, '.logs');
	await mkdir(logsDir, { recursive: true });
	return logsDir;
}

/** Build a log file path for a task run. */
function logPath(logsDir, task) {
	const name = task.file.replace(/\.md$/, '');
	const ts = new Date().toISOString().replace(/[:.]/g, '-');
	return join(logsDir, `${name}.${task.stage}.${ts}.log`);
}

// ─── Agent invocation ──────────────────────────────────────────────────────────

/** Build the full prompt for a task. */
async function buildPrompt(task) {
	const content = await readFile(task.path, 'utf-8');
	return [
		`# Task: ${task.file} (stage: ${task.stage}, priority: ${task.priority})`,
		`# Next stage: ${NEXT_STAGE[task.stage]}`,
		'',
		STAGE_INSTRUCTIONS[task.stage],
		'',
		'## Task File Contents',
		'',
		content,
		'',
		'Work the task as described above.  Follow the project conventions in AGENTS.md.',
	].join('\n');
}

/** Write prompt to a temp instruction file, spawn the agent, tee output to log. Returns exit code. */
async function runAgent(agentName, prompt, cwd, logFile) {
	const adapter = agents[agentName];
	if (!adapter) {
		console.error(`Unknown agent: ${agentName}. Available: ${Object.keys(agents).join(', ')}`);
		process.exit(1);
	}

	// Write prompt to a temp file so we don't hit command-line length limits
	const instructionFile = logFile.replace(/\.log$/, '.prompt.md');
	await writeFile(instructionFile, prompt, 'utf-8');

	const { cmd, args } = adapter(instructionFile);
	const logStream = createWriteStream(logFile, { flags: 'a' });

	try {
		return await new Promise((resolve, reject) => {
			const child = spawn(cmd, args, {
				cwd,
				stdio: ['ignore', 'pipe', 'pipe'],
				shell: true, // needed on Windows to resolve npm global .cmd shims
			});

			child.stdout.on('data', (chunk) => {
				process.stdout.write(chunk);
				logStream.write(chunk);
			});

			child.stderr.on('data', (chunk) => {
				process.stderr.write(chunk);
				logStream.write(chunk);
			});

			child.on('error', (err) => {
				logStream.end(`\n[runner] Agent spawn error: ${err.message}\n`);
				console.error(`Failed to spawn ${cmd}: ${err.message}`);
				reject(err);
			});

			child.on('close', (code) => {
				logStream.end(`\n[runner] Agent exited with code ${code}\n`);
				resolve(code ?? 1);
			});
		});
	} finally {
		// Clean up the temp instruction file
		await unlink(instructionFile).catch(() => {});
	}
}

// ─── CLI ───────────────────────────────────────────────────────────────────────

function printHelp() {
	const lines = [
		'Task Runner — process outstanding tasks via agentic CLI',
		'',
		'The task list is snapshotted once at startup — tasks created by the agent',
		'during this run are NOT picked up until the next run.  This ensures each',
		'task advances exactly one stage per run.',
		'',
		'Usage: node tasks/run-tasks.mjs [options]',
		'',
		'Options:',
		'  --min-priority <n>   Only tasks with priority >= n  (default: 3)',
		'  --agent <name>       auggie | cursor                (default: auggie)',
		'  --dry-run            List tasks without invoking agent',
		'  --stages <list>      Comma-separated stage filter   (default: fix,plan,implement,review,test)',
		'  --once               Process exactly one task',
		'  --max <n>            Process at most n tasks',
		'  --help               Show this help',
	];
	console.log(lines.join('\n'));
}

function parseArgs(argv) {
	const opts = {
		minPriority: 3,
		agent: 'auggie',
		dryRun: false,
		stages: null, // null = use default reversed order
		once: false,
		max: Infinity,
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case '--min-priority':
				opts.minPriority = parseInt(argv[++i], 10);
				break;
			case '--agent':
				opts.agent = argv[++i];
				break;
			case '--dry-run':
				opts.dryRun = true;
				break;
			case '--stages':
				opts.stages = argv[++i].split(',').map(s => s.trim());
				break;
			case '--once':
				opts.once = true;
				opts.max = 1;
				break;
			case '--max':
				opts.max = parseInt(argv[++i], 10);
				break;
			case '--help':
				printHelp();
				process.exit(0);
		}
	}

	if (!opts.stages) {
		opts.stages = [...STAGE_FORWARD];
	}

	return opts;
}

// ─── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
	const opts = parseArgs(process.argv.slice(2));

	// Resolve repo root (tasks/ is a direct child)
	const tasksDir = new URL('.', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
	const repoRoot = join(tasksDir, '..');

	// Snapshot the task list once — tasks created by the agent during this run
	// are NOT picked up, ensuring each task advances exactly one stage.
	let allTasks = [];
	for (const stage of opts.stages) {
		if (!STAGE_FORWARD.includes(stage)) {
			console.warn(`Skipping unknown stage: ${stage}`);
			continue;
		}
		const tasks = await discoverTasks(tasksDir, stage, opts.minPriority);
		allTasks.push(...tasks);
	}

	if (allTasks.length === 0) {
		console.log(`No tasks found with priority >= ${opts.minPriority} in stages: ${opts.stages.join(', ')}`);
		return;
	}

	// Sort: stage order first (as given in opts.stages), then priority descending
	const stageIndex = (stage) => {
		const idx = opts.stages.indexOf(stage);
		return idx >= 0 ? idx : 999;
	};
	allTasks.sort((a, b) => {
		const sa = stageIndex(a.stage);
		const sb = stageIndex(b.stage);
		if (sa !== sb) return sa - sb;
		return b.priority - a.priority;
	});

	// Apply --max / --once limit
	if (opts.max < allTasks.length) {
		allTasks = allTasks.slice(0, opts.max);
	}

	if (opts.dryRun) {
		console.log(`\nPending tasks (priority >= ${opts.minPriority}), processing order:\n`);
		for (const t of allTasks) {
			console.log(`  [${t.stage.padEnd(9)}] P${t.priority}  ${t.file}`);
		}
		console.log(`\n${allTasks.length} task(s) would be processed.`);
		return;
	}

	console.log(`\nSnapshotted ${allTasks.length} task(s) to process.\n`);
	const logsDir = await ensureLogsDir(tasksDir);

	for (let i = 0; i < allTasks.length; i++) {
		const task = allTasks[i];
		const currentLog = logPath(logsDir, task);

		const banner = [
			`${'═'.repeat(72)}`,
			`  [${i + 1}/${allTasks.length}] ${task.file}`,
			`  Stage: ${task.stage} → ${NEXT_STAGE[task.stage]}  |  Priority: ${task.priority}`,
			`  Log: ${currentLog}`,
			`${'═'.repeat(72)}`,
		].join('\n');
		console.log(banner);

		// Write header to log file
		await writeFile(currentLog, [
			`Task: ${task.file}`,
			`Stage: ${task.stage} → ${NEXT_STAGE[task.stage]}`,
			`Priority: ${task.priority}`,
			`Agent: ${opts.agent}`,
			`Started: ${new Date().toISOString()}`,
			'═'.repeat(72),
			'',
		].join('\n'));

		const prompt = await buildPrompt(task);
		const exitCode = await runAgent(opts.agent, prompt, repoRoot, currentLog);

		if (exitCode !== 0) {
			console.error(`\nAgent exited with code ${exitCode} on task: ${task.file}`);
			console.error(`Log: ${currentLog}`);
			console.error('Stopping to avoid cascading failures. Re-run to retry.');
			process.exit(exitCode);
		}

		console.log(`\n  [${i + 1}/${allTasks.length}] Complete: ${task.file}\n`);

		// Brief pause between tasks to let file system settle
		if (i < allTasks.length - 1) {
			await new Promise(r => setTimeout(r, 500));
		}
	}

	console.log(`\nDone — ${allTasks.length} task(s) processed.`);
}

main().catch((err) => {
	console.error('Task runner failed:', err);
	process.exit(1);
});
