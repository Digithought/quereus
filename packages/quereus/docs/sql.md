# Quereus SQL Reference Guide

## 1. Introduction

Quereus is a lightweight, TypeScript-native SQL engine inspired by SQLite, with a focus on in-memory data processing and extensibility via the virtual table (VTab) interface. It supports a rich subset of SQL for querying, manipulating, and joining data from virtual tables, with async operations and modern JavaScript/TypeScript idioms. Quereus is designed for use in Node.js, browsers, and other JS environments, and does not provide persistent file storage by default.

Key features:
- **Virtual Table Centric:** All data access is via virtual tables, which can be backed by memory, JSON, or custom sources.
- **In-Memory Focus:** No built-in file storage; all tables are transient unless a VTab module provides persistence.
- **Rich SQL Subset:** Supports select, insert, update, delete, CTEs, joins, aggregates, subqueries, and more.
- **Extensible:** Register custom functions, collations, and virtual table modules.
- **Asynchronous:** Database operations are async/await compatible, allowing non-blocking I/O.

## 2. SQL Statement Reference

### 2.1 SELECT Statement

The select statement retrieves data from one or more tables or views.

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
select [distinct | all] select_expr [, select_expr ...]
[ from table_reference [, table_reference...] ]
[ where condition ]
[ group by expr [, expr...] ]
[ having condition ]
[ order by expr [asc | desc] [, expr [asc | desc]...] ]
[ limit count [offset skip] | limit skip, count ]
[ union [all] select_statement ]
```

**Options:**
- `with clause`: Common Table Expressions (CTEs) for temporary named result sets
- `distinct`: Removes duplicate rows from the result set
- `all`: Includes all rows (default behavior)
- `select_expr`: Column expressions to be returned; `*` for all columns
- `from`: Tables, views, or subqueries to retrieve data from
- `where`: Filters rows based on a condition
- `group by`: Groups rows that have the same values
- `having`: Filters groups based on a condition
- `order by`: Sorts the result set
- `limit/offset`: Restricts the number of rows returned
- `union`: Combines the results of two select statements

**Examples:**
```sql
-- Basic select with where clause
select id, name, age from users where age > 21;

-- Select with join
select u.name, o.product 
  from users as u
  inner join orders as o on u.id = o.userId
  where o.status = 'shipped';

-- Group by with aggregates
select department, count(*) as employeeCount, avg(salary) as avgSalary
  from employees
  group by department
  having count(*) > 5
  order by avgSalary desc;

-- With CTE and union
with active_users as (
  select * from users where status = 'active'
)
  select name, email from active_users where age < 30
  union all
  select name, email from premium_users where subscriptionStatus = 'paid';
```

### 2.2 INSERT Statement

The insert statement adds new rows to a table.

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
  insert into table_name [(column [, column...])]
  { values (expr [, expr...]) [, (expr [, expr...])]... | select_statement }
```

**Options:**
- `with clause`: Common Table Expressions for use in the insert
- `table_name`: Target table for the insertion
- `column`: Optional list of columns to insert into
- `values`: A list of value sets to insert
- `select_statement`: A select query whose results are inserted

**Examples:**
```sql
-- Basic insert with explicit columns
insert into users (name, email, age) values ('John', 'john@example.com', 35);

-- Multiple rows insert
insert into products (name, price, category) 
  values 
    ('Keyboard', 49.99, 'Electronics'),
    ('Mouse', 29.99, 'Electronics'),
    ('Headphones', 99.99, 'Audio');

-- Insert from select
insert into active_users (id, name, email)
  select id, name, email from users where last_login > date('now', '-30 days');

-- With CTE
with recent_orders as (
  select * from orders where order_date > date('now', '-7 days')
)
  insert into order_summary (order_id, customer, total)
    select id, customer_name, sum(price * quantity) 
    from recent_orders
    group by id, customer_name;
```

### 2.3 UPDATE Statement

The update statement modifies existing rows in a table.

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
  update table_name
    set column = expr [, column = expr...]
    [ where condition ]
```

**Options:**
- `with clause`: Common Table Expressions for use in the update
- `table_name`: Table to be updated
- `set`: Column assignments with new values
- `where`: Optional condition to specify which rows to update

**Examples:**
```sql
-- Simple update
update users set status = 'inactive' where last_login < date('now', '-90 days');

-- Multi-column update
update products 
  set price = price * 1.1, 
      updated_at = datetime('now')
  where category = 'Electronics';

-- Update with expression
update orders
  set 
    total = (select sum(price * quantity) from order_items where order_id = orders.id),
    status = case 
      when paid = 1 then 'completed' 
      else 'pending' 
    end
  where order_date > date('now', '-30 days');

-- With CTE
with discounted_items as (
  select product_id, price * 0.8 as sale_price
  from products
  where category = 'Clearance'
)
  update products
    set price = di.sale_price
    from discounted_items as di
    where products.id = di.product_id;
```

### 2.4 DELETE Statement

The delete statement removes rows from a table.

**Syntax:**
```sql
[ with [recursive] with_clause[,...] ]
delete from table_name
[ where condition ]
```

**Options:**
- `with clause`: Common Table Expressions for use in the delete
- `table_name`: Table to delete from
- `where`: Optional condition to specify which rows to delete

**Examples:**
```sql
-- Simple delete
delete from users where status = 'deactivated';

-- Delete with subquery
delete from products
  where id in (
    select product_id 
    from inventory 
    where stock = 0 and last_updated < date('now', '-180 days')
  );

-- With CTE
with old_orders as (
  select id from orders where order_date < date('now', '-365 days')
)
  delete from order_items
  where order_id in (select id from old_orders);
```

### 2.5 CREATE TABLE Statement

The create table statement defines a new table structure.  Note that all tables are "without rowid" implicitly.

**Syntax:**
```sql
create [temp | temporary] table [if not exists] table_name (
  column_definition [, column_definition...]
  [, table_constraint...]
)
[using module_name [(module_args...)]]
```

**Column Definition:**
```sql
column_name [data_type] [column_constraint...]
```

**Column Constraints:**
```sql
[constraint name]
{ primary key [asc | desc] [conflict_clause] [autoincrement]
| not null [conflict_clause]
| unique [conflict_clause]
| check [on {insert | update | delete}[,...]] (expr)
| default value
| collate collation_name
| references foreign_table [(column[,...])] [ref_actions]
| generated always as (expr) [stored | virtual] }
```

**Table Constraints:**
```sql
[constraint name]
{ primary key ([column [asc | desc][,...]]) [conflict_clause]
| unique (column[,...]) [conflict_clause]
| check [on {insert | update | delete}[,...]] (expr)
| foreign key (column[,...]) references foreign_table [(column[,...])] [ref_actions] }
```

**Conflict Clause:**
```sql
on conflict { rollback | abort | fail | ignore | replace }
```

**Options:**
- If an empty key column list is provided, the table may have 0 or 1 rows.
- `temp/temporary`: Creates a temporary table
- `if not exists`: Creates the table only if it doesn't already exist
- `column_definition`: Defines a column with optional constraints
- `table_constraint`: Defines a table-level transition constraint
- `using module_name`: Specifies a virtual table module

**Examples:**
```sql
-- Basic table with constraints
create table employees (
  id integer primary key autoincrement,
  name text not null,
  email text unique collate nocase,
  department text default 'General',
  salary real check (salary >= 0),
  hire_date text,
  manager_id integer references employees(id)
);

