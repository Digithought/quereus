description: LIKE/GLOB/substr index by UTF-16 code unit instead of code point; GLOB lacks character classes
prereq:
files:
  packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic
  packages/quereus/test/logic/24.1-substr-extras.sqllogic
  packages/quereus/src/func/builtins/string.ts
----
## Problem

Built-in string functions index strings by JavaScript's native UTF-16 code units rather than by Unicode code points. This produces incorrect results for non-BMP characters (which occupy two UTF-16 code units, e.g. `😀`). Additionally, GLOB lacks character-class support entirely.

- **LIKE `_`** matches a single UTF-16 code unit. A non-BMP character requires two `_` to match, contrary to SQL `like` semantics ("any single character").
- **GLOB** does not implement character classes (`[abc]`, `[a-c]`, `[^abc]`).
- **`substr`** indexes by UTF-16 code unit. Non-BMP `😀` (one code point, two code units) gets split. SQLite docs spec code-point indexing.

## Expected behavior

- `like('_', '😀')` → `true` — `_` matches one Unicode code point.
- `glob('[abc]', 'a')` → `true`; `glob('[abc]', 'd')` → `false`; `glob('[a-c]', 'b')` → `true`; `glob('[^abc]', 'd')` → `true`. Standard GLOB character-class semantics including ranges and negation with `^`.
- `substr('a😀b', 2, 1)` → `'😀'` — start/length count code points, not code units. BMP cases (e.g. `café`) must continue to work.

## Reproduction

Uncomment to observe failures:

- `packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic:23-25` — LIKE non-BMP single-character match.
- `packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic:41-53` — GLOB character classes (positive list, negative list, range).
- `packages/quereus/test/logic/24.1-substr-extras.sqllogic:69-72` — substr splitting `😀` mid-surrogate.

Adjacent passing case at `06.1.3-like-glob-edges.sqllogic:19-21` (`like('a_b', 'aäb')`) confirms BMP multi-byte input already works under the current UTF-16-code-unit model — the regressions are non-BMP-only.

## Likely investigation areas

- `packages/quereus/src/func/builtins/string.ts` — `like`, `glob`, and `substr` implementations. The indexing strategy needs to iterate by Unicode code point (e.g. via `[...str]` / `String.prototype.codePointAt`) rather than `.length` / charAt-style indexing.
- GLOB pattern engine: add character-class compilation (`[set]`, `[^set]`, `[a-z]` ranges) alongside the existing `*` and `?` handling. Ensure `]` immediately after `[` or `[^` is treated as a literal per standard GLOB semantics.
- Watch for performance hotspots: code-point iteration is O(n) per access, so substr should compute the slice in a single pass rather than repeated random access.
