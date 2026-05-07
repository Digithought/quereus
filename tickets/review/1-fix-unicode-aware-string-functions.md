description: Review Unicode-aware LIKE/GLOB/substr fixes
prereq:
files:
  packages/quereus/src/util/patterns.ts
  packages/quereus/src/func/builtins/string.ts
  packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic
  packages/quereus/test/logic/24.1-substr-extras.sqllogic
----

## What changed

Three string built-ins now index by Unicode code point instead of UTF-16 code unit, and GLOB grew character-class support.

### `simpleLike` — `packages/quereus/src/util/patterns.ts:16`
Added the `'u'` flag to the compiled regex. The regex translation itself is unchanged. With `u`, the `.` produced by `_` matches one Unicode code point, so `LIKE '_'` matches a single non-BMP character (e.g. `😀`) instead of one of its surrogate halves.

### `simpleGlob` — `packages/quereus/src/util/patterns.ts:41`
Replaced the previous "escape everything then re-replace `\*` and `\?`" scheme (which clobbered character-class brackets) with a small character-by-character translator that:
- iterates by code point (`[...pattern]`) so non-BMP pattern chars survive intact;
- translates `*` → `.*`, `?` → `.`;
- passes `[...]`, `[^...]`, and `[a-c]` ranges through to the regex engine, escaping `\\` and embedded `]`;
- treats an unclosed `[` as a literal `[` (defensive — friendlier than throwing);
- escapes regex metacharacters elsewhere;
- compiles with the `'u'` flag so code-point ranges like `[😀-😎]` work.

### `substrImpl` — `packages/quereus/src/func/builtins/string.ts:35`
Replaced UTF-16 indexing (`s.length`, `s.substring`) with code-point indexing via `Array.from(s)` once, then `slice(begin, end).join('')`. All existing edge cases (1-based, Y=0 quirk, negative Y, negative Z, Y past end, Z past end clamped to tail) behave exactly as before — only the indexing alphabet changed.

`length()`, `instr()`, `lpad`/`rpad`, `trim`/`ltrim`/`rtrim`, `replace()`, etc. were intentionally left alone — out of scope for this ticket.

## Tests

Re-enabled three previously-disabled blocks (no `-- TODO bug:` comments remain in these regions):

- `packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic`
  - `like('_', '😀')` → `true` (1 case)
  - GLOB character classes: `[abc]`, `[a-c]`, `[^abc]` — positive and negative (6 cases)
- `packages/quereus/test/logic/24.1-substr-extras.sqllogic`
  - `substr('a😀b', 2, 1)` → `'😀'` (1 case)

Adjacent BMP cases (`like('a_b', 'aäb')`, `substr('café', 1, 4)`) continue to pass.

## Validation performed

- `yarn build` — clean.
- `yarn test` — `2523 passing`, `3 pending`, **0 failing** (across all workspaces). The pre-existing `18-json-string-escapes.sqllogic` failure mentioned in the implement ticket did not surface in this run (apparently fixed elsewhere).

## Review checklist

- Confirm `simpleLike`/`simpleGlob` correctness for an unclosed `[` and for `]` immediately after `[` / `[^` (literal-member case).
- Confirm `substrImpl` performance is acceptable — `Array.from(s)` is O(n) once per call; previously `substring` was O(1) with O(end-begin) copy.
- Confirm no other call sites of `length()` or string indexing in built-ins that the ticket scope intentionally skipped need follow-up tickets.
- Verify CTAS / parameterized / collation paths through LIKE/GLOB still behave (binary.ts only imports `simpleLike` so the fix is centralized).
