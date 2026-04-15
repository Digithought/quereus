---
description: Raise mutation and branch coverage on `src/runtime/emit/scan.ts` (baseline 53.85% mutation score in the mutation testing session — the lowest of the untouched emitters after cast.ts / unary.ts / binary.ts were targeted in round 1).
dependencies: Stryker infrastructure
files:
  packages/quereus/src/runtime/emit/scan.ts
  packages/quereus/src/planner/nodes/table-access-nodes.ts
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/test/logic/110-scan-emitter-mutation-kills.sqllogic
  packages/quereus/test/runtime/scan-emitter.spec.ts
  packages/quereus/docs/zero-bug-plan.md
---

## Context

`runtime/emit/scan.ts` emits the `SeqScanNode | IndexScanNode | IndexSeekNode` family — the hot path for every physical table access. It's 109 lines and scored **53.85%** in the baseline mutation report. Because this code runs on literally every query, surviving mutants here can corrupt any result set in the engine.

Branches to cover:

| Line | Branch |
|---|---|
| 25 | Module lookup miss → `QuereusError(ERROR)` |
| 36 | Captured module info missing → `QuereusError(INTERNAL)` |
| 41 | `module.connect` not a function → `QuereusError(MISUSE)` |
| 49 | `readCommitted` option propagated when set |
| 59-62 | `connect` throws — wrapped error preserves original `code` or falls back to `ERROR`, original passed as `cause` |
| 64-68 | `vtab.query` not a function → `QuereusError(UNSUPPORTED)` |
| 72-78 | `IndexSeekNode` dynamic seek keys — `dynamicArgs` spread into `filterInfo.args`, empty `dynamicArgs` falls through to static `plan.filterInfo` |
| 85-87 | `query` iterator throws mid-iteration — wrapped with correct error code and cause |
| 88-92 | `finally` runs both `rowSlot.close()` and `disconnectVTable` on normal and exceptional exits |
| 97-101 | `IndexSeekNode` path emits param instructions per seek key; `SeqScanNode`/`IndexScanNode` paths emit zero params |

## Test strategy

Scan emitter tests want to exercise **both** happy-path and error wrapping, because a mutant that corrupts the wrapping wouldn't fail a "does the query return rows" check. Two layers:

**Unit tests** (`test/runtime/scan-emitter.spec.ts`, new): emit a scan against a mock virtual table module that can be configured to throw at `connect` time, at `query` time, or mid-iteration. Assert:
- Emitted instructions have the right kind, the right param count, the right label
- Running the instruction against a mock returns the expected rows
- Each error branch throws a `QuereusError` with the exact `StatusCode` and a `cause` pointing at the original
- Exception mid-iteration still runs `disconnectVTable` and `rowSlot.close()` (track via mock spy)

**SQL logic tests** (`test/logic/110-scan-emitter-mutation-kills.sqllogic`, new): end-to-end queries against the memory vtab that exercise:
- `SeqScan` over empty table, single-row, large (500+ rows) — iteration edge cases
- `IndexScan` over ordered column — verify ordering
- `IndexSeek` with a literal key, with a parameter, with a composite key — exercises the dynamic-args path
- `IndexSeek` with a NULL seek key — should handle without throwing

### Error-path unit test sketch

```ts
it('connect failure wraps the error with original cause', async () => {
  const badModule = {
    connect: async () => { throw new QuereusError('nope', StatusCode.BUSY); }
  };
  const instr = emitSeqScan(seqScanPlan, ctx);
  await expect(runInstr(instr)).rejects.toMatchObject({
    code: StatusCode.BUSY,
    message: expect.stringContaining("connect failed for table 't'"),
    cause: expect.any(QuereusError),
  });
});

it('query not implemented throws UNSUPPORTED', async () => { ... });

it('mid-iteration throw still disconnects vtab', async () => {
  const disconnected = vi.fn();
  const throwingModule = {
    connect: async () => ({
      query: async function* () { yield [1]; throw new Error('boom'); },
      disconnect: disconnected,
    }),
  };
  await expect(runInstr(...)).rejects.toThrow();
  expect(disconnected).toHaveBeenCalledOnce();
});
```

## Validation loop

```bash
cd packages/quereus
yarn test
yarn mutation:subsystem emit
```

Target: raise `scan.ts` mutation score from 53.85% to ≥85%. The mutation testing session already documented equivalent mutants in `finally` cleanup and debug `note` strings — don't waste time on those.

## TODO

- [ ] Inspect existing emitter unit tests (if any — check `test/runtime/`) for the mock-module pattern
- [ ] Create mock virtual-table module utility if none exists — make it reusable for future emit tests
- [ ] `test/runtime/scan-emitter.spec.ts` — cover every error branch in scan.ts with a targeted test
- [ ] Cover happy path: `SeqScan`, `IndexScan`, `IndexSeek` (static args), `IndexSeek` (dynamic args)
- [ ] Assert `disconnectVTable` and `rowSlot.close()` run on both normal and exceptional completion
- [ ] `test/logic/110-scan-emitter-mutation-kills.sqllogic` — end-to-end per access method
- [ ] Include a test that the error `cause` chain reaches the original thrown object (not swallowed to string)
- [ ] Re-run `yarn mutation:subsystem emit`, record new score in `docs/zero-bug-plan.md` §6
