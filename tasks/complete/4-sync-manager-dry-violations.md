---
description: Removed duplicated GetTableSchemaCallback type from sync-manager-impl.ts
dependencies: none
files: packages/quereus-sync/src/sync/sync-manager-impl.ts, packages/quereus-sync/src/create-sync-module.ts
---

# DRY: GetTableSchemaCallback Type Deduplication

## What Changed

`GetTableSchemaCallback` was defined identically in two files:
- `packages/quereus-sync/src/create-sync-module.ts` (public API — kept)
- `packages/quereus-sync/src/sync/sync-manager-impl.ts` (internal — removed, now imports from create-sync-module)

The unused direct `TableSchema` import in sync-manager-impl.ts was also cleaned up.

## Verification

- Build: `yarn workspace @quereus/sync build` — passes
- Tests: `yarn workspace @quereus/sync test` — all 151 tests pass
- No external consumers import `GetTableSchemaCallback` from sync-manager-impl.ts; the public barrel export re-exports from `create-sync-module.ts`