-- Table with composite key and multiple constraints
create table order_items (
  order_id integer,
  product_id integer,
  quantity integer not null check on insert (quantity > 0),
  price real not null check (price >= 0),
  discount real default 0 check (discount >= 0 and discount <= 1),
  primary key (order_id, product_id),
  foreign key (order_id) references orders(id),
  foreign key (product_id) references products(id)
);

-- Memory-backed virtual table
create table cache (
  key text primary key,
  value blob,
  expires_at integer
) using memory;

-- JSON virtual table
create table json_data (
  id integer primary key,
  data text,
  key text,
  value,
  type text,
  path text
) using json_tree;
```

## 3. Clauses and Subclauses

### 3.1 FROM Clause

The from clause specifies the data sources for a query.

**Syntax:**
```sql
from table_reference [, table_reference...]

table_reference:
  table_name [as alias]
| function_name ([arg[,...]]) [as alias]
| (select_statement) as alias
| table_reference join_type join table_reference [join_specification]
```

**Join Types:**
- `[inner] join`: Matches rows when join condition is true
- `left [outer] join`: Includes all rows from left table, plus matching rows from right table
- `right [outer] join`: Includes all rows from right table, plus matching rows from left table
- `full [outer] join`: Includes all rows from both tables
- `cross join`: Cartesian product of both tables

**Join Specifications:**
- `on condition`: Join condition
- `using (column[,...])`: Join on equal named columns

**Examples:**
```sql
-- Multiple tables
select u.name, p.title 
from users as u, posts as p
where u.id = p.user_id;

-- Inner join
select e.name, d.name as department
from employees as e
inner join departments as d on e.dept_id = d.id;

-- Left join
select c.name, o.order_date
from customers as c
left join orders as o on c.id = o.customer_id;

-- Using clause
select p.title, c.content
from posts as p
join comments as c using (post_id);

-- Multiple joins
select o.id, c.name, p.name as product
from orders as o
join customers as c on o.customer_id = c.id
join order_items as oi on o.id = oi.order_id
join products as p on oi.product_id = p.id;

-- Subquery in from
select avg_dept.department, avg_dept.avg_salary
from (
  select department, avg(salary) as avg_salary
  from employees
  group by department
) as avg_dept
where avg_dept.avg_salary > 50000;

-- Table-valued function
select key, value 
from json_each('{"name":"John","age":30}');
```

### 3.2 WHERE Clause

The where clause filters rows returned by a query.

**Syntax:**
```sql
where condition
```

The condition is an expression that evaluates to a boolean result. If true, the row is included in the result set.

**Examples:**
```sql
-- Simple comparison
select * from products where price < 50;

-- Multiple conditions with AND/OR
select * from employees 
  where (department = 'Sales' or department = 'Marketing')
  and hire_date >= date('2020-01-01');

-- Pattern matching with LIKE
select * from customers where email like '%@gmail.com';

-- Range check with BETWEEN
select * from orders where order_date between date('now', '-30 days') and date('now');

-- NULL checking
select * from users where last_login is null;

-- Subquery in WHERE
select * from products
  where category_id in (select id from categories where parent_id = 5);

-- EXISTS subquery
select * from customers as c
  where exists (
    select 1 from orders as o
      where o.customer_id = c.id and o.status = 'shipped'
  );
```

### 3.3 GROUP BY Clause

The group by clause groups rows that have the same values into summary rows.

**Syntax:**
```sql
group by expression [, expression...]
```

**Behavior:**
- Each expression in the group by must be a column name, an expression, or a positive integer representing a position in the select list.
- Aggregate functions (`count()`, `sum()`, etc.) can be used with group by to calculate summary statistics for each group.
- Columns in the select list that are not aggregated must appear in the group by clause.

**Examples:**
```sql
-- Simple grouping
select department, count(*) as employee_count
from employees
group by department;

-- Multiple grouping expressions
select department, job_title, avg(salary) as avg_salary
from employees
group by department, job_title;

-- Grouping with expression
select 
  substr(email, instr(email, '@') + 1) as domain,
  count(*) as user_count
from users
group by domain;

-- Grouping with DATE function
select 
  strftime('%Y-%m', order_date) as month,
  sum(total) as monthly_sales
from orders
group by month
order by month;
```

### 3.4 HAVING Clause

The having clause filters groups based on a condition.

**Syntax:**
```sql
having condition
```

The condition is applied after grouping, allowing filtering on aggregate values.

**Examples:**
```sql
-- Filter groups with HAVING
select department, count(*) as employee_count
from employees
group by department
having employee_count > 10;

-- HAVING with aggregate function
select product_id, sum(quantity) as total_sold
from order_items
group by product_id
having total_sold > 100
order by total_sold desc;

-- HAVING with multiple conditions
select category, avg(price) as avg_price
from products
group by category
having avg_price > 50 and count(*) >= 5;
```

### 3.5 ORDER BY Clause

The order by clause sorts the result set.

**Syntax:**
```sql
order by expression [asc | desc] [, expression [asc | desc]...]
```

**Options:**
- `asc`: Ascending order (default)
- `desc`: Descending order
- Expression can be a column name, alias, or expression

**Examples:**
```sql
-- Simple ordering
select * from products order by price;

-- Multiple sort keys
select * from employees 
order by department asc, salary desc;

-- Ordering by expression
select name, price, quantity, price * quantity as total
from order_items
order by total desc;

-- Ordering with NULLS handling
select * from users 
order by 
  case when last_login is null then 1 else 0 end,
  last_login desc;
```

### 3.6 LIMIT and OFFSET Clauses

The limit and offset clauses restrict the number of rows returned.

**Syntax:**
```sql
limit count [offset skip]
-- or
limit skip, count
```

**Options:**
- `count`: Maximum number of rows to return
- `skip`: Number of rows to skip before returning rows

**Examples:**
```sql
-- Simple LIMIT
select * from products order by price limit 10;

-- LIMIT with OFFSET
select * from products order by price limit 10 offset 20;

-- Alternative syntax
select * from products order by price limit 20, 10;

