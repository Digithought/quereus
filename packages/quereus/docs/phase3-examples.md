# Phase 3 Titan Optimizer Features

Phase 3 introduces several polishing features to make the Quereus optimizer production-ready:

## 1. Constant Folding

The constant folding optimizer automatically evaluates constant expressions at plan time.

### Example

```sql
-- Input query
SELECT 1 + 2 * 3, upper('hello'), length('world') FROM users WHERE id = 5 + 5;

-- After constant folding:
-- SELECT 7, 'HELLO', 5 FROM users WHERE id = 10;
```

### Supported Operations

- Arithmetic: `+`, `-`, `*`, `/`, `%`
- String operations: `||` (concatenation)
- Comparisons: `=`, `!=`, `<>`, `<`, `<=`, `>`, `>=`
- Logical: `AND`, `OR`, `NOT`
- Functions: `abs()`, `length()`, `upper()`, `lower()`, `coalesce()`
- Type casting

### Debug Tracing

```bash
# Enable constant folding debug output
DEBUG=quereus:optimizer:folding* yarn test
```

## 2. Plan Validation

Automatic validation of optimized plan trees before execution.

### What's Validated

- Physical properties are present on all nodes
- Attribute IDs are unique and properly referenced
- Column references point to valid attributes
- No logical-only nodes remain in physical tree
- Ordering specifications are valid

### Enable Validation

```typescript
// Via Database API
db.setOption('validate_plan', true);
// or using alias
db.setOption('plan_validation', true);

// Via PRAGMA (in SQL) - supports multiple boolean formats
PRAGMA validate_plan = true;
PRAGMA validate_plan = on;
PRAGMA validate_plan = 1;
PRAGMA validate_plan = yes;
```

### Debug Output

```bash
# Enable validation debug output
DEBUG=optimizer:validate* yarn test
```

## 3. Execution Metrics

Runtime statistics collection for instruction execution.

### Enable Metrics

```typescript
// Via Database API
db.setOption('runtime_stats', true);
// or using alias
db.setOption('runtime_metrics', true);

// Via PRAGMA (in SQL) - supports multiple boolean formats
PRAGMA runtime_stats = true;
PRAGMA runtime_stats = on;
PRAGMA runtime_stats = 1;
PRAGMA runtime_stats = yes;
```

### View Metrics

```bash
# Enable metrics debug output
DEBUG=runtime:stats* yarn test
```

### Sample Output

```
Execution metrics summary:
  [0] scan(users): 1 exec, 0 in, 1000 out, 5.23ms
  [1] filter(id=10): 1 exec, 1000 in, 1 out, 0.15ms
  [2] project(name,email): 1 exec, 1 in, 1 out, 0.02ms
Total execution time: 5.40ms
```

## 4. ESLint Rule

Enforces separation between logical and physical nodes in builder code.

### Installation

```bash
# Install the plugin (if publishing to npm)
npm install eslint-plugin-quereus --save-dev

# Or use local plugin
cd tools/eslint-plugin-quereus && npm link
npm link eslint-plugin-quereus
```

### Configuration

```json
// .eslintrc.json
{
  "plugins": ["quereus"],
  "rules": {
    "quereus/no-physical-in-builder": "error"
  }
}
```

### Example Error

```typescript
// In packages/quereus/src/planner/building/select.ts
// ❌ This will trigger an ESLint error:
return new StreamAggregateNode(scope, source, groupBy, aggregates);
// Error: Physical node 'StreamAggregateNode' must be created in optimizer rules, not builder code.

// ✅ Correct approach:
return new AggregateNode(scope, source, groupBy, aggregates);
```

## 5. Debug Namespaces

Standardized debug logging utilities.

### Available Loggers

```typescript
import { 
  ruleLog, 
  validateLog, 
  statsLog, 
  foldingLog, 
  emitLog 
} from '../debug/logger-utils.js';

// In optimizer rules
const log = ruleLog('my-optimization-rule');

// In validation code
const log = validateLog('attributes');

// In runtime statistics
const log = statsLog('cache');

// In constant folding
const log = foldingLog('binary-ops');

// In emitters
const log = emitLog('table-scan');
```

### Debug Patterns

```bash
# Enable all optimizer rules
DEBUG=quereus:optimizer:rule:* yarn test

# Enable specific rule
DEBUG=quereus:optimizer:rule:constant-folding yarn test

# Enable plan validation
DEBUG=quereus:optimizer:validate* yarn test

# Enable runtime stats
DEBUG=quereus:runtime:stats* yarn test

# Enable everything
DEBUG=quereus:* yarn test

# Exclude verbose logs
DEBUG=quereus:*,-quereus:runtime:emit:* yarn test
```

### Pre-defined Namespace Constants

```typescript
import { DEBUG_NAMESPACES } from '../debug/logger-utils.js';

// Use predefined patterns
console.log('Enable all optimizer rules:', DEBUG_NAMESPACES.OPTIMIZER_RULE);
console.log('Enable all runtime:', DEBUG_NAMESPACES.ALL_RUNTIME);
```

## Combined Usage Example

```typescript
// Configure database options programmatically
db.setOption('runtime_stats', true);
db.setOption('validate_plan', true);
db.setOption('default_vtab_module', 'memory');
db.setOption('default_vtab_args', { cache_size: 1000 });

// Or via SQL
await db.exec(`
  PRAGMA runtime_stats = on;
  PRAGMA validate_plan = yes;
  PRAGMA default_vtab_module = 'custom_module';
  PRAGMA default_vtab_args = '{"setting": "value"}';
`);

// View all current options
console.log('Current options:', db.options.getAllOptions());

// View option definitions
console.log('Available options:', db.options.getOptionDefinitions());

// Type-safe option access
const isStatsEnabled = db.options.getBooleanOption('runtime_stats');
const vtabModule = db.options.getStringOption('default_vtab_module');
const vtabArgs = db.options.getObjectOption('default_vtab_args');
```

```bash
#!/bin/bash
# Run tests with debugging enabled
export DEBUG="optimizer:rule:*,optimizer:validate*,runtime:stats*"
yarn test
```

This provides:
- Type-safe option management with automatic conversion
- Event-driven updates to affected components  
- Support for aliases and multiple value formats
- Centralized configuration without environment dependencies

## Performance Notes

- Constant folding improves runtime performance by reducing computation
- Plan validation adds minimal overhead in development, disabled in production
- Runtime metrics add ~10-15% overhead when enabled
- Debug logging should only be enabled during development 
