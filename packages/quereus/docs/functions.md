# Built-in Functions Reference

This document lists the built-in SQL functions available in Quereus.

## Table-Valued Functions

Table-valued functions (TVFs) can be used in the `FROM` clause of a `SELECT` statement to generate rows dynamically. They are called like regular functions but return a table result that can be queried like any other table.

**Syntax:** `SELECT columns FROM function_name(arguments) [AS alias]`

**Example:** `SELECT * FROM generate_series(1, 10);`

### Generation Functions

*   `generate_series(start, stop)`, `generate_series(start, stop, step)`
    *   **Description:** Generates a series of integer values from `start` to `stop` (inclusive) with an optional `step` increment.
    *   **Arguments:** `start` (INTEGER), `stop` (INTEGER), `step` (INTEGER, optional, defaults to 1).
    *   **Returns:** A table with a single column `value` containing the generated integers.
    *   **Example:** `SELECT * FROM generate_series(1, 5);` returns rows with values 1, 2, 3, 4, 5. `SELECT * FROM generate_series(0, 10, 2);` returns 0, 2, 4, 6, 8, 10.

### JSON Processing Functions

*   `json_each(json)`, `json_each(json, path)`
    *   **Description:** Returns a table with one row for each element in the JSON array or object at the specified path. If no path is provided, processes the root JSON value.
    *   **Arguments:** `json` (TEXT - valid JSON string), `path` (TEXT, optional - JSON path like '$.data').
    *   **Returns:** A table with columns:
        *   `key` (TEXT, nullable) - Array index (for arrays) or property name (for objects)
        *   `value` (TEXT, nullable) - The JSON value as text
        *   `type` (TEXT) - JSON type: 'null', 'true', 'false', 'integer', 'real', 'text', 'array', 'object'
        *   `atom` (TEXT, nullable) - For scalar values, the actual value; null for arrays/objects
        *   `id` (INTEGER) - Unique identifier for this element
        *   `parent` (INTEGER, nullable) - ID of the parent element
        *   `fullkey` (TEXT) - Full JSON path to this element
        *   `path` (TEXT) - JSON path to the parent element
    *   **Example:** `SELECT key, value FROM json_each('[10, 20, {"a": 30}]');` returns rows for each array element.

*   `json_tree(json)`, `json_tree(json, path)`
    *   **Description:** Similar to `json_each`, but returns a hierarchical tree view where parent elements are returned before their children.
    *   **Arguments:** `json` (TEXT - valid JSON string), `path` (TEXT, optional - JSON path like '$.nested').
    *   **Returns:** Same columns as `json_each`, but in tree traversal order.
    *   **Example:** `SELECT fullkey, type FROM json_tree('{"a": [1, 2]}');` returns the object first, then the array, then each array element.

## Scalar Functions

These functions operate on single values and return a single value.

*   `abs(X)`
    *   **Description:** Returns the absolute value of the numeric argument X.
    *   **Arguments:** `X` (Numeric: INTEGER, REAL, or convertible TEXT/BOOLEAN).
    *   **Returns:** The absolute value of X. The result type is typically REAL, but may be INTEGER/BIGINT if the input is an integer/bigint within range. Returns `NULL` if X is `NULL` or cannot be interpreted as a number.
    *   **Example:** `abs(-5)` returns `5`, `abs(3.14)` returns `3.14`.

*   `ceil(X)`, `ceiling(X)`
    *   **Description:** Returns the smallest integer value that is not less than X (rounds up towards positive infinity). `ceiling` is an alias for `ceil`.
    *   **Arguments:** `X` (Numeric).
    *   **Returns:** An integer (or REAL if result large) representing the ceiling of X. Returns `NULL` if X is `NULL` or non-numeric.
    *   **Example:** `ceil(4.2)` returns `5`, `ceil(-4.8)` returns `-4`.

*   `coalesce(X, Y, ...)`
    *   **Description:** Returns a copy of its first non-NULL argument. If all arguments are `NULL`, it returns `NULL`. Requires at least one argument.
    *   **Arguments:** `X, Y, ...` (Any type).
    *   **Returns:** The first non-NULL argument value.
    *   **Example:** `coalesce(NULL, 5, 'hello')` returns `5`.

*   `floor(X)`
    *   **Description:** Returns the largest integer value that is not greater than X (rounds down towards negative infinity).
    *   **Arguments:** `X` (Numeric).
    *   **Returns:** An integer (or REAL if result large) representing the floor of X. Returns `NULL` if X is `NULL` or non-numeric.
    *   **Example:** `floor(4.8)` returns `4`, `floor(-4.2)` returns `-5`.

*   `glob(pattern, string)`
    *   **Description:** Checks if `string` matches the GLOB `pattern`. GLOB is similar to wildcard matching in shells. Case-sensitive.
    *   **Arguments:** `pattern` (TEXT), `string` (TEXT).
    *   **Wildcards:** `*` matches any sequence of zero or more characters. `?` matches any single character. (Character sets `[]` are not fully supported).
    *   **Returns:** `1` (true) if `string` matches `pattern`, `0` (false) otherwise. Returns `NULL` if either argument is `NULL`.
    *   **Example:** `glob('*.txt', 'report.txt')` returns `1`, `glob('user?', 'userA')` returns `1`, `glob('data', 'Data')` returns `0`.

*   `iif(X, Y, Z)`
    *   **Description:** If expression X is true (evaluates to a non-zero numeric value), returns Y. Otherwise (if X is false, zero, or NULL), returns Z.
    *   **Arguments:** `X` (Any type, evaluated for truthiness), `Y` (Any type), `Z` (Any type).
    *   **Truthiness:** Numeric values are true if non-zero. Strings are coerced to numbers if possible. NULL is false.
    *   **Returns:** The value of Y or Z depending on X.
    *   **Example:** `iif(1 > 0, 'yes', 'no')` returns `'yes'`, `iif(0, 10, 20)` returns `20`.

*   `IsISODate(text)`
    *   **Description:** Validates whether `text` is a strict ISO-8601 calendar date in `YYYY-MM-DD` format (e.g., leap years respected). No time or timezone components are allowed.
    *   **Arguments:** `text` (TEXT).
    *   **Returns:** INTEGER: `1` if valid, `0` otherwise.
    *   **Examples:** `IsISODate('2024-02-29')` returns `1`; `IsISODate('2023-02-29')` returns `0`.

*   `IsISODateTime(text)`
    *   **Description:** Validates whether `text` is a strict ISO-8601 date-time. Supported forms:
        - `YYYY-MM-DDTHH:MM`
        - `YYYY-MM-DDTHH:MM:SS`
        - With fractional seconds up to 9 digits: `YYYY-MM-DDTHH:MM:SS.s{1..9}`
        - Optional timezone: `Z` or `±HH:MM`
      A space between date and time is not accepted; must use `T`.
    *   **Arguments:** `text` (TEXT).
    *   **Returns:** INTEGER: `1` if valid, `0` otherwise.
    *   **Examples:**
        - `IsISODateTime('2024-01-01T00:00')` → `1`
        - `IsISODateTime('2024-01-01T00:00:00Z')` → `1`
        - `IsISODateTime('2024-01-01T23:59:59+05:30')` → `1`
        - `IsISODateTime('2024-01-01 00:00:00')` → `0` (space not allowed)
        - `IsISODateTime('2024-01-01T10:00:00.123456789')` → `1`
        - `IsISODateTime('2024-01-01T10:00:00.1234567890')` → `0` (too many fraction digits)

