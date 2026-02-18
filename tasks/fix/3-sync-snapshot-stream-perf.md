---
description: O(N*M) performance bug in getSnapshotStream table entry counting
dependencies: none

---

# O(N*M) Performance in Snapshot Streaming

## Problem

**File:** `packages/quereus-sync/src/sync/sync-manager-impl.ts` lines 1188-1195

In `getSnapshotStream()`, for each table, the code iterates ALL column versions to count entries belonging to that specific table:

```typescript
for (const tableKey of tableKeys) {
  // ...
  const tableCvBounds = buildAllColumnVersionsScanBounds(); // scans ALL tables
  for await (const entry of this.kv.iterate(tableCvBounds)) {
    const parsed = parseColumnVersionKey(entry.key);
    if (parsed && parsed.schema === schema && parsed.table === table) {
      tableEntryCount++;
    }
  }
```

This is O(N*M) where N = total column versions and M = number of tables. For 10 tables with 10,000 entries each, this scans 1,000,000 entries instead of 100,000.

The same issue exists in `resumeSnapshotStream()` (lines 1579-1585).

## Fix

Use table-scoped scan bounds instead of scanning all column versions. The key encoding already supports prefix-based scanning per table — `buildColumnVersionScanBounds(schema, table)` exists but isn't used here.

Replace `buildAllColumnVersionsScanBounds()` with `buildColumnVersionScanBounds(schema, table)` for the per-table counting and streaming loops.

**Files:** `packages/quereus-sync/src/sync/sync-manager-impl.ts`, `packages/quereus-sync/src/metadata/keys.ts`

