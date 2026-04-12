description: Property-based tests for insert/select roundtrip with boundary and edge values
files:
  packages/quereus/test/property.spec.ts
----
Added 7 deterministic boundary-value test cases to property.spec.ts, extending the existing
Insert/Select Roundtrip, Temporal Roundtrip, and JSON Roundtrip sections.

**Tests added (all passing):**

- **Integer boundaries**: MAX_SAFE_INTEGER, MIN_SAFE_INTEGER, 0, -1, 1, INT32_MAX, INT32_MIN,
  UINT32_MAX — verifies exact equality after insert/select.

- **BigInt boundaries**: INT64_MAX (2^63-1), INT64_MIN (-2^63), 0n, 1n, -1n, plus bigint
  equivalents of safe integer bounds. Handles the case where safe-range bigints may return as
  number type.

- **Special strings**: empty string, whitespace-only, embedded NULs, 10K chars, numeric-looking
  strings ('123', '1.5e10', 'NaN', 'Infinity'), emoji, ZWJ sequences, RTL marks, zero-width
  characters, SQL injection strings, quotes.

- **Empty blob**: zero-length Uint8Array roundtrip, verifies instanceof and length.

- **NULL-heavy rows**: table with 5 nullable columns (INTEGER, REAL, TEXT, BLOB, ANY), all set
  to NULL. Single row and 10-row batch, verifying no coercion to 0 or empty string.

- **Temporal boundaries**: DATE ('0001-01-01', '9999-12-31', leap/non-leap), TIME ('00:00:00',
  '23:59:59', '23:59:59.999', fractional-zero normalization), DATETIME with ISO 8601 T
  separator output.

- **JSON edge values**: 12-level nested object, 1000-element array, empty-string keys,
  mixed-type objects, empty object/array, nested arrays.

**Validation:** Full test suite passes — 1717 passing, 0 failures.

**Note:** datetime() returns ISO 8601 format with T separator (e.g. '0001-01-01T00:00:00'),
not space-separated. Tests reflect this actual behavior.
