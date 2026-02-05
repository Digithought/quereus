---
description: Extract repeated function registration error handling
dependencies: none
priority: 3
---

# DRY: Function Registration Error Handling

## Problem

Identical try-catch pattern for function registration is repeated 3 times in `database.ts`:

```typescript
// Lines 776-780, 811-816, 827-832
} catch (e) {
	errorLog(`Failed to register scalar function ${name}/${options.numArgs}: %O`, e);
	if (e instanceof Error) throw e; else quereusError(String(e));
}
```

Additionally, the `else` branch converts non-Error values but the pattern inconsistently handles QuereusError vs Error.

## Solution

Extract to a helper method that:
1. Logs the error
2. Re-throws QuereusError unchanged
3. Wraps other errors in QuereusError with context

### Design

```typescript
private registerFunctionWithErrorHandling(
	funcType: string, 
	funcName: string, 
	numArgs: number, 
	register: () => void
): void {
	try {
		register();
	} catch (e) {
		errorLog(`Failed to register ${funcType} function ${funcName}/${numArgs}: %O`, e);
		if (e instanceof QuereusError) throw e;
		throw new QuereusError(
			`Failed to register ${funcType} function ${funcName}/${numArgs}: ${e instanceof Error ? e.message : String(e)}`,
			StatusCode.ERROR,
			e instanceof Error ? e : undefined
		);
	}
}
```

### Key Files

- `packages/quereus/src/core/database.ts`

## TODO

- [ ] Add `registerFunctionWithErrorHandling()` private method to Database class
- [ ] Refactor `createScalarFunction()` to use helper
- [ ] Refactor `createAggregateFunction()` to use helper  
- [ ] Refactor `registerFunction()` to use helper
- [ ] Ensure QuereusError is used consistently (not plain Error)
- [ ] Verify all function registration tests still pass
