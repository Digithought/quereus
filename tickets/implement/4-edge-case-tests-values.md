description: Edge-case sqllogic tests for NULL semantics, boundary values, and mixed-type expressions
dependencies: none
files:
  - packages/quereus/test/logic/21-null-edge-cases.sqllogic (new)
  - packages/quereus/test/logic/22-boundary-values.sqllogic (new)
  - packages/quereus/test/logic/03-expressions.sqllogic (reference — has some NULL basics)
  - packages/quereus/test/logic/03.6-type-system.sqllogic (reference)
  - packages/quereus/test/logic/03.7-bigint-mixed-arithmetic.sqllogic (reference)
----

Create two new sqllogic test files covering value-level edge cases.

**Format notes:**
- Results use `→ [json_array]` on the line after the query
- Empty results: `→ []`
- NULL is `null` in JSON output
- Error expectations: `-- error: substring` on line after the SQL
- Use lowercase SQL keywords
- RIGHT JOIN is NOT supported — skip it
- Duplicate column names in joins get `:1` suffix

---

## File 1: `packages/quereus/test/logic/21-null-edge-cases.sqllogic`

Systematically tests NULL behavior in every SQL position. Existing coverage in `03-expressions.sqllogic` covers IS NULL, COALESCE, NULLIF, NULL arithmetic, and NULL logic basics. This file goes deeper.

Setup: create tables with nullable columns and rows containing NULLs:
- `n1 (id INTEGER PRIMARY KEY, val INTEGER NULL, txt TEXT NULL)`
- Insert rows: `(1, 10, 'a'), (2, null, 'b'), (3, 30, null), (4, null, null)`

### NULL in join keys

- `n2 (id INTEGER PRIMARY KEY, ref INTEGER NULL)` with `(1, 10), (2, null), (3, 30)`
- INNER JOIN n1 × n2 ON n1.val = n2.ref → NULL keys should NOT match (only val=10→ref=10 and val=30→ref=30)
- LEFT JOIN n1 × n2 ON n1.val = n2.ref → rows with null val get null on right
- Both sides NULL: verify NULLs don't join (NULL ≠ NULL in joins)

### NULL in GROUP BY key

- `select val, count(*) from n1 group by val order by val;` → NULLs grouped together into one group
- Verify NULL group appears (null vals are id=2 and id=4)

### NULL in ORDER BY column

- `select * from n1 order by val;` → NULLs first or last (check engine behavior)
- `select * from n1 order by val nulls first;`
- `select * from n1 order by val nulls last;`
- `select * from n1 order by txt desc nulls first;`

### NULL in CASE WHEN

- `select case when null then 'yes' else 'no' end;` → 'no' (NULL is falsy)
- `select case when val is null then 'missing' else 'present' end from n1 order by id;`
- `select case null when null then 'match' else 'no match' end;` → 'no match' (NULL ≠ NULL in simple CASE)
- CASE with NULL result branch: `select case when id = 2 then null else val end from n1 order by id;`

### NULL in IN list and as IN operand