*   `instr(X, Y)`
    *   **Description:** Returns the 1-based index of the first occurrence of string Y within string X. Case-sensitive.
    *   **Arguments:** `X` (TEXT), `Y` (TEXT).
    *   **Returns:** An INTEGER representing the starting position (1-based). Returns `0` if Y is not found within X, or if either argument is `NULL`, or if Y is an empty string.
    *   **Example:** `instr('Quereus', 'reus')` returns `4`, `instr('banana', 'a')` returns `2`, `instr('apple', 'z')` returns `0`.

*   `length(X)`
    *   **Description:** Returns the length of string X in characters or the size of blob X in bytes.
    *   **Arguments:** `X` (TEXT or BLOB).
    *   **Returns:** An INTEGER representing the length/size. Returns `NULL` if X is `NULL` or a type other than TEXT or BLOB.
    *   **Example:** `length('hello')` returns `5`.

*   `like(pattern, string)`
    *   **Description:** Checks if `string` matches the LIKE `pattern`. Case-sensitive by default.
    *   **Arguments:** `pattern` (TEXT), `string` (TEXT).
    *   **Wildcards:** `%` matches any sequence of zero or more characters. `_` matches any single character.
    *   **Note:** The `ESCAPE` clause is not currently implemented.
    *   **Returns:** `1` (true) if `string` matches `pattern`, `0` (false) otherwise. Returns `NULL` if either argument is `NULL`.
    *   **Example:** `like('St%', 'Start')` returns `1`, `like('_pple', 'Apple')` returns `1`, `like('Data', 'data')` returns `0`.

*   `lower(X)`
    *   **Description:** Returns the lowercase equivalent of string X.
    *   **Arguments:** `X` (TEXT).
    *   **Returns:** The lowercase TEXT string. Returns `NULL` if X is `NULL` or not a string.
    *   **Example:** `lower('Quereus')` returns `'quereus'`.

*   `ltrim(X)`, `ltrim(X, Y)`
    *   **Description:** Removes leading characters from string X. If Y is omitted, removes leading whitespace. If Y is provided, removes any character present in string Y from the beginning of X.
    *   **Arguments:** `X` (TEXT), `Y` (Optional, TEXT).
    *   **Returns:** The trimmed TEXT string.
    *   **Example:** `ltrim('  abc')` returns `'abc'`, `ltrim('**abc**', '*')` returns `'abc**'`, `ltrim('123abc123', '0123456789')` returns `'abc123'`.

*   `nullif(X, Y)`
    *   **Description:** Returns `NULL` if X is logically equal to Y according to standard SQL comparison rules (considering type affinity). Otherwise, returns X.
    *   **Arguments:** `X` (Any type), `Y` (Any type).
    *   **Returns:** `NULL` or the value of X.
    *   **Example:** `nullif(10, 10)` returns `NULL`, `nullif(10, 20)` returns `10`, `nullif('abc', 'ABC')` returns `'abc'`.

*   `pow(X, Y)`, `power(X, Y)`
    *   **Description:** Returns X raised to the power of Y. `power` is an alias for `pow`.
    *   **Arguments:** `X` (Numeric), `Y` (Numeric).
    *   **Returns:** A REAL value representing X<sup>Y</sup>. Returns `NULL` if either argument is `NULL` or non-numeric.
    *   **Example:** `pow(2, 3)` returns `8.0`, `power(10, -1)` returns `0.1`.

*   `random()`
    *   **Description:** Returns a pseudo-random 64-bit signed integer.
    *   **Note:** The current implementation returns a pseudo-random BigInt within JavaScript's `Number.MIN_SAFE_INTEGER` to `Number.MAX_SAFE_INTEGER` range, not the full 64-bit range. This function is **not deterministic**.
    *   **Arguments:** None.
    *   **Returns:** A BIGINT value.
    *   **Example:** `random()` might return `-123456789012345n` or `98765432109876n`.

*   `randomblob(N)`
    *   **Description:** Returns an N-byte blob containing pseudo-random bytes.
    *   **Arguments:** `N` (INTEGER).
    *   **Returns:** A BLOB of size N. Returns an empty blob (zero length) if N is not a positive integer. Returns `NULL` if N is `NULL`. Size is capped internally (e.g., at 1MB) for safety. This function is **not deterministic**.
    *   **Example:** `length(randomblob(16))` returns `16`.

*   `replace(X, Y, Z)`
    *   **Description:** Replaces all occurrences of substring Y in string X with string Z. Performs simple substring replacement, not regular expressions. Case-sensitive.
    *   **Arguments:** `X` (TEXT), `Y` (TEXT - pattern to find), `Z` (TEXT - replacement).
    *   **Returns:** The modified TEXT string. Returns `NULL` if any argument is `NULL`. If Y is empty, returns X unchanged.
    *   **Example:** `replace('abc abc', 'b', 'X')` returns `'aXc aXc'`, `replace('test', '', 'X')` returns `'test'`.

*   `round(X)`, `round(X, Y)`
    *   **Description:** Rounds the numeric value X to Y decimal places. If Y is omitted, rounds to 0 decimal places (nearest integer).
    *   **Arguments:** `X` (Numeric), `Y` (Optional, INTEGER - number of decimal places).
    *   **Returns:** A REAL or INTEGER value representing the rounded number. Returns `NULL` if X or Y is `NULL` or non-numeric.
    *   **Example:** `round(123.456)` returns `123.0`, `round(123.456, 2)` returns `123.46`, `round(123.456, -1)` returns `120.0`.

*   `rtrim(X)`, `rtrim(X, Y)`
    *   **Description:** Removes trailing characters from string X. If Y is omitted, removes trailing whitespace. If Y is provided, removes any character present in string Y from the end of X.
    *   **Arguments:** `X` (TEXT), `Y` (Optional, TEXT).
    *   **Returns:** The trimmed TEXT string.
    *   **Example:** `rtrim('abc  ')` returns `'abc'`, `rtrim('**abc**', '*')` returns `'**abc'`, `rtrim('abc123abc', 'abc')` returns `'abc123'`.

*   `sqrt(X)`
    *   **Description:** Returns the square root of numeric value X.
    *   **Arguments:** `X` (Numeric).
    *   **Returns:** A REAL value. Returns `NULL` if X is `NULL`, non-numeric, or negative.
    *   **Example:** `sqrt(16)` returns `4.0`, `sqrt(2)` returns `1.41421356...`.