-- Pagination example
select id, title, created_at
from posts
order by created_at desc
limit 20 offset (3 - 1) * 20; -- Page 3, 20 items per page
```

## 4. Expressions and Operators

### 4.1 Literals

**Numeric Literals:**
- Integers: `123`, `-456`
- Floating-point: `123.45`, `-67.89`, `1.23e4`
- Boolean: Represented as integers: `0` (false), `1` (true)

**String Literals:**
- Single-quoted: `'Text value'`
- Double-quoted identifiers: `"Column name with spaces"`

**Blob Literals:**
- Hex format: `x'53514C697465'` (SQLite)

**NULL:**
- Represents missing or unknown value: `null`

**Examples:**
```sql
select 42 as answer;
select 'Hello, world!' as greeting;
select x'DEADBEEF' as binary_data;
select null as no_value;
```

### 4.2 Operators

**Arithmetic Operators:**
- Addition: `+`
- Subtraction: `-`
- Multiplication: `*`
- Division: `/`
- Modulo (remainder): `%`

**Comparison Operators:**
- Equal: `=` or `==`
- Not equal: `!=` or `<>`
- Less than: `<`
- Greater than: `>`
- Less than or equal: `<=`
- Greater than or equal: `>=`

**Logical Operators:**
- AND: `and`
- OR: `or`
- XOR: `xor`
- NOT: `not`

**Bitwise Operators:**
- AND: `&`
- OR: `|`
- NOT: `~`
- Left shift: `<<`
- Right shift: `>>`

**String Operators:**
- Concatenation: `||`

**Other Operators:**
- `is`: Tests if values are identical (including NULL)
- `is not`: Tests if values are not identical
- `in`: Tests if a value is in a set
- `not in`: Tests if a value is not in a set
- `like`: Pattern matching with wildcards
- `glob`: Pattern matching with Unix wildcards
- `between`: Tests if a value is within a range
- `exists`: Tests if a subquery returns any rows
- `case`: Conditional expression

**Examples:**
```sql
-- Arithmetic
select price, quantity, price * quantity as total from order_items;

-- String concatenation
select first_name || ' ' || last_name as full_name from users;

-- Comparison
select * from products where price > 100;

-- Logical operators
select * from employees
where (department = 'Sales' or department = 'Marketing')
and salary > 50000;

-- IS NULL / IS NOT NULL
select * from users where profile_picture is null;

-- IN operator
select * from products
where category in ('Electronics', 'Computers', 'Accessories');

-- IN with subquery
select * from employees
where department_id in (
  select id from departments where location = 'Headquarters'
);

-- BETWEEN
select * from orders
where order_date between date('2023-01-01') and date('2023-12-31');

-- LIKE pattern matching
select * from users where email like '%@gmail.com';

-- CASE expression
select
  id,
  name,
  price,
  case
    when price < 10 then 'Budget'
    when price < 50 then 'Regular'
    when price < 100 then 'Premium'
    else 'Luxury'
  end as price_category
from products;

-- EXISTS
select * from customers as c
where exists (
  select 1 from orders as o
  where o.customer_id = c.id and o.total > 1000
);
```

### 4.3 Functions and Subexpressions

**Function Calls:**
```sql
function_name(argument1, argument2, ...)
```

**Subexpressions:**
```sql
(expression)
```

**Subqueries:**
- Scalar subquery: Returns a single value
- Row subquery: Returns a single row
- Table subquery: Returns a table result
- EXISTS subquery: Returns a boolean

**Examples:**
```sql
-- Scalar functions
select abs(-42), round(3.14159, 2), upper('hello');

-- Subexpressions for grouping
select (price + tax) * quantity as total from order_items;

-- Scalar subquery
select name, (select count(*) from orders where customer_id = c.id) as order_count
from customers as c;

-- Subquery with comparison
select * from products
where price > (select avg(price) from products);

-- Correlated subquery
select * from orders as o
where total > (
  select avg(total) from orders
  where customer_id = o.customer_id
);
```

### 4.4 Special Value Expressions

**COLLATE Expression:**
```sql
expr collate collation_name
```

**CAST Expression:**
```sql
cast(expr as type)
```

**Parameter References:**
- Positional: `?`, `?1`, `?2`, ...
- Named: `:name`, `@name`, `$name`

**Examples:**
```sql
-- COLLATE
select * from customers
order by name collate nocase;

-- CAST
select cast(price as integer) as rounded_price
from products;

-- Parameters
-- (usually used in prepared statements)
select * from users where id = ? and status = ?;
select * from products where category = :category and price <= :max_price;
```

## 5. Functions

Quereus provides a rich set of built-in functions for data manipulation, calculation, and transformation. These functions follow SQL standards with some Quereus-specific extensions.

### 5.1 Scalar Functions

Scalar functions operate on single values and return a single value per row.

#### String Functions
- `lower(X)`: Returns the lowercase version of string X
- `upper(X)`: Returns the uppercase version of string X
- `length(X)`: Returns the length of string X in characters
- `substr(X, Y[, Z])`: Returns a substring of X starting at position Y (1-based) and Z characters long
- `trim(X[, Y])`: Removes leading and trailing characters Y from X
- `ltrim(X[, Y])`: Removes leading characters Y from X
- `rtrim(X[, Y])`: Removes trailing characters Y from X
- `replace(X, Y, Z)`: Replaces all occurrences of Y in X with Z
- `instr(X, Y)`: Returns the 1-based position of the first occurrence of Y in X

**Examples:**
```sql
-- String manipulation
select 
  lower('HELLO') as lowercase,
  upper('world') as uppercase,
  length('Quereus') as str_length,
  substr('abcdef', 2, 3) as substring,
  trim('  test  ') as trimmed,
  replace('hello world', 'world', 'Quereus') as replaced;

-- Result:
-- lowercase | uppercase | str_length | substring | trimmed | replaced
-- 'hello'   | 'WORLD'   | 7          | 'bcd'     | 'test'  | 'hello Quereus'
```

#### Numeric Functions
- `abs(X)`: Returns the absolute value of X
- `round(X[, Y])`: Rounds X to Y decimal places
- `ceil(X)`, `ceiling(X)`: Returns the smallest integer not less than X
- `floor(X)`: Returns the largest integer not greater than X
- `pow(X, Y)`, `power(X, Y)`: Returns X raised to the power of Y
- `sqrt(X)`: Returns the square root of X
- `random()`: Returns a random integer

**Examples:**
```sql
-- Numeric calculations
select 
  abs(-42) as absolute,
  round(3.14159, 2) as rounded,
  ceil(9.1) as ceiling,
  floor(9.9) as floor_val,
  pow(2, 8) as power_val,
  sqrt(144) as square_root,
  random() % 100 as random_num;

