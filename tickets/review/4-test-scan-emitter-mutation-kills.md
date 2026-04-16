description: Raise mutation and branch coverage on `src/runtime/emit/scan.ts` via unit tests and sqllogic tests targeting every error branch and access method.
dependencies: none
files:
  packages/quereus/src/runtime/emit/scan.ts
  packages/quereus/test/runtime/scan-emitter.spec.ts
  packages/quereus/test/logic/110-scan-emitter-mutation-kills.sqllogic
---

## Summary

Added 20 unit tests and 1 sqllogic test file covering every branch in `runtime/emit/scan.ts`:

### Unit tests (`test/runtime/scan-emitter.spec.ts`)

**Happy-path coverage:**
- SeqScan: empty table, single row, multi-row
- IndexScan: ordered access via secondary index
- IndexSeek: literal key, parameter-based key (dynamic args), composite key, seek miss, empty dynamic result

**Error-branch coverage:**
- `connect` throws `QuereusError` — verifies wrapper preserves original error code (BUSY, LOCKED, etc.)
- `connect` throws plain `Error` — verifies `StatusCode.ERROR` fallback and cause chain
- `cause` chain — verifies original thrown object is accessible as `error.cause`
- `vtab.query` not a function — verifies `StatusCode.UNSUPPORTED` error
- Mid-iteration `QuereusError` — verifies code preservation and cause chain
- Mid-iteration plain `Error` — verifies `StatusCode.ERROR` wrapping
- Mid-iteration throw — verifies `disconnectVTable` is still called (finally cleanup)

**Structural coverage:**
- Row descriptor correctness (columns in different order than schema)
- Disconnect/cleanup on normal completion

### SQL logic tests (`test/logic/110-scan-emitter-mutation-kills.sqllogic`)

End-to-end tests via the memory vtab exercising:
- SeqScan: empty, single, multi-row (10 rows with sum verification)
- IndexScan: ordered by secondary index, descending
- IndexSeek: literal PK, seek miss, composite PK
- IndexScan range: `>=`/`<=` bounds, single-bound
- NULL handling: `= null` vs `is null`
- Column mapping: select columns in non-schema order

### Testing approach for custom modules

Custom vtab modules (`StubTable` + factory functions) registered via `db.registerModule()` allow testing scan.ts error paths that can't be triggered through normal SQL. Key detail: `getBestAccessPlan` must return `rows > 0` to prevent the optimizer from replacing the scan with an `EmptyResultNode`.

## Validation

- `yarn test` — 2314 passing, 0 failing
- All 20 new unit tests pass
- All sqllogic tests in 110-scan-emitter-mutation-kills.sqllogic pass

## Review checklist

- [ ] Verify test assertions are specific enough to kill the mutants described in the ticket
- [ ] Verify the test file follows existing conventions (Mocha + Chai, no Vitest)
- [ ] Run `yarn mutation:subsystem emit` and record updated score in `docs/zero-bug-plan.md`
