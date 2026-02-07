# Built-in Functions Reference

This document lists the built-in SQL functions available in Quereus.

---

## Type Conversion Functions

Quereus uses conversion functions instead of the SQL `CAST` operator for explicit type conversions. Each validates and converts to the target type, returning `NULL` on `NULL` input or throwing on invalid conversion.

| Function | Returns | Description |
|---|---|---|
| `integer(X)` | INTEGER | Truncates reals, parses strings, booleans to 0/1 |
| `real(X)` | REAL | Parses strings, integers to float, booleans to 0.0/1.0 |
| `text(X)` | TEXT | Stringifies numbers, booleans to `'true'`/`'false'`, blobs to hex |
| `boolean(X)` | BOOLEAN | 0/`'false'` is false; non-zero/`'true'` is true |
| `date(X)` | TEXT | `YYYY-MM-DD` format. Accepts `'now'` for current UTC date |
| `time(X)` | TEXT | `HH:MM:SS` format. Accepts `'now'` for current UTC time |
| `datetime(X)` | TEXT | ISO 8601 datetime. Accepts `'now'` for current UTC timestamp |
| `timespan(X)` | TEXT | ISO 8601 duration. Accepts ISO (`'PT1H30M'`) or human-readable (`'1 hour 30 minutes'`) |
| `json(X)` | TEXT | Validates/normalizes JSON. Non-JSON values converted to JSON representation |

```sql
select integer('42');        -- 42
select real(42);             -- 42.0
select text(true);           -- 'true'
select boolean(0);           -- false
select date('now');           -- '2024-01-15'
select timespan('2 hours');  -- 'PT2H'
select json('{"x":1}');      -- '{"x":1}'
```

---

## Scalar Functions

### Math Functions

| Function | Args | Returns | Description |
|---|---|---|---|
| `abs(X)` | 1 | numeric | Absolute value. Preserves input type (INTEGER/REAL/BIGINT) |
| `round(X)` | 1 | numeric | Round to nearest integer |
| `round(X, Y)` | 2 | numeric | Round X to Y decimal places |
| `sqrt(X)` | 1 | REAL | Square root. `NULL` if negative |
| `pow(X, Y)` | 2 | REAL | X raised to power Y |
| `power(X, Y)` | 2 | REAL | Alias for `pow` |
| `floor(X)` | 1 | numeric | Largest integer not greater than X |
| `ceil(X)` | 1 | numeric | Smallest integer not less than X |
| `ceiling(X)` | 1 | numeric | Alias for `ceil` |
| `clamp(X, min, max)` | 3 | numeric | Constrain X to range [min, max] |
| `random()` | 0 | BIGINT | Pseudo-random integer in safe JS integer range. Non-deterministic |
| `randomblob(N)` | 1 | BLOB | N pseudo-random bytes (capped at 1 MB). Non-deterministic |

```sql
select abs(-5);           -- 5
select round(123.456, 2); -- 123.46
select sqrt(16);          -- 4.0
select pow(2, 3);         -- 8.0
select floor(4.8);        -- 4
select ceil(-4.8);        -- -4
select clamp(15, 0, 10);  -- 10
```

### Conditional and Type Functions

| Function | Args | Returns | Description |
|---|---|---|---|
| `coalesce(X, Y, ...)` | variadic | any | First non-NULL argument |
| `nullif(X, Y)` | 2 | any | `NULL` if X = Y, else X |
| `iif(X, Y, Z)` | 3 | any | If X is truthy then Y, else Z |
| `typeof(X)` | 1 | TEXT | Type name: `'null'`, `'integer'`, `'real'`, `'text'`, `'blob'` |
| `greatest(X, Y, ...)` | variadic | any | Largest value using SQL comparison |
| `least(X, Y, ...)` | variadic | any | Smallest value using SQL comparison |
| `choose(N, V1, V2, ...)` | variadic | any | Returns the N-th value (1-based index). `NULL` if out of range |

```sql
select coalesce(null, 5, 'hello'); -- 5
select nullif(10, 10);             -- NULL
select iif(1 > 0, 'yes', 'no');   -- 'yes'
select typeof(10.5);               -- 'real'
select greatest(3, 1, 2);          -- 3
select least(3, 1, 2);             -- 1
select choose(2, 'a', 'b', 'c');   -- 'b'
```

---

## String Functions

