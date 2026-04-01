description: Edge-case sqllogic tests for empty tables, single-row tables, and empty set operations
dependencies: none
files:
  - packages/quereus/test/logic/20-empty-single-row.sqllogic (new)
  - packages/quereus/test/logic/11-joins.sqllogic (reference for format)
  - packages/quereus/test/logic/07-aggregates.sqllogic (reference for aggregate syntax)
  - packages/quereus/test/logic/07.5-window.sqllogic (reference for window syntax)
  - packages/quereus/test/logic/09-set_operations.sqllogic (reference for set ops syntax)
  - packages/quereus/test/logic/13-cte.sqllogic (reference for CTE syntax)
----

Create `packages/quereus/test/logic/20-empty-single-row.sqllogic` covering table cardinality edge cases that commonly trigger bugs.

**Format notes:**
- Results use `→ [json_array]` on the line after the query
- Empty results: `→ []`
- Objects: `→ [{"col": value}]`
- Error expectations: `-- error: substring` on line after the SQL
- Comments: `--` prefix
- Clean up tables at end with DROP TABLE
- Use lowercase SQL keywords
- Duplicate column names in joins get `:1` suffix: `{"id":1,"id:1":2}`
- RIGHT JOIN is NOT supported — skip it

### Test structure for empty tables (0 rows)

Setup: create an empty table `e (id INTEGER PRIMARY KEY, val TEXT, num INTEGER)` — no inserts.

1. **SELECT from empty table** — with and without WHERE
   - `select * from e;` → `[]`
   - `select * from e where id > 0;` → `[]`
   - `select id, val from e;` → `[]`

2. **Aggregates over empty table**
   - `select count(*) from e;` → `[{"count(*)":0}]`
   - `select count(val) from e;` → `[{"count(val)":0}]`
   - `select sum(num) from e;` → `[{"sum(num)":null}]`
   - `select avg(num) from e;` → `[{"avg(num)":null}]`
   - `select min(num) from e;` → `[{"min(num)":null}]`
   - `select max(num) from e;` → `[{"max(num)":null}]`
   - `select group_concat(val, ',') from e;` → `[{"group_concat(val, ',')":null}]`
   - Multiple aggregates in one query: `select count(*), sum(num), min(val) from e;`

3. **JOINs where one or both sides are empty**
   - Create a populated table `p (id INTEGER PRIMARY KEY, val TEXT)` with a few rows
   - INNER JOIN empty × populated → `[]`
   - INNER JOIN populated × empty → `[]`
   - LEFT JOIN populated × empty → rows with null on right side
   - LEFT JOIN empty × populated → `[]`
   - CROSS JOIN empty × populated → `[]`
   - CROSS JOIN populated × empty → `[]`
   - INNER JOIN empty × empty → `[]`

4. **Subqueries returning empty**
   - `select * from p where id in (select id from e);` → `[]`
   - `select * from p where exists (select 1 from e);` → `[]`
   - `select * from p where not exists (select 1 from e);` → all rows
   - Scalar subquery from empty: `select (select val from e);` → `[{"(select val from e)":null}]`

5. **CTE producing 0 rows**
   - `with empty_cte as (select * from e) select count(*) from empty_cte;` → `[{"count(*)":0}]`
   - CTE empty joined with populated table

6. **Set operations with empty side**
   - `select id from e union select id from p order by id;` → p's rows
   - `select id from p union select id from e order by id;` → p's rows
   - `select id from e intersect select id from p;` → `[]`
   - `select id from e except select id from p;` → `[]`
   - `select id from e union all select id from e;` → `[]`

7. **DML on empty table**
   - `update e set val = 'x' where id = 1;` — should succeed (0 affected)
   - `delete from e where id = 1;` — should succeed (0 affected)
   - Verify table still empty after DML: `select count(*) from e;` → 0

8. **INSERT ... SELECT from empty source**
   - `insert into p select * from e;` — should succeed (0 rows inserted)
   - Verify p unchanged

9. **Window functions over empty result set**
   - `select id, row_number() over (order by id) from e;` → `[]`
   - `select id, sum(num) over () from e;` → `[]`

### Test structure for single-row tables

Setup: create table `s (id INTEGER PRIMARY KEY, val TEXT, num INTEGER)` with one row `(1, 'only', 42)`.

1. **All join types with single-row on one or both sides**
   - Create `s2 (id INTEGER PRIMARY KEY, val TEXT)` with one row
   - INNER JOIN s × s2 with matching condition → 1 row
   - INNER JOIN s × s2 with non-matching condition → `[]`
   - LEFT JOIN s × s2 matching → 1 row
   - LEFT JOIN s × s2 non-matching → 1 row with nulls
   - CROSS JOIN s × s2 → 1 row
   - CROSS JOIN s × multi-row table → multi rows
   - Join with populated table `p` on matching key → 1 row

2. **GROUP BY on single row**
   - `select val, count(*) from s group by val;` → 1 group
   - `select val, sum(num) from s group by val;` → 1 group
   - GROUP BY with HAVING that matches → 1 row
   - GROUP BY with HAVING that doesn't match → `[]`

3. **Window functions with single-row partition**
   - `select id, row_number() over (order by id) from s;` → rn = 1
   - `select id, rank() over (order by id) from s;` → rank = 1
   - `select id, sum(num) over () from s;` → 42
   - `select id, lag(num) over (order by id) from s;` → null (no previous)
   - `select id, lead(num) over (order by id) from s;` → null (no next)

Clean up all tables at end.

## TODO

- Create `packages/quereus/test/logic/20-empty-single-row.sqllogic` with all test cases above
- Run `yarn test` from project root to verify tests pass (or if any fail, note which ones fail and why — failing tests are acceptable per the project's test philosophy as they indicate features to implement)