-- Result example:
-- absolute | rounded | ceiling | floor_val | power_val | square_root | random_num
-- 42       | 3.14    | 10      | 9         | 256       | 12          | 73
```

#### Conditional Functions
- `coalesce(X, Y, ...)`: Returns the first non-NULL value
- `nullif(X, Y)`: Returns NULL if X equals Y, otherwise returns X
- `iif(X, Y, Z)`: If X is true, returns Y, otherwise returns Z

**Examples:**
```sql
-- Conditional logic
select 
  coalesce(null, null, 'third', 'fourth') as first_non_null,
  nullif(5, 5) as same_values,
  nullif(10, 20) as different_values,
  iif(age >= 18, 'adult', 'minor') as age_category
from users;

-- Result example:
-- first_non_null | same_values | different_values | age_category
-- 'third'        | null        | 10               | 'adult'
```

#### Type Functions
- `typeof(X)`: Returns the datatype of X as a string ('null', 'integer', 'real', 'text', or 'blob')

### 5.2 Aggregate Functions

Aggregate functions perform a calculation on a set of values and return a single value.

- `count(X)`: Returns the number of non-NULL values of X
- `count(*)`: Returns the number of rows
- `sum(X)`: Returns the sum of all non-NULL values of X
- `avg(X)`: Returns the average of all non-NULL values of X
- `min(X)`: Returns the minimum value of all non-NULL values of X
- `max(X)`: Returns the maximum value of all non-NULL values of X
- `group_concat(X[, Y])`: Returns a string concatenating non-NULL values of X, separated by Y (default ',')
- `total(X)`: Returns the sum as a floating-point value

**Examples:**
```sql
-- Basic aggregates
select 
  count(*) as total_rows,
  count(email) as users_with_email,
  sum(cost) as total_cost,
  avg(age) as average_age,
  min(created_at) as earliest_record,
  max(score) as highest_score
from users;

-- Grouping with aggregates
select 
  department,
  count(*) as employee_count,
  avg(salary) as avg_salary,
  min(hire_date) as earliest_hire,
  group_concat(name, ', ') as employee_names
from employees
group by department;
```

### 5.3 JSON Functions

Quereus provides comprehensive functions for working with JSON data.

- `json_extract(json, path, ...)`: Extracts values from JSON
- `json_object(key, value, ...)`: Creates a JSON object
- `json_array(value, ...)`: Creates a JSON array
- `json_type(json[, path])`: Returns the type of JSON value
- `json_valid(json)`: Checks if a string is valid JSON
- `json_group_array(X)`: Aggregate function that creates a JSON array
- `json_group_object(key, value)`: Aggregate function that creates a JSON object

**Examples:**
```sql
-- JSON extraction
select 
  json_extract('{"name":"John","age":30}', '$.name') as name,
  json_extract('{"name":"John","age":30}', '$.age') as age;

-- JSON creation
select 
  json_object('name', 'Alice', 'age', 25) as person,
  json_array(1, 2, 3, 4, 5) as numbers;

-- Aggregating to JSON
select 
  department,
  json_group_array(name) as employees,
  json_group_object(id, salary) as salary_map
from employees
group by department;
```

### 5.4 Date and Time Functions

Quereus includes functions for manipulating dates and times.

- `date(timestring[, modifier...])`: Returns the date as 'YYYY-MM-DD'
- `time(timestring[, modifier...])`: Returns the time as 'HH:MM:SS'
- `datetime(timestring[, modifier...])`: Returns the date and time as 'YYYY-MM-DD HH:MM:SS'
- `julianday(timestring[, modifier...])`: Returns the Julian day number
- `strftime(format, timestring[, modifier...])`: Returns a formatted date string

**Common modifiers:**
- `+N days`, `+N hours`, `+N minutes`, `+N seconds`, `+N months`, `+N years`
- `start of month`, `start of year`, `start of day`
- `weekday N` (0=Sunday, 1=Monday, etc.)
- `localtime`, `utc`

**Examples:**
```sql
-- Date functions
select 
  date('now') as today,
  time('now', 'localtime') as current_time,
  datetime('now', '+1 day') as tomorrow,
  julianday('2023-01-01') - julianday('2022-01-01') as days_difference,
  strftime('%Y-%m-%d %H:%M', 'now') as formatted_now,
  strftime('%W', 'now') as week_of_year;
  
-- Date calculations
select 
  date('now', '+7 days') as one_week_later,
  date('now', 'start of month', '+1 month', '-1 day') as last_day_of_month,
  datetime('now', 'weekday 1') as next_or_current_monday;
```

### 5.5 Window Functions

Window functions perform calculations across a set of table rows related to the current row.

- `row_number()`: Returns the sequential row number
- `rank()`: Returns the rank with gaps
- `dense_rank()`: Returns the rank without gaps
- `lead(expr[, offset[, default]])`: Accesses data from subsequent rows
- `lag(expr[, offset[, default]])`: Accesses data from previous rows
- `first_value(expr)`: Returns the first value in the window frame
- `last_value(expr)`: Returns the last value in the window frame

**Basic syntax:**
```sql
window_function() over (
  [partition by expr[, ...]]
  [order by expr [asc|desc][, ...]]
  [frame_clause]
)
```

**Examples:**
```sql
-- Basic window functions
select 
  name,
  department,
  salary,
  row_number() over (order by salary desc) as overall_rank,
  rank() over (partition by department order by salary desc) as dept_rank,
  dense_rank() over (partition by department order by salary desc) as dept_dense_rank
from employees;

-- Lead/lag for comparing values
select 
  order_date,
  total,
  lag(total) over (order by order_date) as previous_total,
  total - lag(total) over (order by order_date) as difference
from orders;

-- Moving averages
select 
  date,
  value,
  avg(value) over (
    order by date
    rows between 2 preceding and current row
  ) as moving_avg_3day
from daily_metrics;
```

## 6. Virtual Tables

Virtual tables are Quereus's primary mechanism for accessing and manipulating data. They provide a table interface to various data sources through specialized modules.

### 6.1 Creating Virtual Tables

**Syntax:**
```sql
create [temp | temporary] table [if not exists] table_name [(column_def[, ...])]
using module_name [(module_arguments...)]
```

**Examples:**
```sql
-- Memory table with schema definition
create table users (
  id integer primary key,
  name text not null,
  email text unique,
  created_at text default (datetime('now'))
) using memory;

-- JSON table using the json_tree function
create table product_data
using json_tree('{"products":[{"id":1,"name":"Keyboard"},{"id":2,"name":"Mouse"}]}');

-- Create a memory table from a schema string
create table cache
using memory('create table x(key text primary key, value blob, expires integer)');
```

### 6.2 Built-in Virtual Table Modules

Quereus comes with several built-in virtual table modules:

#### 6.2.1 Memory Table Module

The `memory` module provides an in-memory, B+Tree-based storage with support for transactions, indices, and constraints.

**Key features:**
- Efficient in-memory storage
- Primary key and unique constraints
- Secondary index support via `create index`
- Transaction and savepoint support

**Examples:**
```sql
-- Create a memory table
create table products (
  id integer primary key,
  name text not null,
  price real check (price >= 0),
  category text
) using memory;