*   `substr(X, Y, Z?)`, `substring(X, Y, Z?)`
    *   **Description:** Returns a substring of string X starting at the Y-th character and Z characters long. `substring` is an alias for `substr`.
    *   **Arguments:**
        *   `X` (TEXT).
        *   `Y` (INTEGER - start position, 1-based). If positive, starts from the beginning. If negative, starts from the end (-1 is the last character).
        *   `Z` (Optional, INTEGER - length). If omitted, returns the rest of the string. If negative, returns an empty string.
    *   **Returns:** The extracted TEXT substring. Returns `NULL` if X or Y is `NULL`, or if Y or Z is non-integer.
    *   **Example:** `substr('SQLite', 1, 3)` returns `'SQL'`, `substr('SQLite', -4)` returns `'Lite'`, `substr('SQLite', 4, 2)` returns `'it'`, `substr('SQLite', 4, -1)` returns `''`.

*   `trim(X)`, `trim(X, Y)`
    *   **Description:** Removes leading and trailing characters from string X. If Y is omitted, removes whitespace. If Y is provided, removes any character present in string Y from both ends of X.
    *   **Arguments:** `X` (TEXT), `Y` (Optional, TEXT).
    *   **Returns:** The trimmed TEXT string.
    *   **Example:** `trim('  abc  ')` returns `'abc'`, `trim('*+-abc*+-', '+-*')` returns `'abc'`.

*   `typeof(X)`
    *   **Description:** Returns the fundamental datatype name of the expression X.
    *   **Arguments:** `X` (Any type).
    *   **Returns:** A TEXT value: `'null'`, `'integer'`, `'real'`, `'text'`, or `'blob'`.
    *   **Example:** `typeof(10)` returns `'integer'`, `typeof(10.5)` returns `'real'`, `typeof('hello')` returns `'text'`, `typeof(NULL)` returns `'null'`, `typeof(x'01')` returns `'blob'`.

*   `upper(X)`
    *   **Description:** Returns the uppercase equivalent of string X.
    *   **Arguments:** `X` (TEXT).
    *   **Returns:** The uppercase TEXT string. Returns `NULL` if X is `NULL` or not a string.
    *   **Example:** `upper('Sqlite')` returns `'SQLITE'`.

## Aggregate Functions

These functions compute a single result from multiple input rows within a group (defined by `GROUP BY` or the entire set if no `GROUP BY` is present).

*   `avg(X)`
    *   **Description:** Returns the average value of all non-NULL X within a group.
    *   **Arguments:** `X` (Numeric). Non-numeric values are ignored.
    *   **Returns:** A REAL value representing the average. Returns `NULL` if the group contains no non-NULL numeric values.
    *   **Example:** `SELECT avg(score) FROM results;`

*   `count()` or `count(*)`
    *   **Description:** Returns the total number of rows in the group, regardless of NULL values.
    *   **Arguments:** None (when using `*`) or optional expression (see `count(X)`).
    *   **Returns:** An INTEGER.
    *   **Example:** `SELECT count(*) FROM users;`

*   `count(X)`
    *   **Description:** Returns the number of times expression X evaluates to a non-NULL value within the group.
    *   **Arguments:** `X` (Any type).
    *   **Returns:** An INTEGER.
    *   **Example:** `SELECT count(email) FROM users;` (Counts users with a non-null email).

*   `group_concat(X)`, `group_concat(X, Y)`
    *   **Description:** Returns a string which is the concatenation of all non-NULL X values in the group. Values are separated by string Y. If Y is omitted, the separator defaults to a comma (`,`). The order of concatenation is arbitrary unless an `ORDER BY` clause is used within the aggregate function call (not standard SQL, but sometimes supported).
    *   **Arguments:** `X` (Any type, coerced to TEXT), `Y` (Optional, TEXT - separator).
    *   **Returns:** A TEXT string. Returns `NULL` if the group contains no non-NULL X values.
    *   **Example:** `SELECT group_concat(name) FROM users WHERE country = 'US';` might return `'Alice,Bob,Charlie'`, `SELECT group_concat(name, '; ') FROM users;` might return `'Alice; Bob; Charlie; David'`.

*   `json_group_array(X)`
    *   **Description:** Returns a JSON array containing all values (including SQL `NULL`s, converted to JSON `null`) in the group. The order is arbitrary.
    *   **Arguments:** `X` (Any type). Values are converted to JSON-compatible types (see `json_quote`).
    *   **Returns:** A TEXT string containing a valid JSON array. Returns `NULL` if the group is empty.
    *   **Example:** `SELECT json_group_array(score) FROM results;` might return `'[95, 80, null, 95]'`.

*   `json_group_object(N, V)`
    *   **Description:** Returns a JSON object composed of key/value pairs from N (name) and V (value) columns in the group. The order of keys is arbitrary. Rows where N is `NULL` or not TEXT are skipped. SQL `NULL` values for V are converted to JSON `null`. If duplicate keys (N) exist, the value associated with an arbitrarily chosen key instance is used.
    *   **Arguments:** `N` (TEXT - key name), `V` (Any type - value).
    *   **Returns:** A TEXT string containing a valid JSON object. Returns `NULL` if the group results in no valid key/value pairs.
    *   **Example:** `SELECT json_group_object(setting_key, setting_value) FROM config;` might return `'{"theme": "dark", "fontSize": 12}'`.

*   `max(X)`
    *   **Description:** Returns the maximum value of all non-NULL X within a group. Comparison uses standard SQL rules (considering affinity).
    *   **Arguments:** `X` (Any comparable type).
    *   **Returns:** A value of the same type affinity as the inputs. Returns `NULL` if the group contains only `NULL` values.
    *   **Example:** `SELECT max(salary) FROM employees;`, `SELECT max(last_updated) FROM documents;`.

*   `min(X)`
    *   **Description:** Returns the minimum value of all non-NULL X within a group. Comparison uses standard SQL rules (considering affinity).
    *   **Arguments:** `X` (Any comparable type).
    *   **Returns:** A value of the same type affinity as the inputs. Returns `NULL` if the group contains only `NULL` values.
    *   **Example:** `SELECT min(order_date) FROM orders;`.

*   `stddev_pop(X)`
    *   **Description:** Returns the **population** standard deviation of all non-NULL numeric values in the group.
    *   **Arguments:** `X` (Numeric). Non-numeric values are ignored.
    *   **Returns:** A REAL value. Returns `NULL` if the group contains fewer than one non-NULL numeric value.
    *   **Example:** `SELECT stddev_pop(test_score) FROM students;`

*   `stddev_samp(X)`
    *   **Description:** Returns the **sample** standard deviation of all non-NULL numeric values in the group.
    *   **Arguments:** `X` (Numeric). Non-numeric values are ignored.
    *   **Returns:** A REAL value. Returns `NULL` if the group contains fewer than two non-NULL numeric values.
    *   **Example:** `SELECT stddev_samp(response_time_ms) FROM logs;`

*   `sum(X)`
    *   **Description:** Returns the sum of all non-NULL values in the group.
    *   **Arguments:** `X` (Numeric). Non-numeric values are ignored.
    *   **Returns:** An INTEGER or BIGINT if all inputs are integers and the sum does not overflow. Otherwise, returns a REAL. Returns `NULL` if the group contains no non-NULL numeric values.
    *   **Example:** `SELECT sum(quantity) FROM order_items;`

