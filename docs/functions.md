# Built-in Functions Reference

This document lists the built-in SQL functions available in Quereus.

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

## Date & Time Functions

These functions manipulate date and time values. They rely heavily on the underlying `Temporal` polyfill for parsing and calculations. See [Date/Time Handling](datetime.md) for details on supported `timestring` formats and `modifier` strings.

*   `date(timestring, modifier, ...)`
    *   **Description:** Returns the date in `YYYY-MM-DD` format.
    *   **Arguments:** `timestring` (TEXT or Numeric - see docs), `modifier` (Optional, TEXT, zero or more).
    *   **Returns:** A TEXT string or `NULL` on error.
    *   **Example:** `date('now')`, `date('2024-01-15', '+7 days')`.

*   `datetime(timestring, modifier, ...)`
    *   **Description:** Returns the date and time in `YYYY-MM-DD HH:MM:SS` format.
    *   **Arguments:** `timestring`, `modifier` (Optional, zero or more).
    *   **Returns:** A TEXT string or `NULL` on error.
    *   **Example:** `datetime('now', 'localtime')`, `datetime('2024-01-15 10:30:00', '-1 hour')`.

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

*   `time(timestring, modifier, ...)`
    *   **Description:** Returns the time in `HH:MM:SS` format.
    *   **Arguments:** `timestring`, `modifier` (Optional, zero or more).
    *   **Returns:** A TEXT string or `NULL` on error.
    *   **Example:** `time('now', 'localtime')`, `time('14:30:15', '+15 minutes')`.

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

## Window Functions (Limited Support)

Window functions perform calculations across a set of table rows related to the current row, as defined by an `OVER` clause (partitioning and ordering). Quereus has **limited initial support** for window functions. The `OVER` clause syntax is parsed, but complex framing clauses (`ROWS BETWEEN ...`) might not be fully implemented or optimized.

*   `row_number()`: Assigns a unique sequential integer (starting from 1) to each row within its partition, based on the `ORDER BY` within the `OVER` clause.
*   `rank()`: Assigns a rank to each row within its partition based on the `ORDER BY`. Rows with equal values receive the same rank. Gaps may appear in the ranking sequence (e.g., 1, 1, 3).
*   `dense_rank()`: Assigns a rank like `rank()`, but without gaps in the sequence (e.g., 1, 1, 2).
*   `lag(expr, offset?, default?)`: Returns the value of `expr` from the row that is `offset` rows *before* the current row within its partition (default offset is 1). Returns `default` (or `NULL` if `default` is omitted) if the offset row does not exist.
*   `lead(expr, offset?, default?)`: Returns the value of `expr` from the row that is `offset` rows *after* the current row within its partition (default offset is 1). Returns `default` (or `NULL` if `default` is omitted) if the offset row does not exist.
*   `first_value(expr)`: Returns the value of `expr` from the first row in the current window frame.
*   `last_value(expr)`: Returns the value of `expr` from the last row in the current window frame.

*Note: The standard aggregate functions (`sum`, `avg`, `count`, `min`, `max`) can also be used as window functions when an `OVER` clause is provided (e.g., `SUM(salary) OVER (PARTITION BY department ORDER BY hire_date)`).*
