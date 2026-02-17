---
description: Fix three bugs in quoomb-web stores and components
dependencies: 3-review-pkg-quoomb-web
priority: 3
---

# Quoomb Web Bug Fixes

Three bugs found during review of `packages/quoomb-web/`.

## Bug 1: `resetToDefaults` Inconsistent Defaults

**File:** `src/stores/settingsStore.ts` lines 260–280

`defaultSettings` (line 71–95) defines `autoSave: true`, `wordWrap: true`, `defaultPanelSizes: {editor: 50, results: 50}`. But `resetToDefaults` hardcodes different values: `autoSave: false`, `wordWrap: false`, `defaultPanelSizes: {editor: 60, results: 40}`.

**Fix:** Replace the hardcoded object in `resetToDefaults` with a spread of `defaultSettings` plus `plugins: []` and the storage/sync fields. Then call `applyThemeToDocument`.

## Bug 2: SyncEventsPanel Hook After Conditional Return

**File:** `src/components/SyncEventsPanel.tsx` lines 20–25

Early return (`if (storageModule !== 'sync') return null`) at line 20 occurs before `useEffect` at line 25. This violates React rules of hooks — hooks must be called in the same order on every render, never conditionally skipped.

**Fix:** Move all hooks above the conditional return. The `useEffect` and `useState` calls must come before any early returns.

## Bug 3: configStore Array JSON Validation Gap

**File:** `src/stores/configStore.ts`, `importConfig` method

The validation `typeof config !== 'object' || config === null` does not reject arrays because `typeof [] === 'object'`. An array JSON value like `[1, 2, 3]` would pass validation and be stored as config.

**Fix:** Add `Array.isArray(config)` check: `if (typeof config !== 'object' || config === null || Array.isArray(config))`.

## TODO

- [ ] Fix `resetToDefaults` to spread `defaultSettings` instead of hardcoded values
- [ ] Move hooks above conditional return in SyncEventsPanel
- [ ] Add `Array.isArray` check in configStore `importConfig`
- [ ] Update existing tests to verify fixes (settingsStore resetToDefaults test, configStore array test)