*   `total(X)`
    *   **Description:** Returns the sum of all non-NULL values in the group. Similar to `sum(X)`, but the result is **always** a REAL value.
    *   **Arguments:** `X` (Numeric). Non-numeric values are ignored.
    *   **Returns:** A REAL value. Returns `0.0` if the group contains no non-NULL numeric values (unlike `sum` which returns `NULL`).
    *   **Example:** `SELECT total(amount) FROM transactions;`

*   `var_pop(X)`
    *   **Description:** Returns the **population** variance of all non-NULL numeric values in the group.
    *   **Arguments:** `X` (Numeric). Non-numeric values are ignored.
    *   **Returns:** A REAL value. Returns `NULL` if the group contains fewer than one non-NULL numeric value.
    *   **Example:** `SELECT var_pop(height_cm) FROM measurements;`

*   `var_samp(X)`
    *   **Description:** Returns the **sample** variance of all non-NULL numeric values in the group.
    *   **Arguments:** `X` (Numeric). Non-numeric values are ignored.
    *   **Returns:** A REAL value. Returns `NULL` if the group contains fewer than two non-NULL numeric values.
    *   **Example:** `SELECT var_samp(weight_kg) FROM participants;`

## Type Conversion Functions

Quereus uses conversion functions instead of the CAST operator for type conversions. These functions validate input and convert values to the target type.

*   `integer(X)`
    *   **Description:** Converts value X to INTEGER type.
    *   **Arguments:** `X` (Any type).
    *   **Returns:** INTEGER value. Strings are parsed as integers, booleans become 0/1, numbers are truncated. Returns `NULL` if X is `NULL` or cannot be converted.
    *   **Example:** `integer('42')` returns `42`, `integer(3.14)` returns `3`, `integer(true)` returns `1`.

*   `real(X)`
    *   **Description:** Converts value X to REAL (floating-point) type.
    *   **Arguments:** `X` (Any type).
    *   **Returns:** REAL value. Strings are parsed as numbers, booleans become 0.0/1.0. Returns `NULL` if X is `NULL` or cannot be converted.
    *   **Example:** `real('3.14')` returns `3.14`, `real(42)` returns `42.0`, `real(false)` returns `0.0`.

*   `text(X)`
    *   **Description:** Converts value X to TEXT type.
    *   **Arguments:** `X` (Any type).
    *   **Returns:** TEXT string representation. Numbers become strings, booleans become 'true'/'false', BLOBs are hex-encoded. Returns `NULL` if X is `NULL`.
    *   **Example:** `text(42)` returns `'42'`, `text(true)` returns `'true'`.

*   `boolean(X)`
    *   **Description:** Converts value X to BOOLEAN type.
    *   **Arguments:** `X` (Any type).
    *   **Returns:** BOOLEAN value. Numbers: 0 is false, non-zero is true. Strings: 'true'/'1' are true, 'false'/'0' are false. Returns `NULL` if X is `NULL` or cannot be converted.
    *   **Example:** `boolean(1)` returns `true`, `boolean('false')` returns `false`, `boolean(0)` returns `false`.

*   `date(X)`
    *   **Description:** Converts value X to DATE type (ISO 8601 date string).
    *   **Arguments:** `X` (TEXT or special value 'now').
    *   **Returns:** TEXT in `YYYY-MM-DD` format. Validates and normalizes date strings. Special value `'now'` returns current date.
    *   **Example:** `date('2024-01-15')` returns `'2024-01-15'`, `date('now')` returns current date.

*   `time(X)`
    *   **Description:** Converts value X to TIME type (ISO 8601 time string).
    *   **Arguments:** `X` (TEXT or special value 'now').
    *   **Returns:** TEXT in `HH:MM:SS` format. Validates and normalizes time strings. Special value `'now'` returns current time.
    *   **Example:** `time('14:30:00')` returns `'14:30:00'`, `time('now')` returns current time.

*   `datetime(X)`
    *   **Description:** Converts value X to DATETIME type (ISO 8601 datetime string).
    *   **Arguments:** `X` (TEXT or special value 'now').
    *   **Returns:** TEXT in `YYYY-MM-DDTHH:MM:SS` format. Validates and normalizes datetime strings. Special value `'now'` returns current timestamp.
    *   **Example:** `datetime('2024-01-15T14:30:00')` returns `'2024-01-15T14:30:00'`, `datetime('now')` returns current timestamp.

*   `timespan(X)`
    *   **Description:** Converts value X to TIMESPAN type (ISO 8601 duration string). Accepts ISO 8601 duration strings or human-readable duration strings.
    *   **Arguments:** `X` (TEXT - ISO 8601 duration or human-readable string like '1 hour 30 minutes').
    *   **Returns:** TEXT in ISO 8601 duration format (e.g., `'PT1H30M'`, `'P14D'`). Validates and normalizes duration strings.
    *   **Human-readable format:** Supports natural language like `'1 hour 30 minutes'`, `'2 weeks 3 days'`, `'45 minutes'`, etc.
    *   **ISO 8601 format:** Standard duration strings like `'PT1H30M'` (1 hour 30 minutes), `'P14D'` (14 days), `'PT2H'` (2 hours).
    *   **Arithmetic:** TIMESPAN values can be added to/subtracted from DATE, TIME, and DATETIME values, and can be added/subtracted with other TIMESPAN values.
    *   **Example:** `timespan('1 hour 30 minutes')` returns `'PT1H30M'`, `timespan('PT2H')` returns `'PT2H'`, `timespan('2 weeks')` returns `'P14D'`.

*   `json(X)`
    *   **Description:** Converts value X to JSON type (validated JSON string).
    *   **Arguments:** `X` (Any type).
    *   **Returns:** TEXT containing valid, normalized JSON. Validates JSON syntax and normalizes formatting. Non-JSON values are converted to JSON representation.
    *   **Example:** `json('{"x":1}')` returns `'{"x":1}'` (normalized), `json(42)` returns `'42'`, `json(true)` returns `'true'`.

**Note:** Quereus prefers conversion functions over the CAST operator. Use these functions for explicit type conversions.

## Date & Time Functions

These functions manipulate date and time values. They rely heavily on the underlying `Temporal` polyfill for parsing and calculations. See [Date/Time Handling](datetime.md) for details on supported `timestring` formats and `modifier` strings.

**Note:** The conversion functions `date()`, `time()`, and `datetime()` documented above are the recommended way to convert values to temporal types. The functions below provide additional date/time manipulation capabilities.

*   `date(timestring, modifier, ...)`
    *   **Description:** With modifiers: Returns the date in `YYYY-MM-DD` format after applying date arithmetic. Without modifiers: Acts as type conversion function (see Type Conversion Functions above).
    *   **Arguments:** `timestring` (TEXT or Numeric - see docs), `modifier` (Optional, TEXT, zero or more).
    *   **Returns:** A TEXT string or `NULL` on error.
    *   **Example:** `date('now')`, `date('2024-01-15', '+7 days')` returns `'2024-01-22'`.

