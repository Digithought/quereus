---
description: `StoreTable.update` now honors column-level `defaultConflict` for PK and per-UC `defaultConflict` for non-PK UNIQUE constraints, matching the precedence rule `statement OR > per-constraint default > ABORT` already implemented by `MemoryTable` and the isolation overlay. The UPDATE PK-change REPLACE path now populates `UpdateResult.replacedRow` so the executor can run ON DELETE cascade/SET NULL for the evicted row at the new PK. A `delete` event is also emitted for the evicted row at the store-level event emitter (matches MemoryTable's `recordDelete(newPK, evictee)` step). Verified via new direct-StoreTable spec and the existing isolation-wrapped logic file.
files:
  packages/quereus-store/src/common/store-table.ts
  packages/quereus-store/test/column-default-conflict.spec.ts
---

## Changes

### 1. Local helper

Added `resolvePkDefaultConflict(schema)` at the top of `store-table.ts`, mirroring the two existing copies in `packages/quereus/.../layer/manager.ts:1500` and `packages/quereus-isolation/.../isolated-table.ts:1331`. Each implementation keeps the same precedence rule: table-level `PRIMARY KEY (...) ON CONFLICT <action>` wins over any column-level `defaultConflict` on a PK column.

The helper is not exported from any of the three locations — that was the existing convention and we kept it. If a future ticket needs to consolidate, all three need to move together.

### 2. INSERT branch (`store-table.ts:608-692`)

- Resolves `pkEffective = args.onConflict ?? resolvePkDefaultConflict(schema) ?? ABORT` once at the top of the case.
- PK-conflict block uses `pkEffective` instead of strict-equal `args.onConflict === REPLACE/IGNORE`.
- **Important deviation from the ticket**: passes `args.onConflict` (the raw statement-level value), **not** `pkEffective`, into `checkUniqueConstraints`. The ticket said "pass `effective` (not `args.onConflict`)" but that would break per-UC `defaultConflict` resolution: if the PK has no default and a UC has `ON CONFLICT REPLACE`, passing the PK-resolved `ABORT` shadows the UC's own default. MemoryTable's reference implementation (`manager.ts:579`, `:774`) passes the original `onConflict` and resolves per-UC inside `checkUniqueConstraints`. The included test `INSERT with UNIQUE ON CONFLICT REPLACE` would fail under the ticket's literal wording — that's what surfaced the issue.

### 3. UPDATE PK-change branch (`store-table.ts:694-790`)

- Same `pkEffective` resolution.
- On REPLACE eviction, captures `replacedAtNewPk: Row | null = deserializeRow(existingAtNew)`.
- Same `args.onConflict` (not `pkEffective`) into `checkUniqueConstraints` for the reason above.
- Emits a `delete` store-level event for the evicted row at the new PK before the existing `update` event for the moved row. This matches MemoryTable's `recordDelete(newPK, evictee)` step in `manager.ts:657`. The engine's `dml-executor.ts:527-538` separately emits an engine-level `delete` auto-event via `emitAutoDataEvent` when `result.replacedRow` is set, so listeners on both surfaces (store-level `StoreEventEmitter` and engine-level data events) now observe the eviction.
- Success return now includes `replacedRow: replacedAtNewPk ?? undefined`. The executor at `dml-executor.ts:527-538` consumes this for ON DELETE cascade/SET NULL on the evicted row (verified by the new cascade test).

### 4. `checkUniqueConstraints` (`store-table.ts:917-925`)

- Inside the per-UC loop, resolves `effective = onConflict ?? uc.defaultConflict ?? ABORT`.
- IGNORE/REPLACE/ABORT branches now use this resolved action rather than the raw `onConflict` parameter.

## Test plan

New spec at `packages/quereus-store/test/column-default-conflict.spec.ts` (modeled on `unique-constraints.spec.ts`) registers `StoreModule` directly without the isolation overlay, exposing the StoreTable code path. Covers:

- **INSERT with PRIMARY KEY ON CONFLICT REPLACE** — duplicate PK silently replaces.
- **INSERT with PRIMARY KEY ON CONFLICT IGNORE** — duplicate PK silently dropped.
- **INSERT with UNIQUE ON CONFLICT REPLACE** — duplicate non-PK UNIQUE value triggers REPLACE eviction of the conflicting row. This is the test that surfaced the `effective` vs `args.onConflict` ambiguity in the ticket.
- **UPDATE PK-change with PRIMARY KEY ON CONFLICT REPLACE** — colliding new PK is evicted and the moved row takes its place.
- **UPDATE PK-change with PRIMARY KEY ON CONFLICT IGNORE** — UPDATE drops silently when new PK is occupied; both original rows unchanged.
- **Statement-level OR ABORT overrides column-level IGNORE on INSERT** — direct precedence check. (UPDATE OR \<action\> is intentionally not supported by the parser per `logic/47.2 §5` and `docs/sql.md §11`, so the statement-level override path is INSERT-only.)
- **UPDATE PK-change REPLACE cascades ON DELETE for evicted row** — child of evicted row is deleted via FK cascade. This exercises the `replacedRow` round-trip through the dml-executor → `executeForeignKeyActions`. This test only passes after `packages/quereus` is rebuilt; the prereq ticket `dml-executor-update-replaced-row-not-recorded` added the executor side (`dml-executor.ts:527-538`).

### Verification runs (Windows + Git Bash)

- `yarn workspace @quereus/store test`: **259 passing**, 0 failing. New spec adds 7 cases, all green.
- `yarn test`: **all engine packages pass**. The only failures are 2 pre-existing failures in `@quereus/sample-plugins` (`Comprehensive Demo Plugin > supports delete` and `supports update` in `packages/sample-plugins/test/plugins.spec.ts`); verified pre-existing by stashing the change and re-running — same 2 failures. Unrelated to this fix.
- `yarn test:store` (logic tests through LevelDB isolation overlay): **577 passing, 1 failing**. The one failing test (`10.5.1-partial-indexes.sqllogic:49`) is a pre-existing failure (verified by stashing); unrelated to this fix. `29.1-column-level-conflict-clause.sqllogic` (the file most directly testing this work via the isolation overlay) passes in full.

### Build-order note for reviewers

The new cascade test depends on the engine's executor-side `replacedRow` consumption from the prereq ticket. If `packages/quereus/dist` is stale, the cascade test fails with the child still referencing the evicted parent. Run `yarn workspace @quereus/quereus build` before `yarn workspace @quereus/store test` to pick up the prereq.

## Honest gaps / known limitations

- **`checkUniqueConstraints` partial-UNIQUE predicate gap is pre-existing, not addressed here.** Pre-existing failure in `10.5.1-partial-indexes.sqllogic:49` shows StoreTable's UC check doesn't respect the `WHERE` predicate of a partial UNIQUE index. The MemoryTable path goes through `checkUniqueViaIndex` which honors `index.predicate`, but StoreTable's `findUniqueConflict` scans every row regardless of predicate scope. Out of scope for this ticket.
- **`pkEffective` is computed even when there's no `existing` row at the PK.** Minor: the variable is unused in the no-conflict path. Left in place for clarity (resolving once at the top of the case mirrors MemoryTable's structure). A reviewer who wants tighter code can move the computation inside `if (existing)`.
- **Event emission for the moved row is still an `update` event.** When PK-change REPLACE fires, we now emit `delete(newPk, evictee) → update(newPk, oldRow=at-oldPk, newRow=coerced)`. MemoryTable's contract is `delete(newPk, evictee) → delete(oldPk, atOldPk) → upsert(newPk, coerced)`. The store-level event sequence differs from MemoryTable in that we keep the existing `update` semantic for the moved row rather than emitting `delete(oldPk) + insert(newPk)`. The engine-level data events go through `emitAutoDataEvent` in the executor and follow that contract independently, so listeners observing engine events see consistent behavior; only `StoreEventEmitter` subscribers (sync clients, etc.) see this difference. If sync coherence requires the strict `delete + delete + insert` triplet, a follow-up can refactor that section — but it's a behavioral change beyond the conflict-resolution fix this ticket targets.
- **No direct unit test asserting `result.replacedRow` on the UPDATE return.** The cascade test verifies end-to-end behavior, which is the more meaningful signal, but a direct `vtab.update(...)` call would assert the contract more tightly. Skipped because `VirtualTable` is not trivially constructible standalone in the test harness (needs Database/coordinator/etc.); the cascade test is the realistic proxy.

## Reviewer attention

- The deviation from the ticket's literal "pass `effective` not `args.onConflict`" advice is the highest-risk change. If the reviewer disagrees with the read of the precedence rule, this is where to push back. The argument for passing the original `args.onConflict`: MemoryTable does this (`manager.ts:579,631,674`), the per-UC resolution is `onConflict ?? uc.defaultConflict ?? ABORT`, and passing a PK-resolved `ABORT` would shadow a UC's own `REPLACE`/`IGNORE`. The `INSERT with UNIQUE ON CONFLICT REPLACE` test fails with the ticket's literal wording.
- The added `delete` event emission for the evictee should be cross-checked against any store-level event consumers (sync clients) to ensure they handle the new sequence (`delete(newPk) + update(newPk)`).
- `pkEffective` could be inlined further; left at function-top for readability.