- `select * from n1 where val in (10, null, 30) order by id;` → rows with val=10 and val=30 (NULL in list doesn't match)
- `select * from n1 where val not in (10, null) order by id;` → tricky! NOT IN with NULL in list should return no rows for non-matching values because `val NOT IN (10, NULL)` → `val <> 10 AND val <> NULL` → unknown for all
- `select * from n1 where null in (1, 2, 3);` → `[]` (NULL operand)

### NULL in aggregate arguments

- `select count(val) from n1;` → 2 (skips NULLs)
- `select count(*) from n1;` → 4 (counts all rows)
- `select sum(val) from n1;` → 40 (skips NULLs)
- `select avg(val) from n1;` → 20 (40/2, skips NULLs)
- `select min(val) from n1;` → 10
- `select max(val) from n1;` → 30
- `select group_concat(txt, ',') from n1;` → 'a,b' (skips NULLs, order may vary — use ORDER BY in subquery if needed)

### NULL in window function ORDER BY / PARTITION BY

- `select id, val, row_number() over (partition by val order by id) from n1 order by id;`
  → NULL vals partitioned together
- `select id, val, rank() over (order by val) from n1 order by id;`
  → NULLs get same rank

### NULL in COALESCE chains

- `select coalesce(null);` → null
- `select coalesce(null, null, null);` → null
- `select coalesce(null, null, 'found');` → 'found'
- `select coalesce(val, txt, 'default') from n1 order by id;` → per-row cascade

### NULL with every comparison operator

- `select null = null;` → null
- `select null <> null;` → null
- `select null < 1;` → null
- `select null > 1;` → null
- `select null <= 1;` → null
- `select null >= 1;` → null
- `select null is null;` → true
- `select null is not null;` → false
- `select 1 is null;` → false
- `select 1 is not null;` → true

### NULL in DISTINCT

- `select distinct val from n1 order by val;` → should include one NULL (NULLs are equal for DISTINCT)

### NULL in subqueries

- EXISTS with subquery returning null rows: `select exists (select null);` → true (row exists, value doesn't matter)
- Scalar subquery returning null: `select (select null);` → null
- IN with null subquery result: `select 1 in (select null);` → null (unknown)

Clean up tables.

---

## File 2: `packages/quereus/test/logic/22-boundary-values.sqllogic`

Tests boundary values for each type, plus mixed-type expression edge cases.

### INTEGER boundaries

- Setup: `b_int (id INTEGER PRIMARY KEY, val INTEGER)`
- Insert: 0, -1, 1, 9007199254740991 (MAX_SAFE_INTEGER), -9007199254740991 (MIN_SAFE_INTEGER)
- `select val from b_int order by val;` → correct ordering
- Arithmetic at boundaries: `select 9007199254740991 + 0;`, `select -9007199254740991 - 0;`
- `select 0 * 9007199254740991;` → 0
- `select -1 * -1;` → 1
- Comparison: `select 9007199254740991 > -9007199254740991;` → true

### REAL boundaries

- Setup: `b_real (id INTEGER PRIMARY KEY, val REAL)`
- Insert: 0.0, -0.0 (if distinguishable), very small (1e-15), very large (1e15), fractional (0.1 + 0.2)
- `select val from b_real order by val;`
- `select 0.1 + 0.2;` — test floating point behavior (typically 0.30000000000000004)
- `select cast(0.0 as real) = cast(-0.0 as real);` → true (IEEE 754: 0.0 == -0.0)

### TEXT boundaries

- Setup: `b_text (id INTEGER PRIMARY KEY, val TEXT)`
- Empty string: `insert into b_text values (1, '');`
- `select val = '' from b_text where id = 1;` → true
- `select length('');` → 0
- `select '' is null;` → false (empty string ≠ NULL)
- `select '' = null;` → null
- Single char: `select length('x');` → 1
- String with embedded single quotes: `select 'it''s';` → "it's"
- Unicode: `select length('héllo');`

### BLOB boundaries

- Empty blob: `select typeof(x'');` → 'blob'
- `select length(x'');` → 0
- Single byte: `select length(x'FF');` → 1
- `select x'' = x'';` → true

### Mixed-type arithmetic

- `select 1 + 1.5;` → 2.5 (integer + real → real)
- `select 10 / 3;` → integer division (3)
- `select 10 / 3.0;` → real division (3.333...)
- `select 10.0 / 3;` → real division
- `select 1 + '2';` — type coercion behavior (depends on engine)

### Cross-type comparisons

- `select 1 = 1.0;` → true
- `select 1 < 1.5;` → true
- `select typeof(1), typeof(1.0), typeof('1');` — verify types

### CASE with branches returning different types

- `select case when 1=1 then 42 else 'text' end;` → 42 (integer)
- `select case when 1=0 then 42 else 'text' end;` → 'text'
- `select typeof(case when 1=1 then 42 else 'text' end);` → 'integer'
- `select typeof(case when 1=0 then 42 else 'text' end);` → 'text'

### UNION where corresponding columns have different types

- `select 1 as v union all select 'text' as v;` → mixed types in same column
- `select typeof(v) from (select 1 as v union all select 'text' as v) order by v;`

Clean up tables.

## TODO

- Create `packages/quereus/test/logic/21-null-edge-cases.sqllogic`
- Create `packages/quereus/test/logic/22-boundary-values.sqllogic`
- Run `yarn test` to verify tests pass (failing tests are acceptable per project test philosophy — note failures)
