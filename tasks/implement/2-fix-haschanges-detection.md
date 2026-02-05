---
description: Fix hasChanges() to not misdetect inherited BTree entries
dependencies: none
priority: 2
---

# Fix hasChanges() Inherited Entry Detection

## Problem

The `hasChanges()` method in memory table transaction layers may incorrectly detect inherited BTree entries as changes:

```typescript
// vtab/memory/layer/transaction.ts:259-277
public hasChanges(): boolean {
	// Check if primary modifications BTree has any entries beyond its base
	if (this.primaryModifications.getCount() > 0) {
		// Note: getCount() might include inherited entries, so we need a better way
		// to check if this layer has modifications. This depends on inheritree's API.
		// For now, assume any count > 0 means changes (might need refinement)
		return true;
	}
	// ...
}
```

The code comments acknowledge uncertainty about whether inherited entries are counted. This could lead to:
- False positives: Layer reports changes when it has none
- Unnecessary work during commit/rollback
- Incorrect optimization decisions

## Solution

Verify the inheritree API and use appropriate method to check for layer-only changes.

### Key Files

- `packages/quereus/src/vtab/memory/layer/transaction.ts`
- Inheritree library API documentation

## TODO

- [ ] Research inheritree API for checking layer-only entries vs inherited
- [ ] If available, use layer-specific count method
- [ ] If not available, track changes separately (e.g., `hasModifications` flag set on write)
- [ ] Update `hasChanges()` to accurately detect only this layer's modifications
- [ ] Add test: create layer, don't modify, verify `hasChanges()` returns false
- [ ] Add test: create layer, modify, verify `hasChanges()` returns true
- [ ] Add test: nested layers, modify inner only, verify outer `hasChanges()` returns false
