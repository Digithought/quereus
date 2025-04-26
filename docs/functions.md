# Built-in Functions Reference

This document lists the built-in SQL functions available in SQLiter.

## Scalar Functions

These functions operate on single values and return a single value.

*   `abs(X)`: Returns the absolute value of numeric argument X.
*   `ceil(X)`, `ceiling(X)`: Returns the smallest integer not less than X.
*   `coalesce(X, Y, ...)`: Returns a copy of the first non-NULL argument, or NULL if all arguments are NULL.
*   `floor(X)`: Returns the largest integer not greater than X.
*   `glob(pattern, string)`: Checks if `string` matches the GLOB `pattern`. Returns 1 (true) or 0 (false).
*   `iif(X, Y, Z)`: If X is true (non-zero numeric), returns Y, otherwise returns Z.
*   `instr(X, Y)`: Returns the 1-based index of the first occurrence of string Y within string X, or 0 if Y is not found.
*   `length(X)`: Returns the length of string X in characters or blob X in bytes. Returns NULL for other types.
*   `like(pattern, string)`: Checks if `string` matches the LIKE `pattern`. Returns 1 (true) or 0 (false). (ESCAPE clause not implemented).
*   `lower(X)`: Returns the lowercase equivalent of string X, or NULL if X is not a string.
*   `ltrim(X)`, `ltrim(X, Y)`: Removes leading whitespace from string X, or removes leading characters found in string Y from string X.
*   `nullif(X, Y)`: Returns NULL if X is equal to Y, otherwise returns X.
*   `pow(X, Y)`, `power(X, Y)`: Returns X raised to the power of Y.
*   `random()`: Returns a pseudo-random 64-bit signed integer.
*   `randomblob(N)`: Returns an N-byte blob containing pseudo-random bytes (N <= 1MB).
*   `replace(X, Y, Z)`: Replaces all occurrences of string Y in string X with string Z.
*   `round(X)`, `round(X, Y)`: Rounds numeric value X to Y decimal places (default 0).
*   `rtrim(X)`, `rtrim(X, Y)`: Removes trailing whitespace from string X, or removes trailing characters found in string Y from string X.
*   `sqrt(X)`: Returns the square root of numeric value X. Returns NULL if X is negative.
*   `substr(X, Y, Z?)`, `substring(X, Y, Z?)`: Returns a substring of string X starting at the Y-th character (1-based) and Z characters long. If Z is omitted, returns the rest of the string.
*   `trim(X)`, `trim(X, Y)`: Removes leading and trailing whitespace from string X, or removes leading/trailing characters found in string Y from string X.
*   `typeof(X)`: Returns the fundamental datatype of X: 'null', 'integer', 'real', 'text', or 'blob'.
*   `upper(X)`: Returns the uppercase equivalent of string X, or NULL if X is not a string.

## Aggregate Functions

These functions compute a single result from multiple input rows.

*   `avg(X)`: Returns the average value of all non-NULL X within a group.
*   `count()` or `count(*)`: Returns the total number of rows in the group.
*   `count(X)`: Returns the number of times X is non-NULL in a group.
*   `group_concat(X)`, `group_concat(X, Y)`: Returns a string which is the concatenation of all non-NULL X values, separated by string Y (default ',').
*   `json_group_array(X)`: Returns a JSON array containing all values in the group (including NULLs).
*   `json_group_object(N, V)`: Returns a JSON object composed of key/value pairs from N (name) and V (value) columns in the group. Keys must be non-NULL strings.
*   `max(X)`: Returns the maximum value of all non-NULL X within a group.
*   `min(X)`: Returns the minimum value of all non-NULL X within a group.
*   `stddev_pop(X)`: Returns the population standard deviation of all non-NULL numeric values in the group.
*   `stddev_samp(X)`: Returns the sample standard deviation of all non-NULL numeric values in the group (NULL if count <= 1).
*   `sum(X)`: Returns the sum of all non-NULL values in the group. Result is INTEGER/BIGINT if possible, otherwise REAL or NULL.
*   `total(X)`: Returns the sum of all non-NULL values in the group. Result is always REAL (float). Returns 0.0 for an empty group.
*   `var_pop(X)`: Returns the population variance of all non-NULL numeric values in the group.
*   `var_samp(X)`: Returns the sample variance of all non-NULL numeric values in the group (NULL if count <= 1).

## Date & Time Functions

These functions manipulate date and time values.

*   `date(timestring, modifier, ...)`: Returns the date in YYYY-MM-DD format.
*   `datetime(timestring, modifier, ...)`: Returns the date and time in YYYY-MM-DD HH:MM:SS format.
*   `julianday(timestring, modifier, ...)`: Returns the Julian day number.
*   `strftime(format, timestring, modifier, ...)`: Returns the date formatted according to the `format` string.
*   `time(timestring, modifier, ...)`: Returns the time in HH:MM:SS format.

See [Date/Time Handling](datetime.md) for details on formats and modifiers.

## JSON Functions

These functions operate on JSON values.

*   `json_array(V1, V2, ...)`: Returns a JSON array containing the given values.
*   `json_array_length(json)`, `json_array_length(json, path)`: Returns the number of elements in the JSON array `json` or at the specified `path`.
*   `json_extract(json, path, ...)`: Extracts and returns one or more values from `json` based on the JSON `path` arguments.
*   `json_insert(json, path, value, ...)`: Inserts `value`(s) into `json` at the specified `path`(s), only if the path does not already exist.
*   `json_object(N1, V1, N2, V2, ...)`: Returns a JSON object created from the key/value pairs.
*   `json_patch(json, patch)`: Applies a JSON patch (RFC 6902) to the target `json` document.
*   `json_quote(value)`: Returns the JSON representation (a valid JSON literal) of an SQL `value`.
*   `json_remove(json, path, ...)`: Removes elements from `json` at the specified `path`(s).
*   `json_replace(json, path, value, ...)`: Replaces existing values in `json` at the specified `path`(s).
*   `json_set(json, path, value, ...)`: Inserts or replaces values in `json` at the specified `path`(s) (creates intermediate paths if needed).
*   `json_type(json)`, `json_type(json, path)`: Returns the JSON type name ('null', 'true', 'false', 'integer', 'real', 'text', 'array', 'object') of the value `json` or at the specified `path`.
*   `json_valid(json)`: Returns 1 if the input `json` string is well-formed JSON, 0 otherwise.

*Note: JSON paths follow SQLite syntax (e.g., '$.name', '$.phones[0].type').*

## Window Functions (Limited Support)

Window functions perform calculations across a set of table rows related to the current row.

*   `row_number()`: Assigns a unique sequential integer to each row within its partition.
*   `rank()`: Assigns a rank to each row within its partition, with gaps for ties.
*   `dense_rank()`: Assigns a rank to each row within its partition, without gaps for ties.
*   `lag(expr, offset?, default?)`: Returns the value of `expr` from the row that lags the current row by `offset` rows within its partition (default offset 1). Returns `default` (or NULL) if the offset row does not exist.
*   `lead(expr, offset?, default?)`: Returns the value of `expr` from the row that leads the current row by `offset` rows within its partition (default offset 1). Returns `default` (or NULL) if the offset row does not exist.
*   `first_value(expr)`: Returns the value of `expr` from the first row in the window frame.
*   `last_value(expr)`: Returns the value of `expr` from the last row in the window frame.

*Note: The aggregate functions (`sum`, `avg`, `count`, `min`, `max`) can also be used as window functions when an `OVER` clause is provided.* 