-- Create a secondary index
create index idx_products_category on products(category);

-- Insert data
insert into products (name, price, category) 
values 
  ('Laptop', 999.99, 'Electronics'),
  ('Desk Chair', 199.99, 'Furniture');

-- Query with index
select * from products where category = 'Electronics';
```

#### 6.2.2 JSON Table Modules

Quereus provides two modules for working with JSON data:

**json_each**: Expands a JSON array into rows
```sql
-- Create table from JSON array
create table users using json_each('[
  {"id":1,"name":"Alice","role":"admin"},
  {"id":2,"name":"Bob","role":"user"}
]');

-- Query expanded JSON
select key, value from users where key = 'name';
-- Result: 'name', 'Alice' and 'name', 'Bob'
```

**json_tree**: Expands a JSON structure recursively
```sql
-- Create and query a json_tree table
with json_data as (
  select '{"users":[{"id":1,"name":"Alice"},{"id":2,"name":"Bob"}]}' as json
)
select key, value, fullkey, path
from json_tree(
  (select json from json_data)
)
where path like '$.users[%].name';
-- Results in rows with users' names
```

#### 6.2.3 Schema Table Module

The `_schema` module provides access to schema information:

```sql
-- Query schema information
select * from _schema;
-- Returns information about tables, indexes, and views
```

### 6.3 Indexes on Virtual Tables

Virtual tables that support indexing (like the `memory` module) can have indexes created using standard SQL syntax.

**Syntax:**
```sql
create [unique] index [if not exists] index_name
on table_name (indexed_column[, ...])
```

**Examples:**
```sql
-- Simple index on a single column
create index idx_users_email on users(email);

-- Composite index on multiple columns
create index idx_orders_customer_date on orders(customer_id, order_date);

-- Unique index
create unique index idx_products_sku on products(sku);
```

## 7. Constraints and Indexes

### 7.1 Primary Key Constraint

The primary key constraint uniquely identifies each record in a table.

**Syntax - Column Constraint:**
```sql
column_name data_type primary key [asc|desc] [conflict_clause] [autoincrement]
```

**Syntax - Table Constraint:**
```sql
primary key (column[, ...]) [conflict_clause]
```

**Examples:**
```sql
-- Single-column primary key
create table users (
  id integer primary key autoincrement,
  username text not null
);

-- Composite primary key (table constraint)
create table order_items (
  order_id integer,
  product_id integer,
  quantity integer not null,
  primary key (order_id, product_id)
);

-- Primary key with descending order
create table logs (
  timestamp integer primary key desc,
  event text not null
);
```

### 7.2 NOT NULL Constraint

The not null constraint ensures that a column cannot have a NULL value.

**Syntax:**
```sql
column_name data_type not null [conflict_clause]
```

**Example:**
```sql
create table contacts (
  id integer primary key,
  first_name text not null,
  last_name text not null,
  email text not null,
  phone text
);
```

### 7.3 UNIQUE Constraint

The unique constraint ensures that all values in a column are different.

**Syntax - Column Constraint:**
```sql
column_name data_type unique [conflict_clause]
```

**Syntax - Table Constraint:**
```sql
unique (column[, ...]) [conflict_clause]
```

**Examples:**
```sql
-- Single-column unique constraint
create table users (
  id integer primary key,
  email text unique,
  username text unique
);

-- Multi-column unique constraint
create table bookings (
  id integer primary key,
  room_id integer,
  date text,
  unique (room_id, date)
);
```

### 7.4 CHECK Constraint

The check constraint ensures that values in a column satisfy a specific condition.

**Syntax - Column Constraint:**
```sql
column_name data_type check [on operation_list] (expression)
```

**Syntax - Table Constraint:**
```sql
check [on operation_list] (expression)
```

The optional `on operation_list` specifies when the constraint should be checked (insert, update, delete).

**Examples:**
```sql
-- Column-level check constraint
create table products (
  id integer primary key,
  name text not null,
  price real check (price > 0),
  discount real check (discount >= 0 and discount <= 1)
);

-- Table-level check constraint
create table transfers (
  id integer primary key,
  source_account_id integer not null,
  dest_account_id integer not null,
  amount real not null check (amount > 0),
  check (source_account_id != dest_account_id)
);

-- Operation-specific check constraint
create table audit_log (
  id integer primary key,
  record_id integer not null,
  action text not null,
  timestamp text not null,
  check on insert (action in ('insert', 'update', 'delete'))
);
```

### 7.5 DEFAULT Constraint

The default constraint provides a default value for a column when no value is specified.

**Syntax:**
```sql
column_name data_type default value
```

**Examples:**
```sql
-- Constant default value
create table posts (
  id integer primary key,
  title text not null,
  content text,
  views integer default 0,
  status text default 'draft'
);

-- Function-based default
create table audit_records (
  id integer primary key,
  action text not null,
  timestamp text default (datetime('now'))
);
```

### 7.6 FOREIGN KEY Constraint

The foreign key constraint links tables together and ensures referential integrity.

**Note:** In Quereus, foreign key constraints are parsed but not enforced. This is a known limitation.

**Syntax - Column Constraint:**
```sql
column_name data_type references foreign_table [(column)] [ref_actions]
```

**Syntax - Table Constraint:**
```sql
foreign key (column[, ...]) references foreign_table [(column[, ...])] [ref_actions]
```

**Reference Actions:**
```sql
[on delete action] [on update action]
```

Where `action` can be:
- `set null`
- `set default`
- `cascade`
- `restrict`
- `no action`

**Examples:**
```sql
-- Column-level foreign key
create table posts (
  id integer primary key,
  user_id integer references users(id),
  title text not null
);

-- Table-level foreign key with actions
create table comments (
  id integer primary key,
  post_id integer,
  user_id integer,
  content text not null,
  foreign key (post_id) references posts(id) on delete cascade,
  foreign key (user_id) references users(id) on delete set null
);
```

### 7.7 Creating Indexes

Indexes improve query performance for specific columns.

**Syntax:**
```sql
create [unique] index [if not exists] index_name
on table_name (column [asc|desc][, ...]) [where condition]
```

**Examples:**
```sql
-- Simple index
create index idx_users_email on users(email);

-- Multi-column index
create index idx_posts_user_date on posts(user_id, created_at desc);

-- Partial index with WHERE clause
create index idx_active_users on users(last_login) where status = 'active';

