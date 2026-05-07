description: LIKE/GLOB/substr index by UTF-16 code unit instead of code point; GLOB lacks character classes
prereq:
files:
  packages/quereus/src/util/patterns.ts
  packages/quereus/src/func/builtins/string.ts
  packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic
  packages/quereus/test/logic/24.1-substr-extras.sqllogic
----

## Problem

Built-in string functions index strings by JavaScript's native UTF-16 code units rather than Unicode code points. Non-BMP characters (e.g. `😀`) occupy two UTF-16 code units, so:

- `like('_', '😀')` → `false` (LIKE `_` matches one code unit; needs two `_` for one non-BMP char).
- `substr('a😀b', 2, 1)` → splits `😀` mid-surrogate.
- `glob('[abc]', 'a')` — GLOB has no character-class implementation at all.

## Fix design

### `simpleLike` — `packages/quereus/src/util/patterns.ts`

The current implementation already converts the LIKE pattern into a regex; the only fix is to compile the regex with the `u` flag so `.` matches a single Unicode code point (not a single UTF-16 code unit).

```ts
const escapedPattern = pattern.replace(/[.*+^${}()|[\]\\]/g, '\\$&');
const regexPattern = escapedPattern.replace(/%/g, '.*').replace(/_/g, '.');
const regex = new RegExp(`^${regexPattern}$`, 'u');
```

The existing escape list is sufficient under `u` (all listed escapes are valid Unicode-mode escapes). No change is needed in `binary.ts` — `simpleLike` is the single chokepoint for both the `LIKE` operator and the `like()` SQL function.

### `simpleGlob` — `packages/quereus/src/util/patterns.ts`

The current implementation is a regex-trick that *escapes* `[` and `]` away, which is why character classes don't work. Replace it with a small character-by-character translator that builds a regex string. Iterate by **code point** (`[...pattern]`) so non-BMP characters in the pattern flow through intact and the resulting regex is compiled with the `u` flag.

Translation rules:

| GLOB | Regex |
|------|-------|
| `*` | `.*` |
| `?` | `.` |
| `[abc]` | `[abc]` (passthrough) |
| `[^abc]` | `[^abc]` (passthrough) |
| `[a-c]` | `[a-c]` (passthrough) |
| `[]abc]` | `[\]abc]` — `]` immediately after `[` or `[^` is a literal member |
| any other regex meta (`\.|^$()+{}\\` etc.) | escape with `\\` |
| literal | passthrough |

Inside a class, escape `\\` and any `]` that isn't the closer. Unmatched `[` (no closing `]` before end of pattern) is treated as a literal `[` (defensive — most engines either error or treat literally; literal is the friendlier choice).

Compile with `u` so code-point ranges like `[😀-😎]` work and `?`/`.` match by code point.

Sketch:

