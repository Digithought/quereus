---
description: Add missing lifecycle and cleanup tests for core API
dependencies: none
priority: 3
---

# Core API Lifecycle Tests

## Problem

The test suite has gaps in lifecycle management and cleanup verification:

### Missing Database Lifecycle Tests
- `close()` cleans up resources
- Operations rejected after `close()` (exec, prepare, get, eval)
- Statement operations fail after database close

### Missing Statement Lifecycle Tests
- Operations rejected after `finalize()`
- Statement reuse after error (state consistency)
- Multiple `finalize()` calls (idempotency)

### Missing Iterator Cleanup Tests
- `iterate()` cleanup on completion
- `iterate()` cleanup on early exit (break/return)
- `iterate()` cleanup on error (throw during iteration)

### Missing Return Value Tests
- `exec()` returns `lastInsertRowid` and `changes` count
- `run()` returns `changes` and `lastInsertRowid`

## Key Files

- `packages/quereus/test/` - Test directory
- Create new file: `packages/quereus/test/lifecycle.spec.ts`

## TODO

### Database Lifecycle Tests
- [ ] Test `close()` cleans up all statements
- [ ] Test `exec()` throws after `close()`
- [ ] Test `prepare()` throws after `close()`
- [ ] Test `get()` throws after `close()`
- [ ] Test `eval()` throws after `close()`
- [ ] Test existing statements fail after database `close()`

### Statement Lifecycle Tests
- [ ] Test `run()` throws after `finalize()`
- [ ] Test `get()` throws after `finalize()`
- [ ] Test `all()` throws after `finalize()`
- [ ] Test `iterateRows()` throws after `finalize()`
- [ ] Test multiple `finalize()` calls are idempotent (no error)
- [ ] Test statement reuse after execution error (reset and retry)

### Iterator Cleanup Tests
- [ ] Test iterator completes normally and releases resources
- [ ] Test `break` from `for await` releases resources
- [ ] Test `return` from async function releases resources
- [ ] Test throwing into iterator releases resources
- [ ] Test mutex is released on early exit (no deadlock on next query)

### Return Value Tests
- [ ] Test `exec()` INSERT returns correct `lastInsertRowid`
- [ ] Test `exec()` UPDATE returns correct `changes` count
- [ ] Test `exec()` DELETE returns correct `changes` count
- [ ] Test `run()` INSERT returns correct `lastInsertRowid`
- [ ] Test `run()` UPDATE returns correct `changes` count
- [ ] Test `run()` multiple statement batch returns last statement's values

### Transaction Isolation Tests (bonus)
- [ ] Test uncommitted changes visible within same transaction
- [ ] Test changes visible after commit
- [ ] Test changes hidden after rollback
