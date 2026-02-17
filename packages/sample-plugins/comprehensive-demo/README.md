# Comprehensive Demo Plugin

This plugin demonstrates all three types of Quereus plugin registrations in a single plugin:

- **Virtual Table** - A simple in-memory key-value store (`key_value_store` module name)
- **Functions** - Math utilities and data conversion functions
- **Collations** - Unicode case-insensitive sorting

This is an educational plugin showing how to combine multiple plugin types.

## Installation

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import comprehensiveDemo from '@quereus/quereus-plugin-comprehensive-demo/plugin';

const db = new Database();
await registerPlugin(db, comprehensiveDemo);

// Or with configuration:
await registerPlugin(db, comprehensiveDemo, {
  default_precision: 3,
  enable_debug: true
});
```

## Components Provided

### Virtual Table

- **`key_value_store`** - In-memory key-value store with persistence across queries

### Functions

- **`math_round_to(value, precision)`** - Round number to specific decimal places
- **`hex_to_int(hex_string)`** - Convert hex string to integer
- **`int_to_hex(integer)`** - Convert integer to hex string
- **`data_summary(json_data)`** - Table-valued function returning JSON data summary

### Collations

- **`UNICODE_CI`** - Unicode-aware case-insensitive collation

## Configuration

The plugin supports configuration options:

- **`default_precision`** (number, default: 2) - Default decimal precision for math functions
- **`enable_debug`** (boolean, default: false) - Enable debug logging

## Usage Examples

### Virtual Table Usage

```sql
-- Create a key-value store
CREATE TABLE config USING key_value_store('app_config');

-- Insert some data
INSERT INTO config (key, value) VALUES ('theme', 'dark');
INSERT INTO config (key, value) VALUES ('lang', 'en');

-- Query the data
SELECT * FROM config;
-- Results:
-- key   | value
-- ------|-------
-- theme | dark
-- lang  | en

-- Update values
UPDATE config SET value = 'light' WHERE key = 'theme';

-- Delete entries
DELETE FROM config WHERE key = 'lang';
```

### Function Usage

```sql
-- Round to specific precision
SELECT math_round_to(3.14159, 2);
-- Result: 3.14

SELECT math_round_to(123.456, 0);
-- Result: 123

-- Convert between hex and integer
SELECT hex_to_int('FF');
-- Result: 255

SELECT int_to_hex(255);
-- Result: '0xFF'

SELECT hex_to_int('0x10');
-- Result: 16

-- Analyze JSON data
SELECT * FROM data_summary('{"users": [1, 2, 3], "active": true}');
-- Results:
-- property | value
-- ---------|-------
-- type     | object
-- key_count| 2
-- first_key| users

SELECT * FROM data_summary('[1, 2, 3, 4, 5]');
-- Results:
-- property         | value
-- -----------------|-------
-- type            | array
-- length          | 5
-- first_element_type| number
```

### Collation Usage

```sql
-- Case-insensitive sorting with Unicode normalization
SELECT * FROM names ORDER BY name COLLATE UNICODE_CI;
-- Properly handles accented characters and case differences

