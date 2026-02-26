---
description: Fix O(N*M) performance in snapshot stream table entry counting/streaming
files: packages/quereus-sync/src/metadata/keys.ts, packages/quereus-sync/src/sync/snapshot-stream.ts, packages/quereus-sync/src/index.ts
---

# Fix: O(N*M) Snapshot Stream Performance

## Problem
In `streamSnapshotChunks()` (snapshot-stream.ts), for each table, two full scans of ALL column versions were performed via `buildAllColumnVersionsScanBounds()`:
1. One to count entries for that table (filtering by schema/table match)
2. One to stream entries for that table (same filter)

This was O(N*M) where N = total column versions and M = number of tables.

## Changes

### keys.ts
Added `buildTableColumnVersionScanBounds(schema, table)` — returns scan bounds scoped to `cv:{schema}.{table}:` prefix, enabling efficient per-table iteration without scanning unrelated tables.

### snapshot-stream.ts
- Replaced `buildAllColumnVersionsScanBounds()` with `buildTableColumnVersionScanBounds(schema, table)` in the per-table loop
- Eliminated the redundant counting pass entirely — was only used for `estimatedEntries` in the `table-start` chunk. Now set to 0 and the actual count is in `table-end.entriesWritten`
- Result: single O(entries_per_table) pass per table instead of 2 × O(all_entries)

### index.ts
Exported `buildTableColumnVersionScanBounds` for external consumers.

## Testing
- All 151 existing tests pass (sync-manager, sync-protocol-e2e)
- Snapshot streaming tests validate header/footer, chunk sizes, apply, and resume flows