*   `datetime(timestring, modifier, ...)`
    *   **Description:** With modifiers: Returns the date and time in `YYYY-MM-DDTHH:MM:SS` format after applying date arithmetic. Without modifiers: Acts as type conversion function (see Type Conversion Functions above).
    *   **Arguments:** `timestring`, `modifier` (Optional, zero or more).
    *   **Returns:** A TEXT string or `NULL` on error.
    *   **Example:** `datetime('now')`, `datetime('2024-01-15T10:30:00', '-1 hour')` returns `'2024-01-15T09:30:00'`.

*   `julianday(timestring, modifier, ...)`
    *   **Description:** Returns the Julian day number - the number of days since noon in Greenwich on November 24, 4714 B.C.
    *   **Arguments:** `timestring`, `modifier` (Optional, zero or more).
    *   **Returns:** A REAL value or `NULL` on error.
    *   **Example:** `julianday('2000-01-01 12:00:00')`.

*   `strftime(format, timestring, modifier, ...)`
    *   **Description:** Returns the date formatted according to the `format` string, after applying any modifiers to the `timestring`.
    *   **Arguments:** `format` (TEXT - see docs for specifiers like %Y, %m, %d), `timestring`, `modifier` (Optional, zero or more).
    *   **Returns:** A TEXT string or `NULL` on error.
    *   **Example:** `strftime('%Y-%m-%d %H:%M', 'now')`, `strftime('%W', '2024-01-15')` (Week number).

## Timespan Functions

These functions extract components or convert TIMESPAN values to different units.

### Extraction Functions

Extract individual components from a timespan:

*   `timespan_years(ts)`
    *   **Description:** Extracts the years component from a TIMESPAN.
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** INTEGER representing the years component.
    *   **Example:** `timespan_years(timespan('1 year 2 months'))` returns `1`.

*   `timespan_months(ts)`
    *   **Description:** Extracts the months component from a TIMESPAN.
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** INTEGER representing the months component.
    *   **Example:** `timespan_months(timespan('1 year 2 months'))` returns `2`.

*   `timespan_weeks(ts)`
    *   **Description:** Extracts the weeks component from a TIMESPAN.
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** INTEGER representing the weeks component.
    *   **Example:** `timespan_weeks(timespan('2 weeks 3 days'))` returns `2`.

*   `timespan_days(ts)`
    *   **Description:** Extracts the days component from a TIMESPAN.
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** INTEGER representing the days component.
    *   **Example:** `timespan_days(timespan('2 weeks 3 days'))` returns `3`.

*   `timespan_hours(ts)`
    *   **Description:** Extracts the hours component from a TIMESPAN.
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** INTEGER representing the hours component.
    *   **Example:** `timespan_hours(timespan('2 days 3 hours'))` returns `3`.

*   `timespan_minutes(ts)`
    *   **Description:** Extracts the minutes component from a TIMESPAN.
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** INTEGER representing the minutes component.
    *   **Example:** `timespan_minutes(timespan('1 hour 30 minutes'))` returns `30`.

*   `timespan_seconds(ts)`
    *   **Description:** Extracts the seconds component from a TIMESPAN (including fractional seconds).
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** REAL representing the seconds component.
    *   **Example:** `timespan_seconds(timespan('1 minute 30.5 seconds'))` returns `30.5`.

### Total Functions

Convert entire timespan to a single unit:

*   `timespan_total_seconds(ts)`
    *   **Description:** Converts the entire TIMESPAN to seconds.
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** REAL representing the total duration in seconds.
    *   **Example:** `timespan_total_seconds(timespan('1 hour'))` returns `3600`.

*   `timespan_total_minutes(ts)`
    *   **Description:** Converts the entire TIMESPAN to minutes.
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** REAL representing the total duration in minutes.
    *   **Example:** `timespan_total_minutes(timespan('1 hour 30 minutes'))` returns `90`.

*   `timespan_total_hours(ts)`
    *   **Description:** Converts the entire TIMESPAN to hours.
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** REAL representing the total duration in hours.
    *   **Example:** `timespan_total_hours(timespan('2 days'))` returns `48`.

*   `timespan_total_days(ts)`
    *   **Description:** Converts the entire TIMESPAN to days.
    *   **Arguments:** `ts` (TIMESPAN).
    *   **Returns:** REAL representing the total duration in days.
    *   **Example:** `timespan_total_days(timespan('1 week'))` returns `7`.

*   `time(timestring, modifier, ...)`
    *   **Description:** With modifiers: Returns the time in `HH:MM:SS` format after applying time arithmetic. Without modifiers: Acts as type conversion function (see Type Conversion Functions above).
    *   **Arguments:** `timestring`, `modifier` (Optional, zero or more).
    *   **Returns:** A TEXT string or `NULL` on error.
    *   **Example:** `time('now')`, `time('14:30:15', '+15 minutes')` returns `'14:45:15'`.

## JSON Functions

These functions operate on JSON values, typically represented as TEXT strings in SQL. JSON paths use dot (`.`) for object members and brackets (`[]`) for array indices (e.g., `$.name`, `$.phones[0].type`). Invalid JSON input often results in `NULL`.

*   `json_array(V1, V2, ...)`
    *   **Description:** Returns a TEXT string representing a JSON array containing the given SQL values. SQL values are converted to appropriate JSON types (`NULL` -> `null`, TEXT -> string, INTEGER/REAL -> number, BLOB -> `null`). BigInts are converted to numbers if safe, otherwise strings.
    *   **Arguments:** `V1, V2, ...` (Any SQL type).
    *   **Returns:** TEXT (JSON array string).
    *   **Example:** `json_array(1, 'two', null, json('[3,4]'))` returns `'[1,"two",null,[3,4]]'`.

*   `json_array_length(json)`, `json_array_length(json, path)`
    *   **Description:** Returns the number of elements in the JSON array found at the specified `path` within the `json` document. If `path` is omitted, returns the length of the top-level array.
    *   **Arguments:** `json` (TEXT - valid JSON), `path` (Optional, TEXT - JSON path).
    *   **Returns:** INTEGER. Returns `0` if the target value is not a JSON array, or if the path is invalid or does not exist. Returns `NULL` if `json` is not valid JSON.
    *   **Example:** `json_array_length('[1,2,3]')` returns `3`, `json_array_length('{"a":[1,2]}', '$.a')` returns `2`, `json_array_length('{"a":1}', '$.a')` returns `0`.

*   `json_extract(json, path, ...)`
    *   **Description:** Extracts and returns one or more values from the `json` document based on the JSON `path` arguments. It returns the value corresponding to the first path that successfully resolves to a value (even if that value is JSON `null`).
    *   **Arguments:** `json` (TEXT - valid JSON), `path` (TEXT - one or more JSON paths).
    *   **Returns:** The extracted value, converted to an appropriate SQL type: JSON null -> SQL `NULL`, JSON true/false -> INTEGER `1`/`0`, JSON number -> INTEGER or REAL, JSON string -> TEXT. JSON arrays/objects are returned as TEXT. Returns `NULL` if `json` is invalid, all paths are invalid, or no path resolves to a value.
    *   **Example:** `json_extract('{"a": 1, "b": [2, 3]}', '$.b[1]')` returns `3`, `json_extract('{"a": 1, "b": 2}', '$.c', '$.a')` returns `1`, `json_extract('{"a": [1,2]}', '$.a')` returns `'[1,2]'`.

