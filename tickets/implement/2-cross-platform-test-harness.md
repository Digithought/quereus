description: Cross-platform test harness to verify core engine works in browser environments
dependencies: none (core engine is already cross-platform by design)
files:
  - packages/quereus/test/cross-platform/browser.spec.ts (new)
  - packages/quereus/test/cross-platform/env-compat.spec.ts (new)
  - packages/quereus/src/ (scan for Node.js-only APIs)
  - packages/quereus/package.json (reference)
----

## Overview

Quereus targets browser, Node.js, React Native, and edge workers. Currently all tests run in Node.js only. This ticket adds:

1. **Environment compatibility audit tests** — static analysis tests that verify the core engine doesn't import Node.js-only modules
2. **Browser smoke test** — a minimal test that bundles the engine and runs core queries in a headless browser

The React Native environment can't be easily tested in CI without native tooling, so it's excluded here. The environment audit catches the most common cross-platform issues (accidental `fs`, `path`, `child_process` imports).

## Design

### Environment Compatibility Tests (`test/cross-platform/env-compat.spec.ts`)

A Mocha test that scans `src/` for Node.js-only imports. This is a fast, static check:

- Scan all `.ts` files in `src/` (excluding test files)
- Assert: no imports of `node:fs`, `node:path`, `node:child_process`, `node:os`, `node:crypto` (the `node:` prefix imports)
- Assert: no bare `require()` calls
- Allowed exceptions: `node:` imports behind dynamic `import()` in explicitly platform-gated code (if any exist, document them)
- This catches regressions where someone accidentally adds a Node.js dependency to the core engine

### Browser Smoke Test (`test/cross-platform/browser.spec.ts`)

Uses a lightweight approach — rather than a full browser test runner, verify that the engine can be imported and basic operations work in an environment that lacks Node.js globals:

- Create a test that exercises the core path (create Database, create table, insert, select, close) using only the public API
- The test itself runs in Node.js but verifies that no Node.js-specific globals are accessed during these operations by running the test with a restricted global context (override `process`, `Buffer`, etc. with undefined for the duration of the test, or use `vm.createContext` with only standard JS globals)
- This is a pragmatic middle ground — catches accidental Node.js API usage without requiring Playwright/browser infrastructure

### Future: Full Browser Test Suite

A future ticket could add Playwright-based browser testing that:
- Bundles the engine with esbuild
- Serves the bundle
- Runs a subset of sqllogic tests in a headless browser
- Tests the IndexedDB plugin in a real browser environment

This is deferred because it requires significant infrastructure (build step, Playwright setup, CI configuration).

### Key Expected Behaviors
- `env-compat` test catches any new `node:*` imports in src/
- Browser smoke test verifies core CRUD operations work without Node.js APIs
- No changes to the engine code — these are purely observational tests

## TODO

- Create `test/cross-platform/` directory
- Implement environment compatibility audit test (scan for Node.js-only imports)
- Implement browser smoke test (restricted global context or vm-based)
- Verify all tests pass
- Run full test suite to confirm no regressions
