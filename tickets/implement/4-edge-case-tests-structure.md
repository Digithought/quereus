description: Edge-case sqllogic tests for self-joins, duplicates, correlated subqueries, and CTE edge cases
dependencies: none
files:
  - packages/quereus/test/logic/23-self-joins-duplicates.sqllogic (new)
  - packages/quereus/test/logic/07.8-correlated-subquery-edges.sqllogic (new)
  - packages/quereus/test/logic/13.3-cte-edge-cases.sqllogic (new)
  - packages/quereus/test/logic/07.6-subqueries.sqllogic (reference — existing correlated subquery basics)
  - packages/quereus/test/logic/13-cte.sqllogic (reference — existing CTE basics)
  - packages/quereus/test/logic/08.1-semi-anti-join.sqllogic (reference)
----

Create three new sqllogic test files covering query-structure edge cases.

**Format notes:**
- Results use `→ [json_array]` on the line after the query
- Empty results: `→ []`
- NULL is `null` in JSON
- Error expectations: `-- error: substring` on line after the SQL
- Use lowercase SQL keywords
- RIGHT JOIN is NOT supported — skip it
- Duplicate column names in joins get `:1` suffix

---

## File 1: `packages/quereus/test/logic/23-self-joins-duplicates.sqllogic`

### Self-joins

Setup: `emp (id INTEGER PRIMARY KEY, name TEXT, manager_id INTEGER NULL)`
Insert: `(1, 'Alice', null), (2, 'Bob', 1), (3, 'Carol', 1), (4, 'Dave', 2)`

- **Basic self-join with aliases:**
  `select e.name as employee, m.name as manager from emp e join emp m on e.manager_id = m.id order by e.id;`
  → Bob→Alice, Carol→Alice, Dave→Bob

- **Self-join with LEFT to include root (no manager):**
  `select e.name as employee, m.name as manager from emp e left join emp m on e.manager_id = m.id order by e.id;`
  → Alice→null, Bob→Alice, Carol→Alice, Dave→Bob

- **Self-join with aggregation — count direct reports:**
  `select m.name, count(e.id) as reports from emp m left join emp e on e.manager_id = m.id group by m.id, m.name order by m.name;`

- **Correlated subquery referencing outer same-table:**
  `select e.name, (select count(*) from emp sub where sub.manager_id = e.id) as direct_reports from emp e order by e.id;`

- **Multi-level self-join (grandparent):**
  `select e.name, m.name as manager, gm.name as grand_manager from emp e left join emp m on e.manager_id = m.id left join emp gm on m.manager_id = gm.id order by e.id;`

### Duplicate values

Setup: `d (id INTEGER PRIMARY KEY, grp TEXT, val INTEGER)`
Insert rows with duplicate grp and val values:
`(1,'A',10), (2,'A',10), (3,'A',20), (4,'B',10), (5,'B',10), (6,'B',10)`

- **GROUP BY with all-duplicate keys:**
  `select grp, count(*) from d group by grp order by grp;`
  → A:3, B:3

- **GROUP BY on all-duplicate column:**
  `select val, count(*) from d where grp = 'B' group by val;`
  → 10:3 (all same)

- **DISTINCT on all-duplicate column:**
  `select distinct val from d where grp = 'B';`
  → just [10]

- **ORDER BY on column with ties:**
  `select id, val from d order by val, id;`
  → Deterministic with secondary sort on id

- **ORDER BY with only ties (no tiebreaker) — verify all rows returned:**
  `select val from d where grp = 'B' order by val;`
  → 3 rows, all 10

- **JOIN with many-to-many matching keys:**
  Create `d2 (id INTEGER PRIMARY KEY, grp TEXT, val2 INTEGER)` with same grp values
  `(1,'A',100), (2,'A',200), (3,'B',300)`
  `select d.id, d2.id from d join d2 on d.grp = d2.grp order by d.id, d2.id;`
  → cartesian within each group: A has 3×2=6 rows, B has 3×1=3 rows = 9 total

- **IN subquery returning duplicates — should behave same as distinct:**
  `select * from d where val in (select val from d) order by id;`
  → all 6 rows

- **DISTINCT with multiple columns:**
  `select distinct grp, val from d order by grp, val;`
  → (A,10), (A,20), (B,10)

Clean up tables.

---

## File 2: `packages/quereus/test/logic/07.8-correlated-subquery-edges.sqllogic`

Extends the basic coverage in `07.6-subqueries.sqllogic` with edge cases.

Setup:
- `o (id INTEGER PRIMARY KEY, cat TEXT)` — outer table
  Insert: `(1, 'X'), (2, 'Y'), (3, 'X')`
- `i (id INTEGER PRIMARY KEY, o_id INTEGER NULL, val INTEGER)` — inner table
  Insert: `(10, 1, 100), (20, 1, 200), (30, 2, 300), (40, null, 400)`

### Correlated subquery with empty correlation

- Outer row produces no match in inner:
  `select o.id, (select sum(val) from i where i.o_id = o.id) from o order by o.id;`
  → id=3 should return null for sum (no matching inner rows)

### Multi-level correlation

