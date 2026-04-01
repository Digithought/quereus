description: Add c8 code coverage reporting to the quereus test suite
dependencies: c8 (npm devDependency)
files: packages/quereus/package.json, .gitignore, packages/quereus/test-runner.mjs
----

## Overview

Add `c8` code coverage instrumentation to the quereus package. `c8` uses V8's built-in coverage (no source transforms) and works with the existing Mocha + ts-node/esm setup out of the box.

## How it works

The test runner (`test-runner.mjs`) spawns a child `node` process to run mocha. `c8` sets `NODE_V8_COVERAGE` env var, which is inherited by child processes, so `c8 node test-runner.mjs` captures coverage from the spawned mocha process automatically.

## Changes

### 1. Install c8

```
yarn add -D c8   (in packages/quereus)
```

### 2. Add `test:coverage` script to `packages/quereus/package.json`

```json
"test:coverage": "c8 --exclude 'test/**' --exclude 'bench/**' --reporter text --reporter html node test-runner.mjs"
```

- `--exclude 'test/**'` — don't count test files in coverage
- `--exclude 'bench/**'` — don't count benchmark files
- `--reporter text` — terminal summary for quick checks
- `--reporter html` — detailed HTML report in `coverage/`
- No threshold enforcement — this is for visibility only

### 3. Add `coverage/` to `.gitignore`

Append `coverage/` to the root `.gitignore`.

### 4. Verify

Run `yarn test:coverage` in `packages/quereus` and confirm:
- Tests pass as before
- Text coverage summary appears in terminal
- HTML report is generated in `coverage/`

## Key tests for review

- `yarn test` still works identically (no regression)
- `yarn test:coverage` produces text summary + HTML report
- `coverage/` directory is created with HTML files
- Test files themselves are excluded from coverage metrics
- Coverage reports on `src/**` files

## TODO

- Install `c8` as a devDependency in packages/quereus
- Add `test:coverage` script to packages/quereus/package.json
- Add `coverage/` to root .gitignore
- Run `yarn test:coverage` and verify output
- Run `yarn test` and verify no regression