-- Unique index
create unique index idx_products_sku on products(sku);
```

### 7.8 Dropping Indexes

**Syntax:**
```sql
drop index [if exists] index_name
```

**Example:**
```sql
drop index idx_users_email;
```

## 8. Transactions and Savepoints

Transactions group multiple operations into a single unit that either succeeds completely or fails completely.

### 8.1 BEGIN Transaction

Starts a new transaction.

**Syntax:**
```sql
begin [deferred | immediate | exclusive] [transaction]
```

**Transaction Types:**
- `deferred`: Locks are acquired when needed (default)
- `immediate`: Acquires a write lock immediately
- `exclusive`: Acquires exclusive access to the database

**Examples:**
```sql
-- Start a default transaction
begin;

-- Start an immediate transaction
begin immediate transaction;

-- Start an exclusive transaction
begin exclusive;
```

### 8.2 COMMIT Transaction

Saves all changes made during the current transaction.

**Syntax:**
```sql
commit [transaction]
```

**Example:**
```sql
-- Commit the current transaction
commit;
```

### 8.3 ROLLBACK Transaction

Discards all changes made during the current transaction.

**Syntax:**
```sql
rollback [transaction]
```

**Example:**
```sql
-- Discard all changes in the current transaction
rollback;
```

### 8.4 Savepoints

Savepoints allow partial transaction rollbacks.

**Create a savepoint:**
```sql
savepoint savepoint_name
```

**Rollback to a savepoint:**
```sql
rollback [transaction] to [savepoint] savepoint_name
```

**Release a savepoint:**
```sql
release [savepoint] savepoint_name
```

**Example:**
```sql
-- Transaction with savepoints
begin;

insert into users (name, email) values ('Alice', 'alice@example.com');

savepoint after_alice;

insert into users (name, email) values ('Bob', 'bob@example.com');

-- Oops, we made a mistake with Bob
rollback to savepoint after_alice;

-- Only Alice is inserted, Bob's insert was rolled back
insert into users (name, email) values ('Charlie', 'charlie@example.com');

-- Release a savepoint (optional, mostly for cleanup)
release savepoint after_alice;

commit;
```

### 8.5 Transaction Best Practices

1. **Explicit Transactions**: Always use explicit transactions for multi-statement operations.
2. **Error Handling**: Combine transactions with proper error handling to ensure rollback on failure.
3. **Transaction Size**: Keep transactions as short as possible to reduce lock contention.
4. **Savepoints**: Use savepoints for partial rollback instead of entire transaction rollback.

**JavaScript Example with Quereus:**
```javascript
// Using explicit transactions in JavaScript
try {
  await db.exec("begin");
  
  const orderId = await db.get("insert into orders (customer_id, total) values (?, ?) returning (id)", [42, 129.99]);
  
  await db.exec("insert into order_items (order_id, product_id, quantity) values (?, ?, ?)",
    [orderId, 101, 2]);
  await db.exec("insert into order_items (order_id, product_id, quantity) values (?, ?, ?)",
    [orderId, 205, 1]);
  
  await db.exec("commit");
  console.log("Transaction committed successfully");
} catch (error) {
  await db.exec("rollback");
  console.error("Transaction failed:", error);
}
```

## 9. PRAGMA Statements

PRAGMA statements are special commands that control the behavior of the Quereus database engine.

### 9.1 Basic Syntax

```sql
pragma name = value;
pragma name;  -- query the current value
```

### 9.2 Supported PRAGMA Statements

#### 9.2.1 default_vtab_module

Sets or queries the default virtual table module used when `create table` is called without a specific `using` clause.

```sql
-- Set default module to "memory"
pragma default_vtab_module = 'memory';

-- Query current default module
pragma default_vtab_module;
```

#### 9.2.2 default_vtab_args

Sets or queries the default arguments passed to the default virtual table module. The value should be a JSON array of strings.

```sql
-- Set default args for the default module
pragma default_vtab_args = '["create table x(id integer primary key, data text)"]';

-- Query current default args
pragma default_vtab_args;
```

### 9.3 Examples

```sql
-- Configure default VTab settings
pragma default_vtab_module = 'memory';
pragma default_vtab_args = '[]';

-- Create a table using the default module
create table simple_cache (
  key text primary key,
  value text
);
-- Equivalent to: CREATE TABLE simple_cache (...) USING memory;
```

### 9.4 Transactions Control PRAGMAs

These PRAGMAs are parsed but may not affect behavior in the same way as SQLite due to Quereus's virtual table-centric architecture.

```sql
pragma journal_mode = 'memory';
pragma synchronous = 'off';
```

## 10. Error Handling

Quereus provides structured error handling through the `QuereusError` class hierarchy. Understanding these errors helps in debugging and creating robust applications.

### 10.1 Error Types

#### 10.1.1 QuereusError

The base error class for all Quereus errors. Contains:
- `message`: Description of the error
- `code`: A `StatusCode` value indicating the error type
- `cause`: Optional underlying error
- `line`, `column`: Position information when available

#### 10.1.2 ParseError

Specialized error for syntax problems during SQL parsing:
- Contains token information
- Includes precise position information

#### 10.1.3 MisuseError

Indicates API misuse, such as:
- Operating on a closed database
- Invalid parameter binding
- Interface contract violations

#### 10.1.4 ConstraintError

Indicates constraint violations, such as:
- Unique constraint violations
- NOT NULL constraint violations
- CHECK constraint failures

### 10.2 Error Status Codes

Important status codes include:

- `ERROR`: Generic error
- `INTERNAL`: Internal logic error
- `CONSTRAINT`: Constraint violation 
- `MISUSE`: Library misuse
- `RANGE`: Parameter out of range
- `NOTFOUND`: Item not found

### 10.3 Handling Errors in Applications

**JavaScript Example:**

```javascript
try {
  await db.exec("insert into users (email, username) values (?, ?)", 
    ['user@example.com', 'newuser']);
  console.log("Insert successful");
} catch (error) {
  if (error.code === StatusCode.CONSTRAINT) {
    console.error("Constraint violation:", error.message);
    // Handle specific constraint error (e.g., duplicate email)
  } else if (error instanceof ParseError) {
    console.error("SQL syntax error at line", error.line, "column", error.column);
  } else {
    console.error("Database error:", error.message);
  }
}
```

### 10.4 Common Error Scenarios

#### Syntax Errors

```sql
-- Missing FROM clause (will cause ParseError)
select id, name where status = 'active';
```

#### Constraint Violations

```sql
-- Assuming unique constraint on email (will cause ConstraintError)
insert into users (email) values ('existing@example.com');
```

#### Schema Errors

```sql
-- Reference to non-existent table (will cause QuereusError)
select * from nonexistent_table;
```

#### Type Errors

```sql
-- Type mismatch in operation (may cause runtime error)
select 'text' + 42 from users;
```

## 11. Quereus vs. SQLite

Quereus implements a subset of SQLite functionality with some differences in behavior and focus. Understanding these differences is important when porting applications from SQLite or creating new applications with Quereus.

### 11.1 Key Similarities

- SQL syntax is largely compatible
- Core DML (select, insert, update, delete) support
- Transaction and savepoint support
- Similar built-in function set
- Parameter binding with `?`, `:name`, and `$name`

### 11.2 Key Differences

#### 11.2.1 Architecture

**Quereus:**
- All tables are virtual tables
- No built-in file storage
- In-memory focused with `memory` module as primary storage
- Async/await API design for JavaScript

**SQLite:**
- Physical disk-based tables with optional virtual tables
- Built around persistent file storage
- Synchronous C API

#### 11.2.2 Feature Support

| Feature | Quereus | SQLite |
|---------|---------|--------|
| **File Storage** | No built-in support; VTab modules could implement | Primary feature |
| **Virtual Tables** | Central to design; all tables are virtual | Additional feature |
| **Triggers** | Not supported | Supported |
| **Views** | Basic support | Full support |
| **Foreign Keys** | Parsed but not enforced | Full support (when enabled) |
| **Window Functions** | Subset supported | Full support |
| **Recursive CTEs** | Basic support | Full support |
| **JSON Functions** | Extensive support | Available as extension |
| **Indexes** | Supported by some VTab modules | Full support |
| **BLOB I/O** | Basic support | Advanced support |

#### 11.2.3 Syntax Extensions

Quereus provides some syntax extensions:

```sql
-- Quereus: CREATE TABLE with USING clause for virtual tables
create table users (id integer primary key, name text) using memory;

