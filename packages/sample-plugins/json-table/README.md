# JSON_TABLE Plugin

A sample virtual table plugin for Quereus that allows reading JSON data from URLs or files as if it were a SQL table.

## Features

- 📄 Read JSON from HTTP/HTTPS URLs
- 📁 Read JSON from local files (Node.js CLI only)
- 🔍 JSONPath support for extracting specific data
- 🗃️ Automatic schema detection from JSON structure
- ⚡ Configurable HTTP timeout and caching
- 🔄 Object flattening for nested JSON structures

## Installation

### Web Playground

1. Open Quoomb settings (⚙️ icon)
2. Click "Manage Plugins"
3. Enter the URL to this plugin file:
   ```
   https://raw.githubusercontent.com/user/repo/main/packages/sample-plugins/json-table/index.js
   ```
4. Click "Install"

### CLI

```bash
quoomb
.plugin install https://raw.githubusercontent.com/user/repo/main/packages/sample-plugins/json-table/index.js
```

## Usage

### Create a Virtual Table

```sql
CREATE TABLE my_data USING json_table(
  'https://api.example.com/data.json',
  '$.items[*]'
);
```

Parameters:
- **URL** (required): HTTP/HTTPS URL or file:// path to JSON data
- **JSONPath** (optional): JSONPath expression to extract specific data (default: `$`)

### Query the Data

```sql
SELECT * FROM my_data;
SELECT name, email FROM my_data WHERE age > 25;
```

## Examples

### Basic API Data

```sql
CREATE TABLE posts USING json_table(
  'https://jsonplaceholder.typicode.com/posts'
);

SELECT title, body FROM posts LIMIT 5;
```

### Nested JSON with JSONPath

```sql
-- Given JSON: {"users": [{"name": "John", "profile": {"age": 30}}]}
CREATE TABLE users USING json_table(
  'https://api.example.com/users.json',
  '$.users[*]'
);

SELECT name, profile_age FROM users;
```

### Local File (CLI only)

```sql
CREATE TABLE local_data USING json_table(
  'file:///path/to/data.json'
);
```

## Configuration

The plugin supports several configuration options:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `timeout` | number | 30000 | HTTP request timeout in milliseconds |
| `cache_ttl` | number | 300 | Cache TTL for HTTP responses in seconds |
| `user_agent` | string | "Quereus JSON_TABLE Plugin/1.0.0" | User agent for HTTP requests |
| `enable_cache` | boolean | true | Whether to cache HTTP responses |

### Setting Configuration (Web)

1. Open Plugin Manager
2. Click the settings icon next to JSON_TABLE
3. Modify values and click "Save Configuration"

### Setting Configuration (CLI)

```bash
# View current configuration
.plugin config JSON_TABLE

# Set specific values
.plugin config JSON_TABLE timeout=60000 cache_ttl=600
.plugin config JSON_TABLE enable_cache=false
```

## Schema Detection

The plugin automatically detects the schema by:

1. Extracting items using the JSONPath expression
2. Flattening nested objects (e.g., `{user: {name: "John"}}` becomes `{user_name: "John"}`)
3. Converting arrays to JSON strings
4. Creating TEXT columns for all detected properties

## JSONPath Support

This plugin includes basic JSONPath support for common patterns:

- `$` - Root object/array
- `$.property` - Access a specific property
- `$.items[*]` - Access all items in an array

For advanced JSONPath expressions, consider using a dedicated JSONPath library in a custom plugin.

## Error Handling

- **Network errors**: Shows descriptive error messages for HTTP failures
- **Invalid JSON**: Reports JSON parsing errors
- **Missing data**: Empty tables for missing or null data paths
- **Timeout**: Configurable request timeouts prevent hanging

## Performance Considerations

- **Caching**: HTTP responses are cached in memory based on `cache_ttl`
- **Large datasets**: Consider using JSONPath to extract only needed data
- **Memory usage**: All data is loaded into memory; not suitable for very large datasets

## Development

This plugin serves as a template for creating your own virtual table modules. Key concepts:

1. **Manifest**: Describes the plugin metadata and configuration options
2. **Registration function**: Called by Quereus to register the virtual table module
3. **Virtual table class**: Implements the table interface with `scan()` method
4. **Schema generation**: Creates appropriate SQL table schema

## License

This sample plugin is provided as-is for educational purposes. 