*   `json_insert(json, path, value, ...)`
    *   **Description:** Inserts `value`(s) into the `json` document at the specified `path`(s), **only if the target path does not already exist**. Does not overwrite existing values. SQL `value`s are converted to JSON. Operates on a copy.
    *   **Arguments:** `json` (TEXT - valid JSON), `path` (TEXT), `value` (Any SQL type), ... (more path/value pairs).
    *   **Returns:** TEXT (modified JSON string) or `NULL` if `json` is invalid or arguments are malformed.
    *   **Example:** `json_insert('{"a":1}', '$.b', 2)` returns `'{"a":1,"b":2}'`, `json_insert('{"a":1}', '$.a', 99)` returns `'{"a":1}'`.

*   `json_object(N1, V1, N2, V2, ...)`
    *   **Description:** Returns a TEXT string representing a JSON object created from the key/value pairs. Keys (N) must be TEXT and non-NULL. Values (V) are converted to JSON.
    *   **Arguments:** `N1` (TEXT - key), `V1` (Any SQL type - value), ... (more key/value pairs).
    *   **Returns:** TEXT (JSON object string). Returns `NULL` if the number of arguments is odd or if any key is not a non-NULL string.
    *   **Example:** `json_object('name', 'Alice', 'age', 30)` returns `'{"name":"Alice","age":30}'`.

*   `json_patch(json, patch)`
    *   **Description:** Applies a JSON Patch (RFC 6902) operation sequence defined in the `patch` JSON array to the target `json` document.
    *   **Arguments:** `json` (TEXT - valid JSON), `patch` (TEXT - valid JSON array of patch operations).
    *   **Returns:** TEXT (modified JSON string). Returns `NULL` if `json` or `patch` is invalid, or if any patch operation fails (e.g., a 'test' fails).
    *   **Example:** `json_patch('{"a": 1}', '[{"op": "add", "path": "/b", "value": 2}]')` returns `'{"a":1,"b":2}'`.

*   `json_quote(value)`
    *   **Description:** Returns the JSON representation (a valid JSON literal string) of an SQL scalar `value`. Useful for embedding SQL values correctly within JSON structures.
    *   **Arguments:** `value` (SQL scalar: NULL, INTEGER, REAL, TEXT).
    *   **Returns:** TEXT. SQL `NULL` -> `'null'`, INTEGER/REAL -> number literal string, TEXT -> quoted and escaped JSON string. Returns `NULL` for BLOBs, BigInts, or non-finite numbers (NaN/Infinity).
    *   **Example:** `json_quote(10)` returns `'10'`, `json_quote('hello')` returns `'"hello"'`, `json_quote(null)` returns `'null'`, `json_quote('a"b')` returns `'"a\"b"'`.

*   `json_remove(json, path, ...)`
    *   **Description:** Removes elements from the `json` document at the specified `path`(s). Ignores paths that do not exist. Operates on a copy.
    *   **Arguments:** `json` (TEXT - valid JSON), `path` (TEXT - one or more JSON paths to remove).
    *   **Returns:** TEXT (modified JSON string) or `NULL` if `json` is invalid.
    *   **Example:** `json_remove('{"a":1,"b":2,"c":3}', '$.b', '$.d')` returns `'{"a":1,"c":3}'`, `json_remove('[1,2,3,4]', '$[1]', '$[2]')` returns `'[1,3]'` (removes original index 1, then original index 3 which is now at index 2).

*   `json_replace(json, path, value, ...)`
    *   **Description:** Replaces existing values in the `json` document at the specified `path`(s). **Only affects paths that already exist**. Does not insert new values. SQL `value`s are converted to JSON. Operates on a copy.
    *   **Arguments:** `json` (TEXT - valid JSON), `path` (TEXT), `value` (Any SQL type), ... (more path/value pairs).
    *   **Returns:** TEXT (modified JSON string) or `NULL` if `json` is invalid or arguments are malformed.
    *   **Example:** `json_replace('{"a":1,"b":2}', '$.a', 10, '$.c', 30)` returns `'{"a":10,"b":2}'`.

*   `json_set(json, path, value, ...)`
    *   **Description:** Inserts or replaces values in the `json` document at the specified `path`(s). If a path does not exist, it (and any intermediate objects/arrays) will be created. If the path exists, the value is replaced. SQL `value`s are converted to JSON. Operates on a copy. When setting an array element beyond the current length, pads with `null`.
    *   **Arguments:** `json` (TEXT - valid JSON), `path` (TEXT), `value` (Any SQL type), ... (more path/value pairs).
    *   **Returns:** TEXT (modified JSON string) or `NULL` if `json` is invalid or arguments are malformed.
    *   **Example:** `json_set('{"a":1}', '$.a', 10, '$.b', 20)` returns `'{"a":10,"b":20}'`, `json_set('[1,2]', '$[2]', 3)` returns `'[1,2,3]'`, `json_set('[1]', '$[2]', 3)` returns `'[1,null,3]'`.

*   `json_type(json)`, `json_type(json, path)`
    *   **Description:** Returns the JSON type name of the value specified by the optional `path` within the `json` document. If `path` is omitted, returns the type of the top-level value.
    *   **Arguments:** `json` (TEXT - valid JSON), `path` (Optional, TEXT - JSON path).
    *   **Returns:** TEXT: `'null'`, `'true'`, `'false'`, `'integer'`, `'real'`, `'text'`, `'array'`, `'object'`. Returns `NULL` if `json` is invalid or the `path` does not resolve to a value.
    *   **Example:** `json_type('{"a": 1}')` returns `'object'`, `json_type('{"a": 1}', '$.a')` returns `'integer'`, `json_type('[1, "two"]', '$[1]')` returns `'text'`, `json_type('{"a": 1}', '$.b')` returns `NULL`.

*   `json_valid(json)`
    *   **Description:** Checks if the input `json` string is well-formed JSON.
    *   **Arguments:** `json` (TEXT).
    *   **Returns:** INTEGER: `1` if `json` is valid, `0` otherwise.
    *   **Example:** `json_valid('{"a": 1}')` returns `1`, `json_valid('{"a": 1')` returns `0`.