-- Quereus: PRIMARY KEY with ASC/DESC qualifier
create table logs (timestamp integer primary key desc, event text);

-- Quereus: CHECK constraints with operation specificity
create table products (
  price real check on insert (price >= 0),
  stock integer check on update (stock >= 0)
);
```

#### 11.2.4 Performance Characteristics

- **Quereus**: JavaScript-based with optimization for in-memory operations
- **SQLite**: C-based with focus on disk I/O efficiency

### 11.3 Migration Considerations

When migrating from SQLite to Quereus:

1. **Storage Strategy**: Determine how to handle persistence (custom VTab, export/import, etc.)
2. **Async Handling**: Convert synchronous SQLite code to async/await with Quereus
3. **Feature Check**: Review use of triggers, advanced views, enforced foreign keys
4. **Transaction Model**: Similar, but understand Quereus's virtual table transaction model
5. **Custom Functions**: Port custom SQL functions to JavaScript

### 11.4 Future Roadmap

Quereus is actively developed with plans to add:
- Improved window function support
- Enhanced recursive CTE capabilities
- More query planning enhancements
- Additional virtual table modules

See [todo.md] for the current development plans.

## 12. EBNF Grammar

Below is a formal Extended Backus-Naur Form (EBNF) grammar for Quereus's SQL dialect, based on the parser implementation.

### 12.1 Notation

- `[ a ]`: Optional element a
- `{ a }`: Zero or more repetitions of a
- `a | b`: Either a or b
- `( a )`: Grouping
- `"a"`: Literal terminal symbol
- `a b`: Sequence: a followed by b

### 12.2 Grammar

```ebnf
/* Top-level constructs */
sql_script         = { sql_statement ";" } ;

sql_statement      = [ with_clause ] ( select_stmt 
                    | insert_stmt 
                    | update_stmt 
                    | delete_stmt 
                    | create_table_stmt 
                    | create_index_stmt 
                    | create_view_stmt 
                    | drop_stmt 
                    | alter_table_stmt 
                    | begin_stmt 
                    | commit_stmt 
                    | rollback_stmt 
                    | savepoint_stmt 
                    | release_stmt 
                    | pragma_stmt ) ;

/* WITH clause and CTEs */
with_clause        = "with" [ "recursive" ] common_table_expr { "," common_table_expr } ;

common_table_expr  = cte_name [ "(" column_name { "," column_name } ")" ] 
                     "as" [ "materialized" | "not" "materialized" ]
                     "(" ( select_stmt | insert_stmt | update_stmt | delete_stmt ) ")" ;

cte_name           = identifier ;

/* SELECT statement */
select_stmt        = simple_select [ compound_operator simple_select ]* [ order_by_clause ] [ limit_clause ] ;

simple_select      = "select" [ distinct_clause ] result_column { "," result_column }
                     [ from_clause ]
                     [ where_clause ]
                     [ group_by_clause ]
                     [ having_clause ] ;

distinct_clause    = "distinct" | "all" ;

result_column      = "*" | table_name "." "*" | expr [ [ "as" ] column_alias ] ;

from_clause        = "from" table_or_subquery { "," table_or_subquery } ;

table_or_subquery  = table_name [ [ "as" ] table_alias ] 
                   | "(" select_stmt ")" [ "as" ] table_alias
                   | function_name "(" [ expr { "," expr } ] ")" [ [ "as" ] table_alias ]
                   | join_clause ;

join_clause        = table_or_subquery { join_operator table_or_subquery join_constraint } ;

join_operator      = "," 
                   | [ "natural" ] [ "left" [ "outer" ] | "inner" | "cross" | "right" [ "outer" ] | "full" [ "outer" ] ] "join" ;

join_constraint    = [ "on" expr | "using" "(" column_name { "," column_name } ")" ] ;

where_clause       = "where" expr ;

group_by_clause    = "group" "by" expr { "," expr } ;

having_clause      = "having" expr ;

compound_operator  = "union" [ "all" ] | "intersect" | "except" ;

order_by_clause    = "order" "by" ordering_term { "," ordering_term } ;

ordering_term      = expr [ "asc" | "desc" ] [ "nulls" ( "first" | "last" ) ] ;

limit_clause       = "limit" expr [ ( "offset" expr ) | ( "," expr ) ] ;

/* INSERT statement */
insert_stmt        = "insert" [ "into" ] table_name [ "(" column_name { "," column_name } ")" ]
                     ( values_clause | select_stmt ) ;

values_clause      = "values" "(" expr { "," expr } ")" { "," "(" expr { "," expr } ")" } ;

/* UPDATE statement */
update_stmt        = "update" table_name 
                     "set" column_name "=" expr { "," column_name "=" expr }
                     [ where_clause ] ;

/* DELETE statement */
delete_stmt        = "delete" "from" table_name [ where_clause ] ;

/* CREATE TABLE statement */
create_table_stmt  = "create" [ "temp" | "temporary" ] "table" [ "if" "not" "exists" ]
                     table_name "(" column_def { "," ( column_def | table_constraint ) } ")"
                     [ "using" module_name [ "(" module_arg { "," module_arg } ")" ] ] ;

column_def         = column_name [ type_name ] { column_constraint } ;

type_name          = identifier [ "(" signed_number [ "," signed_number ] ")" ] ;

