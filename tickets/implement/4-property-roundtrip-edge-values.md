description: Add property-based tests for insert/select roundtrip with boundary values
dependencies: none
files:
  packages/quereus/test/property.spec.ts
----
Extend the existing Insert/Select Roundtrip and Temporal Roundtrip test sections in
property.spec.ts with boundary and edge values. The current tests use generic fast-check
arbitraries which rarely hit boundary conditions. These targeted properties exercise type
system edges where silent corruption is most likely.

**Properties to add:**

- **Integer boundaries**: `MAX_SAFE_INTEGER` (2^53-1), `MIN_SAFE_INTEGER` (-(2^53-1)), 0, -1,
  1, `2^31-1`, `-2^31`, `2^32-1`. Insert into INTEGER column, select back, verify exact
  equality. Also verify that values outside safe integer range stored as bigint round-trip
  correctly.

- **BigInt boundaries**: large bigints near 2^63-1, -2^63, 0n. Insert into INTEGER column,
  verify round-trip. Test bigint arithmetic doesn't overflow silently.

- **Empty and special strings**: empty string `''`, string with only whitespace, string with
  embedded NULLs (`\0`), very long string (10K chars), strings that look like numbers
  (`'123'`, `'1.5e10'`, `'NaN'`, `'Infinity'`), strings with unicode (emoji, RTL, zero-width
  joiners). Insert into TEXT column, verify exact preservation.

- **Empty blob**: `x''` (zero-length Uint8Array). Insert into BLOB column, verify length is 0
  on retrieval.

- **NULL-heavy rows**: rows where every nullable column is NULL. Insert and select back,
  verify all NULLs preserved (not coerced to 0 or empty string).

- **Temporal boundary values**:
  - DATE: `'0001-01-01'`, `'9999-12-31'`, `'2000-02-29'` (leap), `'1900-02-28'` (not leap)
  - TIME: `'00:00:00'`, `'23:59:59'`, `'12:00:00.000'`, `'23:59:59.999'`
  - DATETIME: `'0001-01-01 00:00:00'`, `'9999-12-31 23:59:59'`
  - Verify round-trip through `date(text(d))`, `time(text(t))`, `datetime(text(dt))`

- **JSON edge values**: deeply nested objects (10+ levels), arrays with 1000 elements, objects
  with empty-string keys, JSON with all value types mixed. Insert into column, extract with
  `json_extract`, verify structural equality.

These can be deterministic (no fast-check needed for boundary values) or use fast-check with
constrained arbitraries for the random portions. Add to the existing roundtrip describe blocks.

TODO:
- Add integer boundary roundtrip tests
- Add bigint boundary roundtrip tests
- Add special string roundtrip tests
- Add empty blob roundtrip test
- Add NULL-heavy row roundtrip test
- Add temporal boundary roundtrip tests
- Add JSON edge value roundtrip tests
- Run tests, verify all pass, file fix/ tickets for any failures found