```ts
export function simpleGlob(pattern: string, text: string): boolean {
    const chars = [...pattern]; // code-point iteration
    let regex = '';
    let i = 0;
    while (i < chars.length) {
        const c = chars[i];
        if (c === '*') { regex += '.*'; i++; continue; }
        if (c === '?') { regex += '.'; i++; continue; }
        if (c === '[') {
            // try to consume a character class; on failure fall back to literal `[`
            let j = i + 1;
            let cls = '[';
            if (j < chars.length && chars[j] === '^') { cls += '^'; j++; }
            let first = true;
            let closed = false;
            while (j < chars.length) {
                const cc = chars[j];
                if (cc === ']' && !first) { closed = true; break; }
                if (cc === '\\' || cc === ']') cls += '\\' + cc;
                else cls += cc;
                first = false;
                j++;
            }
            if (closed) { regex += cls + ']'; i = j + 1; continue; }
            // unclosed — fall through and treat `[` as literal
        }
        if ('\\^$.|?*+()[]{}'.includes(c)) regex += '\\' + c;
        else regex += c;
        i++;
    }
    try {
        return new RegExp(`^${regex}$`, 'u').test(text);
    } catch (e) {
        errorLog('Invalid GLOB pattern compiled to regex: ^%s$, %O', regex, e);
        return false;
    }
}
```

`binary.ts` only imports `simpleLike`, so this rewrite is self-contained.

### `substr` — `packages/quereus/src/func/builtins/string.ts`

Replace UTF-16 indexing (`s.length`, `s.substring`) with code-point indexing using `Array.from` once, then `slice`+`join`. The existing 1-based / negative-Y / negative-Z / past-end semantics are preserved verbatim — only the indexing alphabet changes.

```ts
const cps = Array.from(s);
const strLen = cps.length;
// existing begin/end math against strLen, unchanged
return cps.slice(begin, end).join('');
```

`Array.from(s)` is a single forward pass; `slice` is O(end-begin); `join` is O(output). Total O(n), no per-access scanning. Both `substrFunc` and `substringFunc` share `substrImpl`, so the fix lands in one place.

`length()` is intentionally **not** changed — SQLite's `length()` returns the number of characters for TEXT, but Quereus already documents/uses `.length` (UTF-16 code units) and several other places assume that. Leaving it alone keeps the change scoped to the ticket; if it needs to change later it should be its own ticket.

## Tests

Re-enable the three currently-disabled cases by removing the `-- TODO bug:` markers and uncommenting:

`packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic`:
- lines 23–25: `select like('_', '😀') as result;` → `true`
- lines 41–53: six GLOB character-class assertions (positive list, negative list, range, with positive and negative results)

`packages/quereus/test/logic/24.1-substr-extras.sqllogic`:
- lines 69–72: `select substr('a😀b', 2, 1) as result;` → `'😀'`

Adjacent passing cases must keep passing:
- `06.1.3-like-glob-edges.sqllogic:19-21` (`like('a_b', 'aäb')` — BMP multi-byte)
- `24.1-substr-extras.sqllogic:74-76` (`substr('café', 1, 4)` — BMP multi-byte)
- All cases in `06-builtin_functions`, `24-builtin-branches`, `44-orthogonality`, `10.3-function-features`, `06.5-polymorphic-types`, `101-builtin-mutation-kills` that use `like`/`glob`/`substr`.

The pre-existing `18-json-string-escapes.sqllogic` failure observed at baseline is unrelated to this ticket and should remain whatever state it was in.

## TODO

- Edit `packages/quereus/src/util/patterns.ts`:
  - Add `'u'` flag to the `RegExp` constructor in `simpleLike`.
  - Replace the body of `simpleGlob` with the code-point-iterating translator described above; compile with `'u'`.
- Edit `packages/quereus/src/func/builtins/string.ts`: in `substrImpl`, replace the UTF-16-indexed `s.length` / `s.substring(begin, end)` path with `Array.from(s)` + `slice(begin, end).join('')`. Leave `length()`, `instr()`, `lpad`/`rpad`, `trim`/`ltrim`/`rtrim`, `replace()`, etc. untouched.
- Edit `packages/quereus/test/logic/06.1.3-like-glob-edges.sqllogic`: uncomment the three TODO-bug blocks (lines 23–25 and 41–53), removing the `-- TODO bug:` markers but keeping the surrounding section comments.
- Edit `packages/quereus/test/logic/24.1-substr-extras.sqllogic`: uncomment the TODO-bug block at lines 69–72.
- Run `yarn build` from the repo root.
- Run `yarn test` from the repo root and confirm:
  - `06.1.3-like-glob-edges.sqllogic` and `24.1-substr-extras.sqllogic` pass.
  - No regression in other LIKE/GLOB/substr tests.
  - The pre-existing `18-json-string-escapes.sqllogic` failure (unrelated) is the only remaining failure if it was failing at baseline.
- (Optional) `yarn lint` in `packages/quereus` if any incidental edits were made.