- Subquery of subquery referencing outermost table:
  ```
  select o.id,
    (select count(*) from i i1
     where i1.o_id = o.id
     and i1.val > (select min(val) from i i2 where i2.o_id = o.id)
    ) as cnt
  from o order by o.id;
  ```
  → For o.id=1: inner vals are 100,200, min=100, count where val>100 = 1 (val=200)

### Correlated EXISTS vs IN equivalence

- These two should return the same results:
  `select id from o where exists (select 1 from i where i.o_id = o.id) order by id;`
  `select id from o where id in (select o_id from i where o_id is not null) order by id;`
  → Both: [1, 2]

### Correlated subquery in different positions

- **In SELECT list:**
  `select o.id, (select max(val) from i where i.o_id = o.id) as max_val from o order by o.id;`

- **In WHERE:**
  `select * from o where (select count(*) from i where i.o_id = o.id) > 1 order by o.id;`
  → only id=1 (has 2 inner rows)

- **In HAVING:**
  `select o.cat, count(*) as cnt from o group by o.cat having count(*) > (select 1) order by o.cat;`
  → X has count 2, Y has count 1 → only X

- **Correlated subquery with aggregation that returns NULL for no-match:**
  `select o.id, coalesce((select sum(val) from i where i.o_id = o.id), 0) as total from o order by o.id;`
  → id=3 returns 0 (coalesced from null)

### NOT IN with NULLs in subquery

- This is a classic SQL gotcha:
  `select * from o where id not in (select o_id from i);`
  → Should return empty! Because i has o_id=NULL, and `x NOT IN (..., NULL)` is UNKNOWN for all x

- Compare with NOT IN excluding NULLs:
  `select * from o where id not in (select o_id from i where o_id is not null) order by id;`
  → Should return id=3

Clean up tables.

---

## File 3: `packages/quereus/test/logic/13.3-cte-edge-cases.sqllogic`

Extends existing CTE coverage in `13-cte.sqllogic` with edge cases.

Setup: `ct (id INTEGER PRIMARY KEY, val TEXT, parent_id INTEGER NULL)`
Insert: `(1, 'root', null), (2, 'child1', 1), (3, 'child2', 1), (4, 'leaf', 2)`

### CTE referenced multiple times in same query

```
with shared as (select id, val from ct where parent_id is not null)
select a.id, b.id
from shared a cross join shared b
where a.id < b.id
order by a.id, b.id;
```
→ Cross-product of shared with itself (filtered), verifying the CTE is properly materialized/reusable

### CTE referencing another CTE

```
with
  cte1 as (select id, val from ct where id <= 2),
  cte2 as (select id, val from cte1 where id = 1)
select * from cte2;
```
→ [{"id":1,"val":"root"}]

### CTE chain of 3

```
with
  a as (select id from ct),
  b as (select id from a where id > 1),
  c as (select id from b where id > 2)
select * from c order by id;
```
→ [{"id":3},{"id":4}]

### Recursive CTE: 0 iterations

```
with recursive r(n) as (
  select 1 where false
  union all
  select n + 1 from r where n < 5
)
select * from r;
```
→ [] (base case produces 0 rows, recursion never starts)

### Recursive CTE: 1 iteration

```
with recursive r(n) as (
  select 1
  union all
  select n + 1 from r where n < 1
)
select * from r;
```
→ [{"n":1}] (base case produces 1 row, recursive step produces 0)

### CTE with EXISTS check (not selecting columns from CTE)

```
with data as (select id from ct where val = 'root')
select exists (select 1 from data) as has_root;
```
→ [{"has_root":true}]

```
with data as (select id from ct where val = 'nonexistent')
select exists (select 1 from data) as has_it;
```
→ [{"has_it":false}]

### CTE used in different statement types

- CTE in UPDATE (if supported):
  ```
  create table ct_target (id INTEGER PRIMARY KEY, val TEXT);
  insert into ct_target values (1, 'old');
  with src as (select val from ct where id = 1)
  update ct_target set val = (select val from src) where id = 1;
  select * from ct_target;
  ```
  → [{"id":1,"val":"root"}]

- CTE in DELETE (if supported):
  ```
  with to_del as (select id from ct_target)
  delete from ct_target where id in (select id from to_del);
  select count(*) from ct_target;
  ```
  → [{"count(*)":0}]

### CTE with set operations

```
with
  a as (select id from ct where id <= 2),
  b as (select id from ct where id >= 2)
select id from a
union
select id from b
order by id;
```
→ [{"id":1},{"id":2},{"id":3},{"id":4}]

```
with
  a as (select id from ct where id <= 2),
  b as (select id from ct where id >= 2)
select id from a
intersect
select id from b
order by id;
```
→ [{"id":2}]

Clean up tables.

## TODO

- Create `packages/quereus/test/logic/23-self-joins-duplicates.sqllogic`
- Create `packages/quereus/test/logic/07.8-correlated-subquery-edges.sqllogic`
- Create `packages/quereus/test/logic/13.3-cte-edge-cases.sqllogic`
- Run `yarn test` to verify tests pass (failing tests are acceptable per project test philosophy — note failures)
