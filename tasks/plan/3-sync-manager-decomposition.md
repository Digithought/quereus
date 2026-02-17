---
description: Decompose sync-manager-impl.ts (1,676 lines) into focused modules
dependencies: 3-sync-manager-dry-violations
priority: 3
---

# Decompose sync-manager-impl.ts

`sync-manager-impl.ts` is 1,676 lines with several long methods. Consider decomposing into:

1. **Snapshot streaming** (~260 lines): Extract `getSnapshotStream`, `resumeSnapshotStream`, `applySnapshotStream`, checkpoint save/load/clear into a `snapshot-stream.ts` module.

2. **Change application** (~330 lines): Extract `applyChanges`, `resolveChange`, `commitChangeMetadata` into a `change-applicator.ts` module.

3. **Non-streaming snapshot** (~220 lines): Extract `getSnapshot`, `applySnapshot` into a `snapshot.ts` module.

Key long methods that would benefit from decomposition:
- `applySnapshotStream` — 210 lines
- `getSnapshotStream` / `resumeSnapshotStream` — ~130 lines each (also duplicated, see DRY task)
- `applyChanges` — 130 lines

The SyncManagerImpl class would become a coordinator/facade that delegates to these modules, keeping the constructor, factory, event handlers, and simple accessors.

