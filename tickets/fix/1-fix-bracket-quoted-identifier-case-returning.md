description: Bracket-quoted [Name] identifier in RETURNING projection lowercases the column name; "Name" preserves case
prereq:
files:
  packages/quereus/test/logic/42.1-returning-extras.sqllogic
  packages/quereus/src/parser/lexer.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/planner/building/insert.ts
----
## Problem

`[Name]` bracket-quoted identifier in a RETURNING projection produces a lowercased column name in the result, while the equivalent `"Name"` double-quoted identifier preserves the original case.

The two quoting styles should be equivalent for case preservation. Bracket quoting is a SQLite-compatible identifier-quoting form and must round-trip the exact spelling supplied by the user, just as double quotes do.

## Expected behavior

```
create table quoted_cols (id integer primary key, "Name" text);
insert into quoted_cols values (2, 'second') returning id, [Name];
→ [{"id":2,"Name":"second"}]
```

The output key for the projected column should be `Name` (preserving case as written), not `name`.

## Reproduction

`packages/quereus/test/logic/42.1-returning-extras.sqllogic:47-49` — uncomment the TODO bug block. Compare with the passing case above (line 44) which uses `"Name"` with an explicit `as name_out` alias.

## Likely investigation areas

- `packages/quereus/src/parser/lexer.ts` — bracket-quoted identifier token construction. Check whether the bracket form preserves the original casing or normalises to lowercase, in contrast to the double-quote form.
- `packages/quereus/src/parser/parser.ts` — identifier node construction for projection expressions; ensure the original spelling is retained for use as the result column name when no explicit alias is supplied.
- RETURNING column-naming path in `packages/quereus/src/planner/building/insert.ts` (and update.ts/delete.ts) — verify the source-spelling, not a normalised lowercase form, is used when synthesising default output column names.
