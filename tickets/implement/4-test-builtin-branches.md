description: Targeted sqllogic tests for untested branches in builtin functions — datetime heuristics, JSON edge cases, string patterns, aggregate overflow
dependencies: none
files:
  - packages/quereus/src/func/builtins/datetime.ts
  - packages/quereus/src/func/builtins/json.ts
  - packages/quereus/src/func/builtins/string.ts
  - packages/quereus/src/func/builtins/aggregate.ts
  - packages/quereus/src/func/builtins/scalar.ts
  - packages/quereus/src/func/builtins/conversion.ts
  - packages/quereus/test/logic/24-builtin-branches.sqllogic (new)
----

## Motivation

`func/builtins/` has 80% line coverage but only 71% branch coverage. The untested 29% of branches are mostly error paths, type coercion edge cases, and unusual argument combinations — exactly where bugs hide.

## What to test

### datetime.ts — heuristic parsing branches

The date/time functions use a chain of heuristic parsers (Julian day vs Unix epoch vs ISO). Test the disambiguation:

- **Julian day numbers**: values in the Julian day range that could be misidentified as epochs
- **Unix epoch seconds vs milliseconds**: `epoch_s(1000000000)` vs `epoch_ms(1000000000000)` — verify correct interpretation
- **Lenient SQLite format**: `'2024-01-01 12:00:00'` without T separator
- **Fractional seconds**: `'2024-01-01T12:00:00.123456789'` — full nanosecond precision
- **Out-of-range dates**: dates before 1900 and after 3000 — verify error or graceful handling
- **Invalid inputs**: `date('not-a-date')`, `time('')`, `datetime(null)` — verify null return or error
- **strftime format codes**: test each format specifier (%Y, %m, %d, %H, %M, %S, %f, %j, %W, etc.)

### json.ts — schema and modification branches

- **json_valid**: valid JSON, invalid JSON, empty string, null, nested objects, arrays
- **json_schema**: valid schema + matching data → true; valid schema + non-matching data → false; invalid schema → error
- **json_extract with missing paths**: `json_extract('{"a":1}', '$.b')` → null
- **json_insert/replace/set distinction**: insert into existing key (no-op for insert, replaces for set/replace); insert into missing key (inserts for insert/set, no-op for replace)
- **json_remove on nonexistent path**: no error, returns original
- **json_patch**: RFC 7396 merge patch — null values remove keys
- **Deeply nested JSON**: 50+ levels — verify no stack overflow
- **json_each / json_tree on non-object/array**: scalar value, null

### string.ts — pattern matching and trim branches

- **LIKE edge cases**: `'%' LIKE '%'`, `'_' LIKE '_'`, escape character handling, empty pattern, empty string
- **GLOB edge cases**: `*`, `?`, `[a-z]` character classes, case sensitivity
- **substr with negative index**: `substr('hello', -2)` — verify SQLite-compatible behavior
- **trim with special characters**: trim of regex-special chars (`[`, `]`, `\`, `.`, `*`)
- **lpad/rpad with multi-byte characters**: Unicode padding
- **instr with empty needle**: `instr('hello', '')` — verify behavior
- **reverse with Unicode**: multi-byte characters, combining characters, emoji

### aggregate.ts — overflow and precision branches

- **SUM overflow → BigInt promotion**: sum integers that exceed MAX_SAFE_INTEGER
- **AVG precision**: average of many values near MAX_SAFE_INTEGER — verify no NaN
- **MIN/MAX with mixed types**: compare integers and reals, text values
- **GROUP_CONCAT with custom separator**: null separator, empty separator, multi-char separator
- **GROUP_CONCAT with all-null group**: verify returns null
- **TOTAL vs SUM**: SUM returns null for empty set; TOTAL returns 0.0
- **Statistical aggregates**: var_pop, var_samp, stddev_pop, stddev_samp with known datasets — verify against hand-calculated values
- **Single-value variance**: var_pop of 1 value → 0; var_samp of 1 value → null (N-1 = 0)

### scalar.ts — coercion branches

- **typeof**: verify for each physical type (integer, real, text, blob, null)
- **coalesce with mixed types**: `coalesce(null, 1, 'text')` — verify type of result
- **nullif**: `nullif(1, 1)` → null; `nullif(1, 2)` → 1; `nullif(null, null)` — behavior
- **iif**: true/false/null condition
- **clamp**: value below min, within range, above max; null arguments
- **greatest/least with nulls**: verify null handling (skip nulls? or return null?)
- **choose with out-of-range index**: `choose(0, 'a', 'b')`, `choose(5, 'a', 'b')` — null or error

### conversion.ts — type cast branches

- **integer('not_a_number')**: error or null
- **real('Infinity')**, **real('NaN')**: verify behavior
- **boolean from various types**: `boolean(0)`, `boolean('')`, `boolean(null)`, `boolean('true')`, `boolean(1)`
- **text(blob_value)**: verify encoding behavior