| Function | Args | Returns | Description |
|---|---|---|---|
| `lower(X)` | 1 | TEXT | Lowercase. `NULL` if not a string |
| `upper(X)` | 1 | TEXT | Uppercase. `NULL` if not a string |
| `length(X)` | 1 | INTEGER | Character count (TEXT) or byte count (BLOB) |
| `substr(X, Y, Z?)` | 2-3 | TEXT | Substring starting at position Y (1-based), Z chars long |
| `substring(X, Y, Z?)` | 2-3 | TEXT | Alias for `substr` |
| `trim(X, Y?)` | 1-2 | TEXT | Remove leading+trailing chars (default: whitespace) |
| `ltrim(X, Y?)` | 1-2 | TEXT | Remove leading chars |
| `rtrim(X, Y?)` | 1-2 | TEXT | Remove trailing chars |
| `replace(X, Y, Z)` | 3 | TEXT | Replace all occurrences of Y in X with Z. Case-sensitive |
| `instr(X, Y)` | 2 | INTEGER | 1-based position of first occurrence of Y in X. 0 if not found |
| `reverse(X)` | 1 | TEXT | Reverse the string. Unicode-aware |
| `lpad(X, N, P)` | 3 | TEXT | Left-pad X to length N using pad string P |
| `rpad(X, N, P)` | 3 | TEXT | Right-pad X to length N using pad string P |
| `like(pattern, string)` | 2 | INTEGER | LIKE match: `%` = any chars, `_` = one char. Case-sensitive |
| `glob(pattern, string)` | 2 | INTEGER | GLOB match: `*` = any chars, `?` = one char. Case-sensitive |

```sql
select lower('Quereus');             -- 'quereus'
select substr('Quereus', 4, 2);     -- 're'
select substr('Quereus', -4);       -- 'reus'
select trim('  abc  ');             -- 'abc'
select ltrim('123abc123', '0123456789'); -- 'abc123'
select replace('abc abc', 'b', 'X'); -- 'aXc aXc'
select instr('banana', 'a');         -- 2
select reverse('hello');             -- 'olleh'
select lpad('42', 5, '0');          -- '00042'
```

### String Table-Valued Function

**`split_string(str, delimiter)`** -- Splits a string into rows.

| Column | Type | Description |
|---|---|---|
| `value` | TEXT | The split segment |
| `ordinal` | INTEGER | 0-based index |

```sql
select value from split_string('a,b,c', ',');
-- 'a', 'b', 'c'
```

### String Aggregate

**`string_concat(X)`** -- Concatenates all non-NULL string values with commas.

```sql
select string_concat(name) from users;
-- 'Alice,Bob,Charlie'
```

---

## Aggregate Functions

Aggregate functions compute a single result from multiple rows within a `GROUP BY` group (or the entire result set).

| Function | Args | Returns | Description |
|---|---|---|---|
| `count(*)` | 0 | INTEGER | Total row count (including NULLs) |
| `count(X)` | 1 | INTEGER | Count of non-NULL values |
| `sum(X)` | 1 | INTEGER/BIGINT/REAL | Sum. `NULL` for empty set |
| `total(X)` | 1 | REAL | Sum, always REAL. `0.0` for empty set |
| `avg(X)` | 1 | REAL | Average. `NULL` for empty set |
| `min(X)` | 1 | any | Minimum non-NULL value |
| `max(X)` | 1 | any | Maximum non-NULL value |
| `group_concat(X, Y?)` | 1-2 | TEXT | Concatenate values, separated by Y (default `','`) |
| `var_pop(X)` | 1 | REAL | Population variance. `NULL` if fewer than 1 value |
| `var_samp(X)` | 1 | REAL | Sample variance. `NULL` if fewer than 2 values |
| `stddev_pop(X)` | 1 | REAL | Population standard deviation |
| `stddev_samp(X)` | 1 | REAL | Sample standard deviation |
| `json_group_array(X)` | 1 | TEXT | JSON array of all values (including NULLs as JSON `null`) |
| `json_group_object(N, V)` | 2 | TEXT | JSON object from key/value pairs. Skips NULL keys |

```sql
select count(*), sum(salary), avg(salary) from employees;
select group_concat(name, '; ') from users;
select json_group_array(score) from results;
-- '[95,80,null,95]'
select json_group_object(key, value) from config;
-- '{"theme":"dark","fontSize":12}'
```

**Difference from SQLite:** `sum()` promotes to BIGINT to avoid overflow, falling back to REAL only when types are mixed.

---

## Window Functions

All aggregate functions above can be used as window functions with an `OVER` clause. Quereus also provides dedicated ranking functions.

**Syntax:**
```sql
function([args]) over (
  [partition by expr [, ...]]
  [order by expr [asc | desc] [, ...]]
)
```

### Ranking Functions

