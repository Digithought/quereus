description: Cross-platform test harness to verify core engine works in browser environments
dependencies: none
files:
  - packages/quereus/test/cross-platform/browser.spec.ts (new)
  - packages/quereus/test/cross-platform/env-compat.spec.ts (new)
----

## What was built

Two test suites in `test/cross-platform/` that verify the core engine is safe for browser/edge/RN environments:

### Environment Compatibility Audit (`env-compat.spec.ts`)

Static analysis scanning all `.ts` files in `src/` (excluding tests) for:
- `node:` prefix imports (e.g. `node:fs`, `node:path`, `node:crypto`)
- Bare Node.js built-in module imports (e.g. `import ... from 'fs'`)
- `require()` calls
- Unguarded `process.*` access (must have `typeof process` guard within 5 lines)
- `Buffer` usage (should use `Uint8Array` instead)

Known documented exception: `runtime/scheduler.ts` uses `process.hrtime.bigint()` in an optional metrics-only code path.

### Browser Environment Smoke Test (`browser.spec.ts`)

Temporarily stubs Node.js globals (`process`, `Buffer`, `__dirname`, `__filename`) to `undefined`, then exercises core engine operations:
- Database creation
- Table creation + schema verification
- Insert, select, update, delete
- Aggregation queries
- Joins
- Subqueries

Globals are restored in `afterEach` (in a `finally` block for safety).

## Testing notes

- 14 new tests, all passing
- Full suite: 277 passing, 1 pre-existing failure in `08.1-semi-anti-join.sqllogic` (unrelated)
- No engine code was modified — purely observational tests

## Key review points

- Verify the static scan patterns are comprehensive enough
- Verify the `PROCESS_EXCEPTIONS` allowlist approach is appropriate for `scheduler.ts`
- Verify the global-stubbing approach adequately simulates browser constraints
- Confirm the test data is deterministic (ordering, aggregation values)
