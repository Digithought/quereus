# String Functions Plugin

A sample plugin for Quereus demonstrating how to create custom scalar and table-valued SQL functions. It provides additional string manipulation functions beyond the built-in ones.

## Functions Provided

### Scalar Functions

- **`reverse(text)`** - Reverses a string
- **`title_case(text)`** - Converts text to title case
- **`repeat(text, count)`** - Repeats a string N times (max 1000)
- **`slugify(text)`** - Converts text to URL-friendly slug
- **`word_count(text)`** - Counts words in text
- **`str_concat(...args)`** - Concatenates strings (variadic)

### Table-Valued Functions

- **`str_stats(text)`** - Returns string statistics as rows

## Usage Examples

```sql
-- Reverse a string
SELECT reverse('hello world');
-- Result: 'dlrow olleh'

-- Convert to title case
SELECT title_case('hello world');
-- Result: 'Hello World'

-- Repeat a string
SELECT repeat('ha', 3);
-- Result: 'hahaha'

-- Create URL slugs
SELECT slugify('Hello World!');
-- Result: 'hello-world'

-- Count words
SELECT word_count('Hello beautiful world');
-- Result: 3

-- Concatenate strings (variadic)
SELECT str_concat('Hello', ' ', 'World', '!');
-- Result: 'Hello World!'

-- Get string statistics
SELECT * FROM str_stats('Hello world!\nThis is a test.');
-- Results:
-- metric | value
-- -------|------
-- length | 29
-- words  | 6
-- chars  | 23
-- lines  | 2
```

## Installation

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import stringFunctions from '@quereus/quereus-plugin-string-functions/plugin';

const db = new Database();
await registerPlugin(db, stringFunctions);
```

## Function Details

### `reverse(text)`

Reverses the characters in a string. Returns `NULL` if input is `NULL`.

```sql
SELECT reverse('ABC');  -- 'CBA'
SELECT reverse(NULL);   -- NULL
```

### `title_case(text)`

Converts text to title case where the first letter of each word is uppercase.

```sql
SELECT title_case('hello world');     -- 'Hello World'
SELECT title_case('XML and JSON');    -- 'Xml And Json'
```

### `repeat(text, count)`

Repeats a string a specified number of times. Count is clamped to [0, 1000].

```sql
SELECT repeat('Hi', 3);    -- 'HiHiHi'
SELECT repeat('X', 0);     -- ''
SELECT repeat('A', 1001);  -- Error: Repeat count too large
```

### `slugify(text)`

Converts text to a URL-friendly slug by:
- Converting to lowercase
- Removing special characters
- Replacing spaces with hyphens
- Removing multiple consecutive hyphens

```sql
SELECT slugify('Hello World!');           -- 'hello-world'
SELECT slugify('  Multiple   Spaces  ');  -- 'multiple-spaces'
SELECT slugify('Special@#$Characters');    -- 'specialcharacters'
```

### `word_count(text)`

Counts the number of words in a string. Words are separated by whitespace.

```sql
SELECT word_count('Hello world');        -- 2
SELECT word_count('   Multiple   words   ');  -- 2
SELECT word_count('');                   -- 0
SELECT word_count('SingleWord');         -- 1
```

### `str_concat(...args)`

Concatenates an unlimited number of string arguments. `NULL` values are ignored.

```sql
SELECT str_concat('A', 'B', 'C');           -- 'ABC'
SELECT str_concat('Hello', ' ', 'World');   -- 'Hello World'
SELECT str_concat('A', NULL, 'B');          -- 'AB'
SELECT str_concat();                        -- ''
```

### `str_stats(text)`

Returns detailed statistics about a string as a table with `metric` and `value` columns:

- `length` - Total character count
- `words` - Word count (whitespace-separated)
- `chars` - Character count excluding whitespace
- `lines` - Line count

```sql
SELECT * FROM str_stats('Hello world!\nSecond line.');
-- metric | value
-- -------|------
-- length | 26
-- words  | 4
-- chars  | 22
-- lines  | 2
```

## Error Handling

All functions gracefully handle `NULL` inputs and invalid data types:

- `NULL` inputs return `NULL` for scalar functions
- Invalid numbers are treated as 0 or cause errors as appropriate
- Empty strings are handled according to function semantics

## Source Code

The complete source code is available in `packages/sample-plugins/string-functions/index.ts` and demonstrates:

- Proper input validation
- Error handling patterns
- Variadic function implementation
- Table-valued function generators
- Function schema creation
