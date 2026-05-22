description: Land a generative sqllogic matrix at `packages/quereus/test/logic/03.8-not-precedence.sqllogic` asserting that prefix-`not` placed in front of every predicate Quereus accepts (IN value-list, IN subquery, BETWEEN, LIKE/GLOB, IS [NOT] NULL, EXISTS, `=`/`==`/`<>`/`!=`/`<`/`<=`/`>`/`>=`) is semantically identical to wrapping the same predicate in `not (...)`, and (where it exists) identical to the SQL postfix-NOT form (`v not in`, `v not between`, `v not like`, `v is not null`). The matrix is the regression lock behind the parser fix in `fix-prefix-not-precedence-against-comparison` (issue #22), and will catch any future predicate added to the grammar that doesn't bind below prefix-NOT.
prereq: fix-prefix-not-precedence-against-comparison
files:
  packages/quereus/test/logic/03.8-not-precedence.sqllogic
  packages/quereus/test/logic/02-filters.sqllogic
  packages/quereus/src/parser/parser.ts
  packages/quereus/docs/architecture.md
----
## Background

The fix ticket has already landed:

- `packages/quereus/src/parser/parser.ts:1205` — prefix `NOT` is now its
  own level above `equality()`, recursing right into the same level so
  `not not P` stacks.
- `packages/quereus/test/logic/02-filters.sqllogic:52-72` — a small
  five-row witness for the reporter's case lives at the bottom of the
  filter sqllogic block.

This ticket expands that witness into the full predicate × form matrix
in a dedicated file. No production-code change is expected; the parser
is the one being verified.

## What lands

A single new file
`packages/quereus/test/logic/03.8-not-precedence.sqllogic` modelled on
`02-filters.sqllogic` (see lines 1–72 there for the style). It uses
the probe relation prescribed in the plan:

```sql
create table p (v any null);
insert into p values (5), (10), (null);
```

Each predicate block tests at minimum these three forms (or the two
forms where no postfix exists), and asserts identical output across
all rows:

| Predicate                    | A: prefix-NOT                                    | B: postfix-NOT (if any)        | C: parenthesised NOT                     |
|------------------------------|--------------------------------------------------|--------------------------------|------------------------------------------|
| `=`, `==`, `<>`, `!=`, `<`, `<=`, `>`, `>=` | `select v from p where not v op 5`               | —                              | `select v from p where not (v op 5)`     |
| `in (list)`                  | `select v from p where not v in (5, 7)`          | `... where v not in (5, 7)`    | `... where not (v in (5, 7))`            |
| `in (subquery)`              | `select v from p where not v in (select 5 union all select 7)` | `... v not in (...)`           | `... not (v in (...))`                   |
| `between … and …`            | `... where not v between 3 and 7`                | `... v not between 3 and 7`    | `... not (v between 3 and 7)`            |
| `like 'pat'`                 | `... where not v like '5'`                       | `... v not like '5'`           | `... not (v like '5')`                   |
| `glob 'pat'`                 | `... where not v glob '5'`                       | `... v not glob '5'`           | `... not (v glob '5')`                   |
| `is null`                    | `... where not v is null`                        | `... v is not null`            | `... not (v is null)`                    |
| `is not null`                | `... where not v is not null`                    | `... v is null` (double-neg)   | `... not (v is not null)`                |
| `exists (...)`               | `select (not exists (select 1 from p where v = 5)) as r` | —                              | `select (not (exists (select 1 from p where v = 5))) as r` |

For the comparison row, use `op` ∈ `{=, ==, <>, !=, <, <=, >, >=}` —
one query per operator, three forms × eight operators = 24 assertions.

The assertion strategy follows `02-filters.sqllogic`: each form is its
own `select` … `→ <json>` block, and the three (or two) forms in a
group share the same expected JSON. If any of A/B/C diverges, the
matching assertion fails with a unambiguous diff.

### Additional rows

- **Stacked NOT** — `select v from p where not not v = 5 order by v`
  must equal `select v from p where v = 5 order by v`. Smoke this for
  the `=` and `in (list)` predicates.
- **NOT bound by AND** — `select count(*) from p where not v = 5 and
  v < 100` must return `2` (excludes only `v=5`; `v=null` fails the
  AND on three-valued logic, leaves `v=10`). Compare against
  `select count(*) from p where not (v = 5 and v < 100)` (returns
  `3` — null also fails the inner AND, so `not` of UNKNOWN is UNKNOWN
  for the null row, leaving two non-null rows where the conjunction
  is false → `not` true). Document the expected count next to each
  assertion so a future reader doesn't have to re-derive it.
- **De Morgan / parenthesised** — `select v from p where not (v in
  (5, 7) or v = 10) order by v` vs `select v from p where (not v in
  (5, 7)) and not v = 10 order by v`. Both should return `[]` (every
  non-null row hits one branch; the null row is UNKNOWN on both sides
  and so excluded). Comment on the null-row expectation explicitly.

### Three-valued logic — NULL probes

Every block must exercise the NULL row. The plan's NULL invariants:

- `not (NULL = 5)` is `NULL`, not `false`.
- `not NULL in (5, 7)` is `NULL`.
- `not NULL is null` is `false` (inner is `true`).

In sqllogic, NULL appears as `null` in the JSON output. The probe
table seeds NULL exactly once, so each block's full result reveals
the three-valued behaviour without needing a separate NULL-only test.
For the count-based assertions (NOT-bound-by-AND, De Morgan), state
the expected count explicitly because NULL handling is the tricky
part.

## Implementation notes

- Mirror the section layout of `02-filters.sqllogic` — top comment,
  `-- ------…` dividers, predicate-name headers, blank-line spacing
  between assertions.
- Order results explicitly (`order by v` or by some deterministic
  expression) wherever multiple rows are returned — sqllogic compares
  arrays positionally.
- For predicates that don't probe well against `any null` typed
  columns (e.g. `like` against integers), cast on the way in
  (`like cast(v as text)`) rather than changing the probe schema —
  the goal is to keep one probe relation. If a cast itself changes
  truth-value semantics in a way that obscures the equivalence test,
  fall back to a small per-block ad-hoc relation, but call out the
  reason in a comment.
- `regexp` is *not* required — it isn't in the parser's
  `comparison()` postfix set (verify with `find_references regexp` in
  parser.ts before adding); if present, add a row. If absent, leave a
  comment row stub so the next person to add it knows where it
  belongs.
- Remove (or shrink) the five-row regression witness currently in
  `02-filters.sqllogic:52-72`. Keep a single one-liner there pointing
  at `03.8-not-precedence.sqllogic` so future readers of
  `02-filters` aren't surprised by the relocation. Don't duplicate
  the assertions across both files.

## Doc updates

- `packages/quereus/docs/architecture.md` § "Testing Strategy" — add
  `03.8-not-precedence.sqllogic` to the SQL-logic file list (if the
  list enumerates files). If the section is high-level only, no edit
  required — verify by reading the section first.

## Out of scope

- AND/OR/NOT precedence beyond the one "NOT binds to the immediate
  predicate" assertion above. Covered by
  `test/optimizer/predicate-normalizer.spec.ts` at a different layer.
- Bitwise `~` precedence — unrelated operator.
- Postfix `IS [NOT] {TRUE|FALSE|UNKNOWN}` — not currently parsed.

## Validation

- `yarn workspace @quereus/quereus run test` must pass — every new
  assertion green on first run, because the prereq fix is already in.
- A *negative* control: temporarily revert the parser fix locally
  (move prefix-NOT recursion back into `unary()`), confirm the new
  file's assertions go red for the IN-subquery, IN-list, BETWEEN,
  LIKE, IS-NULL, and EXISTS rows, then restore. Don't commit the
  revert. Note the negative-control result in the review handoff so
  the reviewer can verify the matrix actually has teeth.
- Lint: `yarn workspace @quereus/quereus run lint` (only quereus has
  lint).

## TODO

- [ ] Read `02-filters.sqllogic` and `03.4-defaults.sqllogic` (or
      another nearby file) to nail the prevailing style.
- [ ] Confirm the parser fix is in place at
      `packages/quereus/src/parser/parser.ts:1205` (prefix-NOT level
      between AND/OR and equality, right-recursive).
- [ ] Verify which pattern operators (`like` / `glob` / `regexp`) the
      parser actually exposes as `comparison()` postfix. Use
      `find_references` on each in `parser.ts`.
- [ ] Create `packages/quereus/test/logic/03.8-not-precedence.sqllogic`
      with the probe relation and one section per predicate kind
      from the table above (comparison ops, IN list, IN subquery,
      BETWEEN, LIKE, GLOB, IS NULL, IS NOT NULL, EXISTS, stacked NOT,
      NOT-bound-by-AND, De Morgan).
- [ ] Add explicit `order by` to every multi-row select; add inline
      comments explaining the NULL-row expectation for each block.
- [ ] Trim the redundant witness in `02-filters.sqllogic:52-72` to a
      one-line pointer at the new file.
- [ ] Run `yarn workspace @quereus/quereus run test 2>&1 | tee
      /tmp/not-matrix.log` and confirm green.
- [ ] Run the negative-control revert/restore described in §
      Validation and record the result for the reviewer.
- [ ] Run `yarn workspace @quereus/quereus run lint` (single-quote
      globs on Windows).
- [ ] If `docs/architecture.md` § Testing Strategy enumerates files,
      add the new one.
