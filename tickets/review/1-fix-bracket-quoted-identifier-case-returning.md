description: RETURNING projection now preserves the case of the user's spelling for output column names; bracket-quoted [Name] / double-quoted "Name" / aliases / NEW.x / OLD.x all round-trip case as written
prereq:
files:
  packages/quereus/src/planner/building/insert.ts
  packages/quereus/src/planner/building/update.ts
  packages/quereus/src/planner/building/delete.ts
  packages/quereus/src/planner/nodes/returning-node.ts
  packages/quereus/test/logic/42-returning.sqllogic
  packages/quereus/test/logic/42.1-returning-extras.sqllogic
----
## What changed

RETURNING used to force every output column name to lowercase (in two redundant places). That produced bugs visible to users: `INSERT ... RETURNING [Name]` returned `name`; `RETURNING NEW.value AS NewValue` returned `newvalue`. Output column names now match the spelling supplied by the user, consistent with `ProjectNode` for SELECT.

The lowercasing happened in:
- `building/insert.ts:625-632` — synthesised alias from `rc.expr` was forced to lowercase.
- `building/update.ts:265-272` — same.
- `building/delete.ts:227-232` — same.
- `nodes/returning-node.ts:55-73` — `buildOutputType()` called `.toLowerCase()` again on the alias and on column expression names.

Both layers were doing the same case-folding; both were removed. Resolution / matching is still case-insensitive — the change only affects the **output** column name shown to callers (the JSON key in result rows).

## Use cases / behavioural expectations

- `returning [Name]` → output key is `Name` (was `name`)
- `returning "Name"` (no alias) → output key is `Name` (was `name`)
- `returning NEW.value AS NewValue` → output key is `NewValue` (was `newvalue`)
- `returning NEW.value, OLD.value` → output keys are `NEW.value`, `OLD.value` (were `new.value`, `old.value`)
- `returning name` (unquoted, lowercase) → output key is `name` (unchanged — case-preserving, and the user wrote lowercase)
- `returning name as item_name` → output key is `item_name` (unchanged)

This matches SQLite/PostgreSQL conventions that RETURNING output column names reflect the user's spelling.

## Tests

- `42.1-returning-extras.sqllogic:47-49` — TODO bug block enabled; asserts `[Name]` round-trips as `Name`.
- `42-returning.sqllogic:135-157` — six pre-existing assertions updated from lowercased keys to case-preserving keys (`OLD.value`, `NEW.value`, `NewValue`, `OldValue`, etc.). The "case normalization" comments have been replaced with "case preservation" comments.

## Validation

- `yarn build` clean
- `npx tsc --noEmit` clean
- `npx eslint` clean on the four modified source files
- `yarn test`: 596 pass, 1 fail. The one failure is `18-json-string-escapes.sqllogic:13` (`json_quote('String "\\ Test')`), which is pre-existing on `main` and unrelated — confirmed by stashing the changes and re-running.

## Review focus

- Confirm `ReturningNode.buildOutputType` mirrors the simpler `ProjectNode.buildOutputType` pattern for naming (alias > column-ref name > `expressionToString`) and that duplicate-name handling still works (case-sensitive bucket counter, matching SELECT).
- Confirm there's no remaining downstream consumer that relied on RETURNING output names being lowercased (e.g. driver/CLI code keyed by lowercase names). Search `getAttributes()` uses on `ReturningNode` if any.
- Confirm that the case-insensitive *matching* of output columns (e.g. wrapping a RETURNING in another query, or driver column lookup) still works regardless of case in the output name.
