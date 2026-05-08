---
description: Honor partition collation in AsofScan's bucket key (NOCASE etc.)
files:
  - packages/quereus/src/runtime/emit/asof-scan.ts
---

`emitAsofScan` builds bucket keys via `${typeof v}:${String(v)}` for each
partition value, joined by spaces. This is BINARY-equivalent: `'a'` and `'A'`
hash to different buckets even when the partition column is COLLATE NOCASE.

To match SQLite-style equality semantics, the encoder should canonicalize
strings through the partition's collation function — e.g. `nocase` would
lower-case the value before stringification, and `BINARY` would pass through
unchanged.

This is a known limitation; the AsofScanNode's plan-level reasoning already
treats the partition equi-pair as a generic equality, so the runtime is the
sole place to fix the encoding.

Tests:
- A sqllogic case under `test/logic/84-asof-scan.sqllogic` with a NOCASE
  partition column showing `'A'` and `'a'` must match the same right partition.
- An ASCII/non-ASCII Unicode case for any RTRIM or future Unicode collations
  that may be introduced.
