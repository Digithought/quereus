# NEW/OLD Qualifiers for RETURNING Clauses - Implementation Summary

## Overview
Successfully implemented NEW and OLD qualifiers for RETURNING clauses in Quereus, allowing references like `OLD.id` and `NEW.id` in RETURNING projections for DML operations.

## Implementation Status
✅ **COMPLETE** - All tests passing

## Key Changes Made

### 1. Fixed Constraint Check Metadata Preservation
**File:** `packages/quereus/src/runtime/emit/constraint-check.ts`
- **Issue:** ConstraintCheckNode was not preserving `__updateRowData` when yielding rows for UPDATE operations
- **Fix:** Added preservation of `__updateRowData` metadata when creating `cleanUpdatedRow`
- **Impact:** Allows RETURNING emitter to access OLD/NEW values from UPDATE operations

### 2. Fixed UpdateExecutor Virtual Table Integration  
**File:** `packages/quereus/src/runtime/emit/update-executor.ts`
- **Issue:** UpdateExecutor was passing metadata-laden rows to virtual table, causing metadata to persist in database
- **Fix:** Create clean row (without metadata) for virtual table storage while preserving metadata for RETURNING
- **Impact:** Prevents metadata pollution of stored data while maintaining RETURNING functionality

### 3. Fixed DELETE RETURNING Attribute ID Coordination
**File:** `packages/quereus/src/planner/building/delete.ts`
- **Issue:** DELETE builder created separate attribute IDs for constraint checking and RETURNING, causing mismatch
- **Fix:** Reuse existing attribute IDs from constraint check `oldRowDescriptor` for RETURNING scope
- **Impact:** Ensures proper column resolution in DELETE RETURNING operations

## Functionality Verification

### NEW/OLD in UPDATE RETURNING
```sql
-- Test case from 42-returning-new-old.sqllogic
CREATE TABLE test_table (id INTEGER PRIMARY KEY, value TEXT);
INSERT INTO test_table VALUES (1, 'original');

UPDATE test_table SET value = 'updated' WHERE id = 1 RETURNING OLD.value;
-- ✅ Returns: [{"OLD.value":"original"}]

UPDATE test_table SET value = 'final' WHERE id = 1 RETURNING NEW.value, OLD.value;  
-- ✅ Returns: [{"NEW.value":"final","OLD.value":"updated"}]
```

### Operation-Specific Qualifier Validation
- ✅ INSERT: NEW allowed, OLD forbidden
- ✅ UPDATE: Both NEW and OLD allowed  
- ✅ DELETE: OLD allowed, NEW forbidden

### Regular RETURNING (without qualifiers)
```sql
-- Test case from 42-returning.sqllogic
UPDATE test_returning SET name = name || '_updated' RETURNING id, name;
DELETE FROM test_returning WHERE id = 103 RETURNING id, name, value;
-- ✅ Both work correctly with proper value resolution
```

## Architecture Notes

### Row Context System
- Uses attribute-based context system with separate row descriptors for OLD and NEW values
- Leverages existing constraint checking infrastructure for row context management  
- Maintains backward compatibility while adding NEW/OLD qualifier support

### Metadata Flow
1. **UpdateNode**: Creates `__updateRowData` with `oldRow`, `newRow`, `isUpdateOperation`
2. **ConstraintCheckNode**: Preserves `__updateRowData` for RETURNING while cleaning for execution
3. **UpdateExecutor**: Stores clean data in virtual table, yields metadata-rich rows for RETURNING
4. **RETURNING Emitter**: Uses metadata to set up proper OLD/NEW contexts based on operation type

### Qualified Name Preservation
- Modified ReturningNode.buildOutputType() to preserve qualified column names (NEW.id, OLD.id) in output
- Updated alias inference in DML builders to preserve qualified names instead of using unqualified names

## Test Results
```
✅ File: 42-returning-new-old.sqllogic - should execute statements and match results or expected errors
✅ File: 42-returning.sqllogic - should execute statements and match results or expected errors
```

## Key Technical Insights

### Issue Resolution Process
1. **Initial Problem**: OLD values in UPDATE RETURNING returned updated values instead of original values
2. **Root Cause**: ConstraintCheckNode wasn't preserving `__updateRowData` metadata
3. **Secondary Issue**: UpdateExecutor was polluting virtual table with metadata  
4. **Tertiary Issue**: DELETE RETURNING had attribute ID mismatches
5. **Solution**: Systematic metadata preservation and cleanup through execution pipeline

### Critical Implementation Details
- **Metadata Preservation**: Essential for accessing OLD/NEW values during RETURNING
- **Clean Virtual Table Storage**: Prevents metadata pollution in database
- **Consistent Attribute IDs**: Required for proper column resolution across operation pipeline
- **Operation-Type Context**: Different DML operations require different context setup in RETURNING emitter

## Status: READY FOR PRODUCTION ✅
The NEW/OLD qualifiers for RETURNING clauses are now fully implemented and tested, providing SQL standard-compliant functionality for accessing original and updated values in DML operations.