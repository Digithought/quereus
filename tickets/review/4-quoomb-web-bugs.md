description: Fix three bugs in quoomb-web stores and components
dependencies: none
files:
  - packages/quoomb-web/src/stores/settingsStore.ts
  - packages/quoomb-web/src/components/SyncEventsPanel.tsx
  - packages/quoomb-web/src/stores/configStore.ts
  - packages/quoomb-web/src/__tests__/configStore.test.ts
----

# Quoomb Web Bug Fixes — Review

Three bugs fixed in `packages/quoomb-web/`.

## Bug 1: `resetToDefaults` Inconsistent Defaults

**File:** `settingsStore.ts` — `resetToDefaults` method

**Problem:** `resetToDefaults` hardcoded values that diverged from `defaultSettings` (`autoSave: false` vs `true`, `wordWrap: false` vs `true`, panel sizes 60/40 vs 50/50).

**Fix:** Replaced the hardcoded object with `{ ...defaultSettings, plugins: [] }` and used `defaultSettings.theme` for the `applyThemeToDocument` call, ensuring a single source of truth.

**Test case:** After calling `resetToDefaults`, verify `autoSave === true`, `wordWrap === true`, and `defaultPanelSizes === {editor: 50, results: 50}`.

## Bug 2: SyncEventsPanel Hook After Conditional Return

**File:** `SyncEventsPanel.tsx`

**Problem:** `useEffect` hook was called after an early `return null`, violating React's rules of hooks. When `storageModule !== 'sync'`, the hook would be skipped, causing React to see a different number of hooks across renders.

**Fix:** Moved the conditional `return null` below the `useEffect` call. All hooks now execute unconditionally before any early returns.

**Test case:** Toggle `storageModule` between `'sync'` and another value; verify no React hook-ordering errors in the console.

## Bug 3: configStore Array JSON Validation Gap

**File:** `configStore.ts` — `importConfig` method

**Problem:** `typeof config !== 'object' || config === null` passed arrays through, since `typeof [] === 'object'`. An array like `[1, 2, 3]` would be accepted as valid config.

**Fix:** Added `Array.isArray(config)` to the validation check.

**Test case:** Existing test updated from documenting the gap to asserting rejection — `importConfig('[]')` now throws `'Config must be a JSON object'`.

## Verification

- Build: `yarn workspace @quereus/quoomb-web build` — passes
- Tests: 59/59 pass across 3 test files
