---
description: Fix O(n) full scans and DRY violations in isolation layer
dependencies: packages/quereus-isolation/src/isolated-table.ts, docs/design-isolation-layer.md

---

# Isolation Layer Performance and DRY Issues

Issues found during review of `packages/quereus-isolation/`.

## O(n) Full Scans

### `getOverlayRow()` (line ~637)

Uses `createFullScanFilterInfo()` and iterates all overlay rows to find one by PK. Should use PK point lookup via the overlay module's index.

### `rowExistsInUnderlying()` (line ~770)

Iterates ALL underlying rows to check if a PK exists. Should use PK point lookup. The design doc already documents this fix in "Optimization 3: Existence Check via Point Lookup" (lines 711-748 of `docs/design-isolation-layer.md`).

### `clearOverlay()` (line ~793)

Iterates all rows, collects PKs, then deletes one by one. Could destroy and recreate the overlay table instead.

## DRY Violations

### Dual commit paths

Both `commit()` (line ~692) and `onConnectionCommit()` (line ~914) contain identical logic: `flushOverlayToUnderlying()` then `clearOverlay()`. One should delegate to the other.

### Dual rollback paths

Both `rollback()` (line ~785) and `onConnectionRollback()` (line ~926) clear the overlay. One should delegate to the other.

### Dual savepoint paths

`savepoint()/release()/rollbackTo()` operate on BOTH underlying AND overlay. `onConnectionSavepoint()/onConnectionReleaseSavepoint()/onConnectionRollbackToSavepoint()` operate on overlay ONLY. Risk of double-savepointing on underlying if both paths execute.

## Module-Level Mutable Counters

`overlayIdCounter` in `isolation-module.ts` and `connectionIdCounter` in `isolated-connection.ts` are module-level variables that persist across tests and module instances. Consider scoping to the module instance or accepting this as intentional.

## TODO

- [ ] Implement PK point lookup for `getOverlayRow()` and `rowExistsInUnderlying()` (follow design doc Optimization 3)
- [ ] Optimize `clearOverlay()` to destroy/recreate instead of row-by-row delete
- [ ] Consolidate dual commit/rollback/savepoint paths (DRY)