-- Case-insensitive comparisons
SELECT * FROM users WHERE name = 'JOSÉ' COLLATE UNICODE_CI;
-- Matches 'José', 'josé', 'JOSÉ', etc.
```

## Detailed Component Information

### Key-Value Store Virtual Table

**Schema:** `CREATE TABLE kv_store(key TEXT PRIMARY KEY, value TEXT)`

**Features:**
- In-memory storage with persistence during session
- Primary key on `key` column
- Supports INSERT, UPDATE, DELETE, SELECT operations
- Multiple stores can be created with different names

**Arguments:**
- `store_name` (optional) - Name of the store (defaults to 'default')

```sql
-- Create named stores
CREATE TABLE user_prefs USING key_value_store('user_settings');
CREATE TABLE app_config USING key_value_store('application');
```

### Math and Data Functions

#### `math_round_to(value, precision)`

Rounds a number to a specified number of decimal places.

**Parameters:**
- `value` - Number to round
- `precision` - Number of decimal places (0 or positive integer)

**Returns:** Rounded number or NULL if inputs are invalid

```sql
SELECT math_round_to(3.14159, 2);    -- 3.14
SELECT math_round_to(123.456, 0);    -- 123
SELECT math_round_to(1.5, 1);        -- 1.5
```

#### `hex_to_int(hex_string)`

Converts a hexadecimal string to an integer.

**Parameters:**
- `hex_string` - Hex string (with or without '0x' prefix)

**Returns:** Integer value or NULL if invalid hex

```sql
SELECT hex_to_int('FF');        -- 255
SELECT hex_to_int('0x10');      -- 16
SELECT hex_to_int('invalid');   -- NULL
```

#### `int_to_hex(integer)`

Converts an integer to a hexadecimal string.

**Parameters:**
- `integer` - Integer value

**Returns:** Hex string with '0x' prefix or NULL if invalid

```sql
SELECT int_to_hex(255);    -- '0xFF'
SELECT int_to_hex(16);     -- '0x10'
SELECT int_to_hex(0);      -- '0x0'
```

#### `data_summary(json_data)`

Analyzes JSON data and returns summary information as rows.

**Parameters:**
- `json_data` - JSON string to analyze

**Returns:** Table with `property` and `value` columns

**Analysis for Objects:**
- `type` - 'object'
- `key_count` - Number of keys
- `first_key` - First key name

**Analysis for Arrays:**
- `type` - 'array'
- `length` - Array length
- `first_element_type` - Type of first element

**Analysis for Primitives:**
- `type` - Primitive type
- `value` - String representation

### Unicode Case-Insensitive Collation

The `UNICODE_CI` collation provides proper Unicode normalization and case-insensitive comparison.

**Features:**
- Unicode NFD normalization
- Case folding to lowercase
- NFC normalization for consistent results
- Proper handling of accented characters

```sql
-- All these will be considered equal:
SELECT 'José' = 'JOSÉ' COLLATE UNICODE_CI;     -- true
SELECT 'café' = 'CAFÉ' COLLATE UNICODE_CI;     -- true
SELECT 'naïve' = 'NAIVE' COLLATE UNICODE_CI;   -- true (depending on normalization)
```

## Configuration Options

### `default_precision`

Default decimal precision for math functions when precision is not specified.

**Type:** number  
**Default:** 2  
**Range:** 0 to reasonable limit

### `enable_debug`

Enable debug logging for plugin operations.

**Type:** boolean  
**Default:** false

When enabled, the plugin will log information about:
- Plugin loading
- Store creation
- Function calls
- Configuration values

## Error Handling

The plugin implements comprehensive error handling:

- **Virtual Table:** Graceful handling of invalid operations
- **Functions:** NULL return for invalid inputs
- **Collations:** Fallback to string conversion for non-strings
- **Configuration:** Sensible defaults for missing values

## Performance Notes

- Key-value store uses efficient Map operations
- Math functions are optimized for common use cases
- Collation uses cached normalization where possible
- All components are suitable for production use

## Source Code Structure

The plugin demonstrates several important patterns:

```javascript
// Combined registration
return {
  vtables: [/* vtable registrations */],
  functions: [/* function registrations */],
  collations: [/* collation registrations */]
};
```

**Key patterns shown:**
- Multi-type plugin registration
- Configuration parameter usage
- Error handling across all component types
- Memory management for virtual tables
- Proper function schema definition
- Unicode-aware collation implementation

## Educational Value

This plugin serves as a complete reference for:

- Combining multiple plugin types
- Configuration handling
- Error management
- Performance considerations
- Production-ready patterns

Use this as a template for creating your own comprehensive plugins that provide multiple types of functionality.
