## General

- Use lowercase SQL reserved words (e.g., `select * from Table`)
- Don't use inline `import()` unless dynamically loading
- Don't create summary documents; update existing documentation
- Stay DRY.
- No lengthy summaries
- Don't worry about backwards compatibility yet.
- Use yarn
- No half-baked janky parsers; use a full-fledged parser or better, brainstorm with the dev for another way
- .editorconfig contains formatting (tabs for code)

## Tickets (tess)

This project uses [tess](tess/) for AI-driven ticket management.
Read and follow the ticket workflow rules in tess/agent-rules/tickets.md.
Tickets are in the [tickets/](tickets/) directory.

## Launch process tool (if under PowerShell)

The `launch-process` tool wraps commands in `powershell -Command ...`, which strips inner quotes and parses parentheses as subexpressions. This makes `git commit -m "task(review): ..."` impossible — no escaping strategy works.
Use a file or pipe based pattern as a work-around.  e.g. `git commit -F .git/COMMIT_EDITMSG`

## Project Structure
- Yarn 4 monorepo with workspaces under `packages/`
- Main engine: `packages/quereus` (TypeScript SQL query processor)
- CLI: `packages/quoomb-cli`, Web: `packages/quoomb-web`
- Plugins: `quereus-plugin-leveldb`, `quereus-plugin-indexeddb`, `quereus-plugin-react-native-leveldb`, `quereus-plugin-nativescript-sqlite`
- Sync: `quereus-sync`, `quereus-sync-client`, `sync-coordinator`
- Other: `plugin-loader`, `quereus-isolation`, `quereus-store`, `shared-ui`, `quereus-vscode`
- Task workflow in `tickets/` folder (see `tickets/AGENTS.md`)

## Build & Test
- `yarn build` runs sequentially through all packages
- `yarn test` runs tests across all workspaces
- Only `packages/quereus` has a lint script (`eslint`)
- On Windows, lint globs must be single-quoted to avoid command line too long errors
- Tests use Mocha + ts-node/esm for quereus, Vitest for some other packages

## Key Architecture Notes
- All tables are virtual tables (VTab-centric design)
- Async core: cursors are `AsyncIterable<Row>`
- Key-based addressing (no rowids)
- Type system: logical/physical type separation with temporal types
- Planner uses PlanNodes, runtime uses Instructions

## Docs
- Main docs in `docs/` folder (runtime.md, types.md, sql.md, usage.md, etc.)
- Package README at `packages/quereus/README.md`
----

For all but the most trivial asks, read and maintain the relevant docs along with the work. 
