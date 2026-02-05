---
description: Standardize parameter binding key types (string vs number)
dependencies: none
priority: 3
---

# Fix Parameter Binding Key Inconsistency

## Problem

Parameter binding uses inconsistent key types for positional parameters:

**`bindAll()` uses string keys:**
```typescript
// statement.ts:237-241
const convertedArgs: Record<string, SqlValue> = {};
args.forEach((value, index) => {
	convertedArgs[String(index + 1)] = value; // String key "1", "2", etc.
});
```

**`bind()` uses numeric keys:**
```typescript
// statement.ts:219-221
if (typeof key === 'number') {
	if (key < 1) throw new RangeError(`Argument index ${key} out of range`);
	this.boundArgs[key] = value; // Numeric key 1, 2, etc.
}
```

**Constructor uses numeric keys:**
```typescript
// statement.ts:80-83
paramsOrTypes.forEach((value, index) => {
	this.boundArgs[index + 1] = value; // Numeric key
});
```

This means `boundArgs` can have both numeric keys (from `bind()` / constructor) and string keys (from `bindAll()`). While JavaScript coerces these for property access, it's confusing and could cause subtle bugs.

## Solution

Standardize on numeric keys for positional parameters throughout.

### Key Files

- `packages/quereus/src/core/statement.ts`

## TODO

- [ ] Update `bindAll()` to use numeric keys: `convertedArgs[index + 1] = value;`
- [ ] Update type of `convertedArgs` to `Record<number | string, SqlValue>` if needed for named params
- [ ] Audit any other places that create or consume `boundArgs`
- [ ] Add test that verifies `bind()` and `bindAll()` produce consistent results
- [ ] Verify parameter resolution works correctly with numeric keys
