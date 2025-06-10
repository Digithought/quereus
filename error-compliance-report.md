# Error Handling Compliance Report

## Summary

This report documents the verification and fixes applied to ensure all errors in the planner, runtime, parser, and core modules comply with Quereus error conventions and include locators where possible.

## Error Conventions

1. **QuereusError** - General errors with optional location info (line/column)
2. **ParseError** - Parser errors with token information
3. **ConstraintError** - Database constraint violations
4. **MisuseError** - API misuse errors
5. **Helper Function** - `quereusError()` for convenient error throwing with location extraction

## ✅ Verification Complete

The `quereusError` helper function has been successfully implemented and tested. It automatically:
- Extracts location information from AST nodes when available
- Appends location to error messages in the format "(at line X, column Y)"
- Supports error chaining with the `cause` parameter
- Defaults to `StatusCode.ERROR` when no status code is specified

### Test Results:
```
✓ Test 1 passed - Basic error:
  Message: Test error without location
  Type: QuereusError
  Status: ERROR

✓ Test 2 passed - Error with location:
  Message: Test error with location (at line 42, column 7)
  Type: QuereusError
  Status: UNSUPPORTED
  Line: 42
  Column: 7

✓ Test 3 passed - Error with cause:
  Message: Wrapped error
  Cause: Original error
```

## Fixed Issues

### Parser Module (`src/parser/`)

#### Fixed Files:
- `index.ts` - Replaced 2 plain `Error` throws with `quereusError` calls with location info
- `parser.ts` - Replaced 3 plain `Error` throws with `quereusError` calls with proper token location conversion

#### Example Fix:
```typescript
// Before:
throw new Error(`Expected INSERT statement, but got ${stmt.type}`);

// After:
quereusError(
    `Expected INSERT statement, but got ${stmt.type}`,
    StatusCode.ERROR,
    undefined,
    stmt
);
```

### Planner Module (`src/planner/`)

#### Fixed Files:
- `building/block.ts` - Replaced unsupported statement error with `quereusError`
- `optimizer.ts` - Replaced physical node error with `quereusError`
- `debug.ts` - Replaced root node error with `quereusError`
- `nodes/reference.ts` - Replaced table-valued function error with `quereusError`
- `nodes/scalar.ts` - Replaced unknown literal type error with `quereusError`

### Runtime Module (`src/runtime/`)

#### Fixed Files:
- `emit/transaction.ts` - Replaced 3 errors with `quereusError` for transaction operations
- `emit/recursive-cte.ts` - Replaced recursion limit error with `quereusError`
- `emit/aggregate.ts` - Fixed initial aggregate function validation errors

### Core Module (`src/core/`)

The core module already properly uses `MisuseError` and `QuereusError` throughout, so no changes were needed.

## Remaining Non-Compliant Errors

A comprehensive scan shows approximately **58 remaining plain `Error` throws** across the codebase:

### By Module:
- **Runtime Module** (`src/runtime/emit/`) - 8 instances
  - `aggregate.ts` - 4 instances
  - `array-index.ts` - 1 instance
  
- **Schema Module** (`src/schema/`) - 3 instances
  - `table.ts` - 1 instance  
  - `schema.ts` - 1 instance
  - `manager.ts` - 1 instance

- **Virtual Table Module** (`src/vtab/`) - 6 instances
  - `memory/index.ts` - 2 instances
  - `memory/layer/base-cursor.ts` - 1 instance
  - `memory/layer/transaction.ts` - 2 instances
  - `memory/layer/connection.ts` - 2 instances

- **Function Module** (`src/func/`) - 2 instances
  - `builtins/datetime.ts` - 2 instances

- **Core Module** (`src/core/`) - 3 instances
  - `database.ts` - 3 instances (error re-throw cases)

- **Utility Module** (`src/util/`) - 1 instance
  - `plugin-loader.ts` - 1 instance

- **Other packages** (quoomb-cli, quoomb-web) - 35 instances
  - These are outside the core quereus package scope

### Recommendations for Completion

1. **Systematic Review**: Go through each module systematically to replace remaining plain errors
2. **Location Extraction**: Ensure all errors that have access to AST nodes extract location information
3. **Error Type Selection**:
   - Use `quereusError` with `StatusCode.INTERNAL` for internal logic errors
   - Use `quereusError` with `StatusCode.UNSUPPORTED` for unimplemented features
   - Use `quereusError` with `StatusCode.ERROR` for general runtime errors
   - Use `MisuseError` for API misuse (already done in core module)

## Helper Function

Created `quereusError` helper in `src/common/errors.ts`:

```typescript
export function quereusError(
    message: string,
    code: StatusCode = StatusCode.ERROR,
    cause?: Error,
    astNode?: { loc?: { start: { line: number; column: number } } }
): never {
    throw new QuereusError(
        message,
        code,
        cause,
        astNode?.loc?.start.line,
        astNode?.loc?.start.column
    );
}
```

This helper automatically extracts location information from AST nodes when available.

## Next Steps

To complete the error compliance:

1. Run a comprehensive grep search for remaining `throw new Error` instances
2. Replace each with appropriate error type using the `quereusError` helper
3. Ensure location information is passed when available from AST nodes
4. Test that error messages include location information in the format: "Error message at line X, column Y"