| Function | Returns | Description |
|---|---|---|
| `row_number()` | INTEGER | Sequential number within partition |
| `rank()` | INTEGER | Rank with gaps on ties (1, 1, 3, 4) |
| `dense_rank()` | INTEGER | Rank without gaps (1, 1, 2, 3) |
| `ntile(N)` | INTEGER | Distribute rows into N buckets |

```sql
select
  name,
  department,
  salary,
  row_number() over (partition by department order by salary desc) as dept_rank,
  rank() over (order by salary desc) as overall_rank
from employees;
```

### Aggregate Window Examples

```sql
select
  name,
  salary,
  sum(salary) over (partition by department order by hire_date) as running_total,
  avg(salary) over (partition by department) as dept_avg,
  count(*) over (partition by department) as dept_size
from employees;
```

---

## Date/Time Functions

These functions manipulate date and time values using the `Temporal` polyfill. The single-argument forms documented in [Type Conversion Functions](#type-conversion-functions) handle simple conversions; the multi-argument forms below apply date arithmetic via modifiers.

See [datetime.md](datetime.md) for supported timestring formats and modifier syntax.

### Core Functions

| Function | Returns | Description |
|---|---|---|
| `date(timestring, modifier, ...)` | TEXT | Date as `YYYY-MM-DD` after applying modifiers |
| `time(timestring, modifier, ...)` | TEXT | Time as `HH:MM:SS` after applying modifiers |
| `datetime(timestring, modifier, ...)` | TEXT | Datetime as `YYYY-MM-DD HH:MM:SS` after applying modifiers |
| `julianday(timestring, modifier, ...)` | REAL | Julian day number |
| `strftime(format, timestring, modifier, ...)` | TEXT | Formatted datetime (supports `%E` epoch_s, `%Q` epoch_ms) |

```sql
select date('2024-01-15', '+7 days');     -- '2024-01-22'
select time('14:30:15', '+15 minutes');    -- '14:45:15'
select datetime('now', '-1 hour');         -- current time minus 1 hour
select strftime('%Y-%m-%d %H:%M', 'now');
```

**Modifiers:** `'+N days'`, `'-N hours'`, `'start of month'`, `'start of year'`, `'start of day'`, `'weekday N'`, `'unixepoch'`, `'localtime'`, `'utc'`, `'subsec'`.

The **`subsec`** modifier includes milliseconds in `datetime()` and `time()` output:

```sql
select datetime('2024-07-26 12:30:45.123', 'subsec');
-- '2024-07-26 12:30:45.123'
```

### Epoch Functions

Strict parsing -- only ISO 8601 strings and `'now'` accepted; bare numbers rejected. Output is always UTC-relative.

| Function | Returns | Description |
|---|---|---|
| `epoch_s(timestring, modifier, ...)` | INTEGER | Unix epoch seconds |
| `epoch_ms(timestring, modifier, ...)` | INTEGER | Unix epoch milliseconds |
| `epoch_s_frac(timestring, modifier, ...)` | REAL | Unix epoch seconds with fractional precision |

```sql
select epoch_s('2024-01-01 00:00:00');       -- 1704067200
select epoch_ms('2024-07-26 12:30:45.123');  -- 1721997045123
select epoch_s_frac('2024-07-26 12:30:45.5');-- 1721997045.5
```

### Validation Functions

| Function | Returns | Description |
|---|---|---|
| `IsISODate(text)` | INTEGER | 1 if valid `YYYY-MM-DD` (leap-year aware), 0 otherwise |
| `IsISODateTime(text)` | INTEGER | 1 if valid ISO 8601 datetime with `T` separator, 0 otherwise |

```sql
select IsISODate('2024-02-29');         -- 1 (leap year)
select IsISODate('2023-02-29');         -- 0
select IsISODateTime('2024-01-01T00:00:00Z'); -- 1
select IsISODateTime('2024-01-01 00:00:00');  -- 0 (space not allowed)
```

---

## Timespan Functions

Extract components or convert TIMESPAN values to different units. All accept an ISO 8601 duration string.

### Component Extraction

| Function | Returns | Description |
|---|---|---|
| `timespan_years(ts)` | INTEGER | Years component |
| `timespan_months(ts)` | INTEGER | Months component |
| `timespan_weeks(ts)` | INTEGER | Weeks component |
| `timespan_days(ts)` | INTEGER | Days component |
| `timespan_hours(ts)` | INTEGER | Hours component |
| `timespan_minutes(ts)` | INTEGER | Minutes component |
| `timespan_seconds(ts)` | REAL | Seconds component (includes fractional) |

```sql
select timespan_years(timespan('1 year 2 months'));   -- 1
select timespan_months(timespan('1 year 2 months'));  -- 2
select timespan_seconds(timespan('1 minute 30.5 seconds')); -- 30.5
```

### Total Conversion

Convert entire timespan to a single unit (uses a reference date for calendar units).

| Function | Returns | Description |
|---|---|---|
| `timespan_total_seconds(ts)` | REAL | Total duration in seconds |
| `timespan_total_minutes(ts)` | REAL | Total duration in minutes |
| `timespan_total_hours(ts)` | REAL | Total duration in hours |
| `timespan_total_days(ts)` | REAL | Total duration in days |

```sql
select timespan_total_seconds(timespan('1 hour'));       -- 3600
select timespan_total_minutes(timespan('1 hour 30 minutes')); -- 90
select timespan_total_days(timespan('1 week'));           -- 7
```

---

## JSON Functions

JSON paths use `$` as root, `.key` for object members, and `[N]` for array indices (e.g., `$.phones[0].type`). Invalid JSON input typically returns `NULL`.

### Inspection

| Function | Args | Returns | Description |
|---|---|---|---|
| `json_valid(json)` | 1 | INTEGER | 1 if well-formed JSON, 0 otherwise |
| `json_type(json, path?)` | 1-2 | TEXT | JSON type: `'null'`, `'true'`, `'false'`, `'integer'`, `'real'`, `'text'`, `'array'`, `'object'` |
| `json_extract(json, path, ...)` | variadic | any | Extract value at first matching path. Arrays/objects returned as TEXT |
| `json_array_length(json, path?)` | 1-2 | INTEGER | Length of JSON array (0 if not an array) |

```sql
select json_valid('{"a":1}');           -- 1
select json_type('{"a":1}', '$.a');     -- 'integer'
select json_extract('{"a":[1,2]}', '$.a[1]'); -- 2
select json_array_length('[1,2,3]');    -- 3
```

### Construction

| Function | Args | Returns | Description |
|---|---|---|---|
| `json_quote(value)` | 1 | TEXT | SQL value as JSON literal (`NULL` becomes `'null'`, TEXT becomes quoted string) |
| `json_array(V1, V2, ...)` | variadic | TEXT | Build a JSON array from SQL values |
| `json_object(N1, V1, ...)` | variadic | TEXT | Build a JSON object from key/value pairs |

```sql
select json_quote('hello');              -- '"hello"'
select json_array(1, 'two', null);       -- '[1,"two",null]'
select json_object('name', 'Alice', 'age', 30); -- '{"name":"Alice","age":30}'
```

### Mutation

All mutation functions operate on a copy and return the modified JSON string.

| Function | Behavior |
|---|---|
| `json_insert(json, path, value, ...)` | Insert only where path **does not exist** |
| `json_replace(json, path, value, ...)` | Replace only where path **already exists** |
| `json_set(json, path, value, ...)` | Insert or replace (creates intermediate nodes, pads arrays with `null`) |
| `json_remove(json, path, ...)` | Remove elements at paths. Non-existent paths ignored |

```sql
select json_insert('{"a":1}', '$.b', 2);        -- '{"a":1,"b":2}'
select json_insert('{"a":1}', '$.a', 99);        -- '{"a":1}' (no overwrite)
select json_replace('{"a":1,"b":2}', '$.a', 10); -- '{"a":10,"b":2}'
select json_set('{"a":1}', '$.a', 10, '$.b', 20);-- '{"a":10,"b":20}'
select json_set('[1]', '$[2]', 3);                -- '[1,null,3]'
select json_remove('{"a":1,"b":2}', '$.b');       -- '{"a":1}'
```

### JSON Patch (RFC 6902)

**`json_patch(json, patch)`** -- Applies a JSON Patch operation array to the document.

```sql
select json_patch('{"a":1}', '[{"op":"add","path":"/b","value":2}]');
-- '{"a":1,"b":2}'
```

### Schema Validation

**`json_schema(json, schema_definition)`** -- Validates JSON against a TypeScript-like structural schema (powered by [moat-maker](https://github.com/theScottyJam/moat-maker)). Returns 1 if valid, 0 otherwise.

**Schema syntax:**
- Base types: `number`, `string`, `boolean`, `null`, `any`
- Arrays: `type[]` e.g. `number[]`
- Objects: `{ prop: type }` e.g. `{ x: number, y?: string }`
- Unions: `type1 | type2`
- Tuples: `[type1, type2]`
- Nested: `{ x: number }[]`

When the schema argument is a constant (e.g., in CHECK constraints), the validator is compiled once and cached with the query plan.

```sql
select json_schema('[1, 2, 3]', 'number[]');  -- 1
select json_schema('{"x":42}', '{ x: number }'); -- 1
select json_schema('[1,"mixed"]', 'number[]');    -- 0

create table events (
  id integer primary key,
  data json check (json_schema(data, '{ x: number, y: number }[]'))
);
```

### JSON Table-Valued Functions

**`json_each(json, path?)`** -- Returns one row per element of the JSON array/object at the given path (or root).

**`json_tree(json, path?)`** -- Like `json_each`, but recursively walks the tree (parent before children).

Both return the same columns:

| Column | Type | Description |
|---|---|---|
| `key` | TEXT? | Array index or property name |
| `value` | TEXT? | JSON value as text |
| `type` | TEXT | `'null'`, `'true'`, `'false'`, `'integer'`, `'real'`, `'text'`, `'array'`, `'object'` |
| `atom` | TEXT? | Scalar value; `NULL` for arrays/objects |
| `id` | INTEGER | Unique element ID |
| `parent` | INTEGER? | Parent element ID |
| `fullkey` | TEXT | Full JSON path to this element |
| `path` | TEXT | JSON path to parent |

```sql
select key, value from json_each('[10, 20, 30]');
select fullkey, type from json_tree('{"a": [1, 2]}');
```

---

## Schema Introspection (TVFs)

| Function | Args | Description |
|---|---|---|
| `schema()` | 0 | All schema objects (tables, views, indexes, functions) |
| `table_info(table_name)` | 1 | Column details for a specific table |
| `function_info(name?)` | 0-1 | All registered functions, or only those matching `name` (case-insensitive) |

### `schema()` columns

| Column | Type | Description |
|---|---|---|
| `type` | TEXT | `'table'`, `'view'`, `'index'`, `'function'` |
| `name` | TEXT | Object name |
| `tbl_name` | TEXT | Associated table name |
| `sql` | TEXT? | SQL definition |

### `table_info(table_name)` columns

| Column | Type | Description |
|---|---|---|
| `cid` | INTEGER | Column index (0-based) |
| `name` | TEXT | Column name |
| `type` | TEXT | Column type |
| `notnull` | INTEGER | 1 if NOT NULL |
| `dflt_value` | TEXT? | Default value |
| `pk` | INTEGER | 1 if primary key |

### `function_info()` columns

| Column | Type | Description |
|---|---|---|
| `name` | TEXT | Function name |
| `num_args` | INTEGER | Argument count (-1 = variadic) |
| `type` | TEXT | `'scalar'`, `'aggregate'`, `'table'`, `'window'` |
| `deterministic` | INTEGER | 1 if deterministic |
| `flags` | INTEGER | Internal flags |
| `signature` | TEXT | Display signature |

```sql
select type, name from schema() where type = 'table';
select name, type, notnull from table_info('users');
select name, type from function_info() where type = 'scalar';
select * from function_info('abs');
```

---

## Debug/Explain Functions (TVFs)

These table-valued functions provide query introspection and execution tracing. Primarily for development and debugging.

| Function | Args | Description |
|---|---|---|
| `query_plan(sql)` | 1 | Query execution plan tree |
| `scheduler_program(sql)` | 1 | Compiled instruction sequence |
| `stack_trace(sql)` | 1 | Execution stack trace |
| `execution_trace(sql)` | 1 | Instruction-level trace with timing. Non-deterministic |
| `row_trace(sql)` | 1 | Row-level data flow trace. Non-deterministic |
| `explain_assertion(name)` | 1 | Assertion analysis: classification, prepared PK params, violation SQL |

```sql
select id, op, detail from query_plan('select * from users where age > 25');
select addr, description from scheduler_program('select 1 + 1');
```

### `explain_assertion(name)` columns

| Column | Type | Description |
|---|---|---|
| `assertion` | TEXT | Assertion name |
| `relation_key` | TEXT | Instance-unique table reference (e.g., `main.users#17`) |
| `base` | TEXT | Base table name (e.g., `main.users`) |
| `classification` | TEXT | `'row'` if row-specific (PK fully covered), else `'global'` |
| `prepared_pk_params` | TEXT? | JSON array of parameter names when row-specific |
| `violation_sql` | TEXT | Stored violation query |

---

## Generation Functions (TVFs)

**`generate_series(start, stop)`** -- Generates integers from `start` to `stop` (inclusive), step 1.

Returns a single column `value` (INTEGER).

```sql
select * from generate_series(1, 5);
-- 1, 2, 3, 4, 5
```
