---
description: Fix error handling inconsistencies (ParseError, inline require, logging)
dependencies: none
priority: 3
---

# Fix Error Handling Consistency

## Problems

### 1. ParseError Context Loss
**File:** `database.ts:458-464`

```typescript
if (e instanceof ParseError) throw new QuereusError(`Parse error: ${e.message}`, StatusCode.ERROR, e);
```

Wrapping ParseError loses line/column information since ParseError already extends QuereusError with location details.

**Fix:** Re-throw ParseError directly.

### 2. Inline `require()` in registerType
**File:** `database.ts:962-965`

```typescript
const { registerType } = require('../types/registry.js');
```

Violates project convention of no inline imports.

**Fix:** Move to top-level import.

### 3. Console.error Instead of Project Logger
**Files:** 
- `database-events.ts:341-347`
- `vtab/events.ts:133-139, 153-158, 178-184`

Error handling uses `console.error` instead of the project's logging system.

**Fix:** Use `createLogger()` or extend existing logger.

### Key Files

- `packages/quereus/src/core/database.ts`
- `packages/quereus/src/core/database-events.ts`
- `packages/quereus/src/vtab/events.ts`

## TODO

### ParseError Fix
- [ ] In `Database._parseSql()`, change to `if (e instanceof ParseError) throw e;`
- [ ] Verify error location info is preserved in tests

### Inline Import Fix
- [ ] Add `import { registerType as registerTypeInRegistry } from '../types/registry.js';` at top of database.ts
- [ ] Update `registerType()` method to use `registerTypeInRegistry()`
- [ ] Verify no circular dependency issues

### Logger Fix
- [ ] In `database-events.ts`, create error logger: `const errorLog = log.extend('error');`
- [ ] Replace `console.error` with `errorLog` in `emitDataEvent()` and `emitSchemaEvent()`
- [ ] In `vtab/events.ts`, add error logger and replace `console.error` calls
- [ ] Include event context in error logs for debugging