*   `json_schema(json, schema_definition)`
    *   **Description:** Validates a JSON value against a structural schema definition using TypeScript-like syntax. Useful for enforcing JSON structure in CHECK constraints.
    *   **Arguments:**
        *   `json` (TEXT - valid JSON string)
        *   `schema_definition` (TEXT - schema definition using TypeScript-like syntax)
    *   **Schema Syntax:** Uses TypeScript-inspired syntax (powered by [moat-maker](https://github.com/theScottyJam/moat-maker))
        *   **Base types:** `number`, `string`, `boolean`, `null`, `any`
        *   **Arrays:** `type[]` - e.g., `number[]` for array of numbers
        *   **Objects:** `{ prop: type, ... }` - e.g., `{ x: number, y: number }` for object with properties
        *   **Optional properties:** `{ prop?: type }` - e.g., `{ x: number, y?: string }`
        *   **Unions:** `type1 | type2` - e.g., `string | number`
        *   **Nested:** Combine arrays and objects - e.g., `{ x: number }[]` for array of objects
        *   **Tuples:** `[type1, type2]` - e.g., `[string, number]` for a two-element tuple
    *   **Returns:** INTEGER: `1` if the JSON matches the schema, `0` otherwise (including invalid JSON or invalid schema).
    *   **Performance:** When the schema is a constant (e.g., in CHECK constraints), the schema is compiled once at query planning time and cached with the query plan. This provides significant performance improvements for repeated validations.
    *   **Examples:**
        *   `json_schema('[1, 2, 3]', 'number[]')` returns `1` (array of numbers)
        *   `json_schema('{"x": 42}', '{ x: number }')` returns `1` (object with number property x)
        *   `json_schema('[{"x": 1}, {"x": 2}]', '{ x: number }[]')` returns `1` (array of objects)
        *   `json_schema('{"users": [{"name": "Alice", "age": 30}]}', '{ users: { name: string, age: number }[] }')` returns `1`
        *   `json_schema('{"value": "text"}', '{ value: string | number }')` returns `1` (union type)
        *   `json_schema('[1, "mixed"]', 'number[]')` returns `0` (type mismatch)
    *   **Common Use Case - CHECK Constraints:**
        ```sql
        create table events (
          id integer primary key,
          data json check (json_schema(data, '{ x: number, y: number }[]'))
        );
        ```

## Window Functions

Window functions perform calculations across a set of table rows related to the current row, as defined by an `OVER` clause (partitioning and ordering). Quereus provides comprehensive window function support with a modern, extensible architecture.

**Window Function Syntax:**
```sql
window_function([arguments]) OVER (
  [PARTITION BY partition_expression [, ...]]
  [ORDER BY sort_expression [ASC | DESC] [, ...]]
  [window_frame_clause]
)
```

### Ranking Functions

*   `row_number()`
    *   **Description:** Assigns a unique sequential integer (starting from 1) to each row within its partition, based on the `ORDER BY` within the `OVER` clause.
    *   **Arguments:** None.
    *   **Returns:** INTEGER - Sequential row number within the partition.
    *   **Example:** `SELECT name, row_number() OVER (ORDER BY salary DESC) as rank FROM employees;`

*   `rank()`
    *   **Description:** Assigns a rank to each row within its partition based on the `ORDER BY`. Rows with equal values receive the same rank. Gaps appear in the ranking sequence when there are ties.
    *   **Arguments:** None.
    *   **Returns:** INTEGER - Rank with gaps (e.g., 1, 1, 3, 4).
    *   **Example:** `SELECT name, salary, rank() OVER (ORDER BY salary DESC) as rank FROM employees;`

*   `dense_rank()`
    *   **Description:** Assigns a rank like `rank()`, but without gaps in the sequence. Equal values receive the same rank, but subsequent ranks are consecutive.
    *   **Arguments:** None.
    *   **Returns:** INTEGER - Dense rank without gaps (e.g., 1, 1, 2, 3).
    *   **Example:** `SELECT name, salary, dense_rank() OVER (ORDER BY salary DESC) as dense_rank FROM employees;`

*   `ntile(n)`
    *   **Description:** Distributes rows into `n` approximately equal groups (buckets) and assigns the group number to each row.
    *   **Arguments:** `n` (INTEGER) - Number of buckets to create.
    *   **Returns:** INTEGER - Bucket number (1 to n).
    *   **Example:** `SELECT name, ntile(4) OVER (ORDER BY salary) as quartile FROM employees;`

### Aggregate Window Functions

Standard aggregate functions can be used as window functions when an `OVER` clause is provided. These support both streaming execution (for non-partitioned cases) and partitioned execution with proper state management.

*   `count(*)`/`count(expr)` **OVER (...)**
    *   **Description:** Returns the count of rows (or non-NULL values) in the current window frame.
    *   **Example:** `SELECT name, count(*) OVER (PARTITION BY department) as dept_size FROM employees;`

*   `sum(expr)` **OVER (...)**
    *   **Description:** Returns the sum of values in the current window frame.
    *   **Example:** `SELECT name, sum(salary) OVER (PARTITION BY department ORDER BY hire_date) as running_total FROM employees;`

*   `avg(expr)` **OVER (...)**
    *   **Description:** Returns the average of values in the current window frame.
    *   **Example:** `SELECT name, avg(salary) OVER (PARTITION BY department) as dept_avg FROM employees;`

*   `min(expr)` **OVER (...)**
    *   **Description:** Returns the minimum value in the current window frame.
    *   **Example:** `SELECT name, min(salary) OVER (PARTITION BY department) as dept_min FROM employees;`

*   `max(expr)` **OVER (...)**
    *   **Description:** Returns the maximum value in the current window frame.
    *   **Example:** `SELECT name, max(salary) OVER (PARTITION BY department) as dept_max FROM employees;`

### Navigation Functions (Planned)

*Note: The following navigation functions are planned for future implementation:*

*   `lag(expr, offset?, default?)`: Returns the value of `expr` from the row that is `offset` rows *before* the current row within its partition.
*   `lead(expr, offset?, default?)`: Returns the value of `expr` from the row that is `offset` rows *after* the current row within its partition.
*   `first_value(expr)`: Returns the value of `expr` from the first row in the current window frame.
*   `last_value(expr)`: Returns the value of `expr` from the last row in the current window frame.

### Performance and Architecture

Quereus's window function implementation features:

- **Extensible Registration System**: New window functions can be registered dynamically like scalar and aggregate functions
- **Efficient Execution**: Groups window functions by identical window specifications for optimal performance  
- **Streaming Support**: Non-partitioned window functions use constant memory streaming execution
- **Partitioned Execution**: PARTITION BY clauses properly collect and process partitions
- **Type Safety**: Full type validation and proper SQL value handling

### Examples

```sql
-- Ranking employees by salary within each department
SELECT 
  name,
  department,
  salary,
  row_number() OVER (PARTITION BY department ORDER BY salary DESC) as dept_rank,
  rank() OVER (ORDER BY salary DESC) as overall_rank
FROM employees;

-- Running totals and departmental statistics  
SELECT
  name,
  department, 
  salary,
  sum(salary) OVER (PARTITION BY department ORDER BY hire_date) as running_dept_total,
  avg(salary) OVER (PARTITION BY department) as dept_average,
  count(*) OVER (PARTITION BY department) as dept_size
FROM employees;

-- Quartile analysis
SELECT
  name,
  salary,
  ntile(4) OVER (ORDER BY salary) as salary_quartile
FROM employees;
```

## Diagnostic Functions (Table-Valued)

These table-valued functions provide introspection and debugging capabilities for SQL queries and execution.

*   `query_plan(sql)`
    *   **Description:** Returns the query execution plan for the given SQL statement as a table with detailed information about each operation.
    *   **Arguments:** `sql` (TEXT - the SQL statement to analyze).
    *   **Returns:** A table with columns:
        *   `id` (INTEGER) - Unique identifier for the plan node
        *   `parent_id` (INTEGER, nullable) - ID of the parent node in the plan tree
        *   `subquery_level` (INTEGER) - Nesting level for subqueries (0 for main query)
        *   `op` (TEXT) - Operation type (e.g., 'SCAN', 'FILTER', 'PROJECT')
        *   `detail` (TEXT) - Detailed description of the operation
        *   `object_name` (TEXT, nullable) - Name of table, index, or other object involved
        *   `alias` (TEXT, nullable) - Alias used in the query
        *   `est_cost` (REAL, nullable) - Estimated cost of the operation
        *   `est_rows` (INTEGER, nullable) - Estimated number of rows produced
    *   **Example:** `SELECT * FROM query_plan('SELECT name FROM users WHERE age > 25');`

*   `scheduler_program(sql)`
    *   **Description:** Returns the compiled scheduler program (instruction sequence) for the given SQL statement, showing the actual execution plan used by the Quereus runtime.
    *   **Arguments:** `sql` (TEXT - the SQL statement to compile).
    *   **Returns:** A table with columns:
        *   `addr` (INTEGER) - Instruction address/position in the program
        *   `instruction_id` (TEXT) - Unique identifier for the instruction
        *   `dependencies` (TEXT, nullable) - JSON array of instruction addresses this instruction depends on
        *   `description` (TEXT) - Human-readable description of the instruction
        *   `estimated_cost` (REAL, nullable) - Estimated cost of the instruction
        *   `is_subprogram` (INTEGER) - 1 if this is part of a sub-program, 0 for main program
        *   `parent_addr` (INTEGER, nullable) - Address of parent instruction for sub-programs
    *   **Example:** `SELECT addr, instruction_id, description FROM scheduler_program('SELECT 1 + 1');`

*   `stack_trace(sql)`
    *   **Description:** Returns the execution stack trace when running the given SQL statement, useful for debugging complex queries.
    *   **Arguments:** `sql` (TEXT - the SQL statement to trace).
    *   **Returns:** A table with columns:
        *   `frame_id` (INTEGER) - Stack frame identifier (0 = top of stack)
        *   `function_name` (TEXT, nullable) - Name of the function being executed
        *   `instruction_addr` (INTEGER, nullable) - Current instruction address
        *   `source_location` (TEXT, nullable) - Source code location (file:line)
        *   `local_vars` (TEXT, nullable) - JSON representation of local variables
    *   **Example:** `SELECT frame_id, function_name, source_location FROM stack_trace('SELECT complex_function(x) FROM table');`

*   `execution_trace(sql)`
    *   **Description:** Returns a detailed execution trace with timing and resource usage information for performance analysis.
    *   **Arguments:** `sql` (TEXT - the SQL statement to trace).
    *   **Returns:** A table with columns:
        *   `step_id` (INTEGER) - Sequential step identifier
        *   `timestamp_ms` (REAL) - Timestamp when the step started (milliseconds since epoch)
        *   `operation` (TEXT) - Type of operation (e.g., 'PARSE', 'PLAN', 'EXECUTE')
        *   `duration_ms` (REAL, nullable) - Duration of the operation in milliseconds
        *   `rows_processed` (INTEGER, nullable) - Number of rows processed in this step
        *   `memory_used` (INTEGER, nullable) - Memory usage in bytes
        *   `details` (TEXT, nullable) - JSON representation of additional details
    *   **Example:** `SELECT operation, duration_ms, rows_processed FROM execution_trace('SELECT * FROM large_table WHERE condition');`

**Note:** These diagnostic functions are primarily intended for development, debugging, and performance analysis. The `stack_trace` and `execution_trace` functions are non-deterministic and may have performance overhead.

### Assertion Diagnostics

*   `explain_assertion(name)`
    *   Description: Explains how a named integrity assertion will be analyzed and executed at COMMIT time. Returns one row per table reference instance within the assertion’s violation query with its classification and prepared binding info.
    *   Arguments: `name` (TEXT - assertion name)
    *   Returns: A table with columns:
        *   `assertion` (TEXT) - Assertion name
        *   `relation_key` (TEXT) - Instance-unique table reference key (e.g., `main.users#17`)
        *   `base` (TEXT) - Base table name (e.g., `main.users`)
        *   `classification` (TEXT) - 'row' if row-specific (unique key fully covered), otherwise 'global'
        *   `prepared_pk_params` (TEXT, nullable) - JSON array of parameter names (e.g., `["pk0","pk1"]`) when row-specific; NULL if global
        *   `violation_sql` (TEXT) - Stored violation SQL (SELECT returns rows when violated)
    *   Example:
        ```sql
        -- Global-style assertion
        create assertion a_global check ((select count(*) from t2) = (select count(*) from t2));
        select exists(
          select 1 from explain_assertion('a_global')
          where classification = 'global'
        ) as ok;

        -- Row-specific-style assertion (PK equality)
        create assertion a_row check (exists (select 1 from t1 where id = 1));
        select prepared_pk_params
        from explain_assertion('a_row')
        where classification = 'row'
        limit 1;
        ```

### Schema Introspection Functions

*   `schema()`
    *   **Description:** Returns information about all schema objects (tables, views, indexes, functions) in the database.
    *   **Arguments:** None.
    *   **Returns:** A table with columns:
        *   `type` (TEXT) - Type of object ('table', 'view', 'index', 'function')
        *   `name` (TEXT) - Name of the object
        *   `tbl_name` (TEXT) - Table name (for indexes, this is the table they belong to; same as name for other objects)
        *   `sql` (TEXT, nullable) - SQL definition of the object
    *   **Example:** `SELECT type, name FROM schema() WHERE type = 'table';`
    *   **Example:** `SELECT name, tbl_name FROM schema() WHERE type = 'index';` - List all indexes with their table names

*   `table_info(table_name)`
    *   **Description:** Returns detailed information about the columns of a specific table.
    *   **Arguments:** `table_name` (TEXT - name of the table to inspect).
    *   **Returns:** A table with columns:
        *   `cid` (INTEGER) - Column index (0-based)
        *   `name` (TEXT) - Column name
        *   `type` (TEXT) - Column data type
        *   `notnull` (INTEGER) - 1 if column is NOT NULL, 0 otherwise
        *   `dflt_value` (TEXT, nullable) - Default value for the column
        *   `pk` (INTEGER) - 1 if column is part of primary key, 0 otherwise
    *   **Example:** `SELECT name, type, notnull FROM table_info('users');`

*   `function_info()`
    *   **Description:** Returns information about all registered functions in the database.
    *   **Arguments:** None.
    *   **Returns:** A table with columns:
        *   `name` (TEXT) - Function name
        *   `num_args` (INTEGER) - Number of arguments (-1 for variable arguments)
        *   `type` (TEXT) - Function type ('scalar', 'aggregate', 'table-valued')
        *   `deterministic` (INTEGER) - 1 if function is deterministic, 0 otherwise
        *   `flags` (INTEGER) - Internal function flags
        *   `signature` (TEXT) - Function signature for display
    *   **Example:** `SELECT name, type, num_args FROM function_info() WHERE type = 'scalar';`
