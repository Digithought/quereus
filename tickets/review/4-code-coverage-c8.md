description: Add c8 code coverage reporting to the quereus test suite
dependencies: c8 (npm devDependency)
files: packages/quereus/package.json, .gitignore
----

## Summary

Added `c8` code coverage instrumentation to the quereus package. `c8` uses V8's built-in coverage (no source transforms) and works with the existing Mocha + ts-node/esm setup.

### Changes made

- Installed `c8@11.0.0` as a devDependency in `packages/quereus`
- Added `test:coverage` script to `packages/quereus/package.json`:
  ```
  c8 --exclude 'test/**' --exclude 'bench/**' --reporter text --reporter html node test-runner.mjs
  ```
- Added `coverage/` to root `.gitignore`

### Verification results

- `yarn test` — 1130 passing, 2 pending (no regression)
- `yarn test:coverage` — 1130 passing, 2 pending + text coverage summary printed + HTML report generated in `packages/quereus/coverage/`
- Overall statement coverage: ~57.77%
- Test files and bench files excluded from coverage metrics
- Coverage reports on both `src/` (source-mapped TS) and `dist/src/` (compiled JS) paths

## Use cases for testing

- `yarn test` still works identically (no regression)
- `yarn test:coverage` produces text summary in terminal + HTML report in `coverage/`
- `coverage/` directory is created with HTML files (index.html, etc.)
- Test files (`test/**`) are excluded from coverage metrics
- Bench files (`bench/**`) are excluded from coverage metrics
- Coverage reports on `src/**` files