column_constraint  = [ "constraint" name ]
                     ( primary_key_clause
                     | "not" "null" [ conflict_clause ]
                     | "unique" [ conflict_clause ]
                     | "check" [ "on" row_op_list ] "(" expr ")"
                     | "default" ( signed_number | literal_value | "(" expr ")" )
                     | "collate" collation_name
                     | foreign_key_clause
                     | "generated" "always" "as" "(" expr ")" [ "stored" | "virtual" ] ) ;

primary_key_clause = "primary" "key" [ ( "asc" | "desc" ) ] [ conflict_clause ] [ "autoincrement" ] ;

table_constraint   = [ "constraint" name ]
                     ( "primary" "key" "(" indexed_column { "," indexed_column } ")" [ conflict_clause ]
                     | "unique" "(" column_name { "," column_name } ")" [ conflict_clause ]
                     | "check" [ "on" row_op_list ] "(" expr ")"
                     | "foreign" "key" "(" column_name { "," column_name } ")" foreign_key_clause ) ;

foreign_key_clause = "references" foreign_table [ "(" column_name { "," column_name } ")" ]
                     { [ "on" ( "delete" | "update" ) ( "set" "null" | "set" "default" | "cascade" | "restrict" | "no" "action" ) ]
                     | [ "match" name ] }
                     [ [ "not" ] "deferrable" [ "initially" ( "deferred" | "immediate" ) ] ] ;

conflict_clause    = "on" "conflict" ( "rollback" | "abort" | "fail" | "ignore" | "replace" ) ;

row_op_list        = row_op { "," row_op } ;

row_op             = "insert" | "update" | "delete" ;

/* CREATE INDEX statement */
create_index_stmt  = "create" [ "unique" ] "index" [ "if" "not" "exists" ]
                     index_name "on" table_name "(" indexed_column { "," indexed_column } ")"
                     [ "where" expr ] ;

indexed_column     = column_name [ "collate" collation_name ] [ "asc" | "desc" ] ;

/* CREATE VIEW statement */
create_view_stmt   = "create" [ "temp" | "temporary" ] "view" [ "if" "not" "exists" ]
                     view_name [ "(" column_name { "," column_name } ")" ] "as" select_stmt ;

/* DROP statement */
drop_stmt          = "drop" ( "table" | "index" | "view" ) [ "if" "exists" ] name ;

/* ALTER TABLE statement */
alter_table_stmt   = "alter" "table" table_name
                     ( rename_table_stmt 
                     | rename_column_stmt 
                     | add_column_stmt 
                     | drop_column_stmt ) ;

rename_table_stmt  = "rename" "to" new_table_name ;

rename_column_stmt = "rename" [ "column" ] old_column_name "to" new_column_name ;

add_column_stmt    = "add" [ "column" ] column_def ;

drop_column_stmt   = "drop" [ "column" ] column_name ;

/* Transaction statements */
begin_stmt         = "begin" [ "deferred" | "immediate" | "exclusive" ] [ "transaction" ] ;

commit_stmt        = "commit" [ "transaction" ] ;

rollback_stmt      = "rollback" [ "transaction" ] [ "to" [ "savepoint" ] savepoint_name ] ;

savepoint_stmt     = "savepoint" savepoint_name ;

release_stmt       = "release" [ "savepoint" ] savepoint_name ;

/* PRAGMA statement */
pragma_stmt        = "pragma" pragma_name [ "=" pragma_value ] ;

pragma_value       = signed_number | name | string_literal ;

/* Basic elements */
expr               = literal_value
                    | identifier
                    | unary_operator expr
                    | expr binary_operator expr
                    | function_call
                    | "(" expr ")"
                    | cast_expr
                    | expr "collate" collation_name
                    | expr [ "not" ] "like" expr [ "escape" expr ]
                    | expr [ "not" ] "glob" expr
                    | expr [ "not" ] "regexp" expr
                    | expr [ "not" ] "in" ( "(" [ select_stmt | expr { "," expr } ] ")" | table_name )
                    | expr "is" [ "not" ] expr
                    | expr [ "not" ] "between" expr "and" expr
                    | [ "exists" ] "(" select_stmt ")"
                    | case_expr
                    | window_function ;

literal_value      = numeric_literal | string_literal | blob_literal | "null" | "true" | "false" ;

numeric_literal    = [ "+" | "-" ] ( integer_literal | float_literal ) ;

integer_literal    = digit+ ;

float_literal      = digit+ "." digit* [ "e" [ "+" | "-" ] digit+ ]
                   | "." digit+ [ "e" [ "+" | "-" ] digit+ ]
                   | digit+ "e" [ "+" | "-" ] digit+ ;

string_literal     = "'" { character } "'" { "'" { character } "'" } ;

blob_literal       = "x'" hex_digit+ "'" ;

identifier         = [ schema_name "." ] name ;

schema_name        = name ;

table_name         = [ schema_name "." ] name ;

column_name        = [ table_name "." ] name ;

collation_name     = name ;

function_name      = name ;

function_call      = function_name "(" [ [ "distinct" ] expr { "," expr } ] ")" ;

cast_expr          = "cast" "(" expr "as" type_name ")" ;

case_expr          = "case" [ expr ] { "when" expr "then" expr } [ "else" expr ] "end" ;

window_function    = function_call "over" window_name_or_specification ;

window_name_or_specification = window_name | "(" window_specification ")" ;

window_specification = [ window_name ] [ "partition" "by" expr { "," expr } ] [ "order" "by" ordering_term { "," ordering_term } ] [ frame_spec ] ;

frame_spec         = ( "range" | "rows" ) ( frame_bound | "between" frame_bound "and" frame_bound ) [ frame_exclude ] ;

frame_bound        = "unbounded" "preceding"
                   | "current" "row"
                   | "unbounded" "following"
                   | expr "preceding"
                   | expr "following" ;

frame_exclude      = "exclude" "no" "others"
                   | "exclude" "current" "row"
                   | "exclude" "group"
                   | "exclude" "ties" ;

/* Basic lexical elements */
name               = identifier_start_char { identifier_char } ;

identifier_start_char = alpha | "_" ;

identifier_char    = alpha | digit | "_" ;

alpha              = "a" | "b" | ... | "z" | "A" | "B" | ... | "Z" ;

digit              = "0" | "1" | ... | "9" ;

hex_digit          = digit | "a" | "b" | "c" | "d" | "e" | "f" | "A" | "B" | "C" | "D" | "E" | "F" ;

unary_operator     = "-" | "+" | "~" | "not" ;

binary_operator    = "||" | "*" | "/" | "%" | "+" | "-" | "<<" | ">>" | "&" | "|" 
                   | "<" | "<=" | ">" | ">=" | "=" | "==" | "!=" | "<>" 
                   | "and" | "or" ;
```

This grammar defines the syntax of SQL statements supported by Quereus. While it captures most of the language features, some specialized constructs and edge cases may not be fully represented. For the definitive reference, always consult the Quereus parser implementation.
