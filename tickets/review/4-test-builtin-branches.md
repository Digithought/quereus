description: Targeted sqllogic tests for untested branches in builtin functions — datetime heuristics, JSON edge cases, string patterns, aggregate overflow, scalar coercion, conversion errors
dependencies: none
files:
  - packages/quereus/test/logic/24-builtin-branches.sqllogic
  - packages/quereus/src/func/builtins/datetime.ts
  - packages/quereus/src/func/builtins/json.ts
  - packages/quereus/src/func/builtins/string.ts
  - packages/quereus/src/func/builtins/aggregate.ts
  - packages/quereus/src/func/builtins/scalar.ts
  - packages/quereus/src/func/builtins/conversion.ts
----

## What was built

A comprehensive sqllogic test file (`24-builtin-branches.sqllogic`) targeting untested branches in the `func/builtins/` directory. The test covers ~100 test cases across 6 source files.

## Test coverage by area

### datetime.ts — heuristic parsing & formatting
- Julian day number interpretation (value in 1M–4M range)
- Unix epoch seconds interpretation (value in seconds range)
- Epoch milliseconds fallback (value outside seconds range)
- Out-of-range numeric → null
- YYYYMMDD lenient format parsing
- Space-separated datetime format
- Fractional seconds with subsec modifier
- Invalid/null inputs → null
- Modifiers: start of month, start of year, negative relative, year, month, chained
- strftime specifiers: %j, %D, %F, %C, %y, %h, %e, %I, %k, %l, %p, %P, %T, %R, %r, %w, %u, %J, %%, %z, %f, %s, combined formats, null format

### json.ts — validation, types, manipulation
- json_valid: empty string, 'null', 'true', 'false', number arg, boolean arg
- json_type: integer, real, true, false, null, array, object
- json_extract: missing path → null, null value, multiple paths (first match)
- json_insert: array append at length position
- json_set: array out-of-bounds fills with nulls
- json_replace: root path replacement
- json_remove: array element, multiple paths
- json_patch: empty patch, invalid patch (missing op), non-array patch
- json_group_array/json_group_object: empty table, all-null keys

### string.ts — substr, trim, LIKE
- substr: negative start, zero start, negative length, large negative start
- trim: regex-special characters ([], ., *, ()), empty chars
- LIKE: % matches %, _ matches single, _ rejects empty, empty matches, % matches empty

### aggregate.ts — overflow, coercion, statistics
- SUM: BigInt promotion on overflow (sum > MAX_SAFE_INTEGER)
- SUM: string coercion (numeric strings parsed, non-numeric ignored, null skipped)
- SUM: boolean values (true→1, false→0)
- GROUP_CONCAT: custom separator, all-null → null, empty separator
- Statistical: var_pop/var_samp/stddev_pop/stddev_samp with known dataset + hand-verified values
- Single-value: var_pop→0, var_samp→null, stddev_pop→0, stddev_samp→null
- MIN/MAX with nulls, all-null aggregates
- TOTAL with non-numeric strings

### scalar.ts — coalesce, nullif, iif, choose, greatest
- coalesce: skip nulls, all null, first wins, mixed types
- nullif: equal→null, unequal→first arg, null-null→null
- iif: string conditions ('1'→true, '0'→false, 'abc'→false), boolean conditions
- choose: first/last element, past end → null, negative → null
- greatest: with nulls (skips effectively), all nulls
- typeof: boolean→integer, json object→json

### conversion.ts — error paths
- integer('not_a_number') → error
- integer('') → null
- real('not_a_number') → error
- real('') → null
- boolean('') → error
- boolean('yes'/'no'/'on'/'off') → true/false

## Known limitation

The SQL parser treats `;` inside string literals as a statement separator. GROUP_CONCAT tests use `|` as separator instead of `;` to work around this. This is not a bug introduced by this ticket.

## Validation

- All 1173 tests pass (2 pending, pre-existing)
- Build succeeds
