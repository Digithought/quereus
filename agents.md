## General

- Use lowercase SQL reserved words (e.g., `select * from Table`)
- Don't use inline `import()` unless dynamically loading
- Don't create summary documents; update existing documentation
- Stay DRY
- No lengthy summaries
- Don't worry about backwards compatibility yet
- Use yarn
- Prefix unused arguments with `_`
- Enclose `case` blocks in braces if any consts/variables
- Prefix calls to unused promises (micro-tasks) with `void`
- ES Modules
- Don't be type lazy - avoid `any`
- Don't eat exceptions w/o at least logging; exceptions should be exceptional - not control flow
- Small, single-purpose functions/methods.  Decomposed sub-functions over grouped code sections
- No half-baked janky parsers; use a full-fledged parser or better, brainstorm with the dev for another way
- Think cross-platform (browser, node, RN, etc.)
- .editorconfig contains formatting (tabs for code)

## Tickets (tess)

This project uses [tess](tess/) for AI-driven ticket management.
Read and follow the ticket workflow rules in tess/agent-rules/tickets.md.
Tickets are in the [tickets/](tickets/) directory.

## Launch process tool (if under PowerShell)

The `launch-process` tool wraps commands in `powershell -Command ...`, which strips inner quotes and parses parentheses as subexpressions. This makes `git commit -m "task(review): ..."` impossible — no escaping strategy works.
Use a file or pipe based pattern as a work-around.  e.g. `git commit -F .git/COMMIT_EDITMSG`

## Project Structure

Yarn 4 monorepo. All packages under `packages/`.

```
quereus/                   # Main SQL engine — see its README for detailed src/ layout
├── src/                   #   core/ parser/ planner/ runtime/ emit/ schema/ types/ func/ vtab/ common/ util/
│   ├── planner/           #   building/ nodes/ rules/{access,aggregate,cache,distinct,join,predicate,retrieve,subquery}/
│   │                      #   framework/ cost/ analysis/ stats/ validation/ scopes/ cache/
│   └── runtime/emit/      #   Instruction emitters — mirrors planner/nodes/ 1:1
├── test/                  #   logic/*.sqllogic (primary), plan/, optimizer/, planner/, vtab/
└── docs/                  #   runtime.md, types.md, sql.md, optimizer.md, schema.md, ...
quoomb-cli/                # CLI tool
quoomb-web/                # Web UI
quereus-store/             # Persistent key-value store abstraction
quereus-isolation/         # Snapshot isolation layer
quereus-sync/              # Sync engine
quereus-sync-client/       # Sync client
sync-coordinator/          # Sync server/coordinator
plugin-loader/             # Plugin loading infrastructure
quereus-plugin-leveldb/    # LevelDB storage plugin
quereus-plugin-indexeddb/  # IndexedDB storage plugin
quereus-plugin-react-native-leveldb/
quereus-plugin-nativescript-sqlite/
quereus-vscode/            # VS Code extension
shared-ui/                 # Shared UI components
sample-plugins/            # Example plugins
```

Task workflow in `tickets/` folder (see `tickets/AGENTS.md`).

## Build & Test
- `yarn build` runs sequentially through all packages
- `yarn test` runs tests across all workspaces — **the default for agents**; fast, memory-backed vtab
- `yarn test:store` re-runs `packages/quereus` logic tests against the LevelDB store module (slower; exercises the store code path for ALTER, constraints, transactions, etc.)
- `yarn test:full` runs both — **only run when diagnosing a store-specific issue or preparing a release**
- Only `packages/quereus` has a lint script (`eslint`)
- On Windows, lint globs must be single-quoted to avoid command line too long errors
- Tests use Mocha + ts-node/esm for quereus, Vitest for some other packages

## Key Architecture Notes
- All tables are virtual tables (VTab-centric design)
- Async core: cursors are `AsyncIterable<Row>`
- Key-based addressing (no rowids)
- Type system: logical/physical type separation with temporal types
- Pipeline: SQL → parser → AST → planner/building → PlanNode tree → optimizer rules → emit → Instructions

## Docs
- **Start here for engine internals:** `docs/architecture.md` — pipeline, source layout, extension patterns, design decisions, constraints, testing strategy
- **Package overview / user-facing:** `packages/quereus/README.md` — quick start, platform/storage, docs index, current status
- Deeper topic docs in `docs/` folder (runtime.md, types.md, sql.md, optimizer.md, schema.md, usage.md, etc.)

----

For all but the most trivial asks, read and maintain the relevant docs along with the work.
