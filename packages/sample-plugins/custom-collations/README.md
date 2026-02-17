# Custom Collations Plugin

This plugin demonstrates how to create custom collation functions in Quereus. Collations control how text is sorted and compared in SQL operations.

## Collations Provided

- **`NUMERIC`** - Natural numeric sorting ("file2.txt" < "file10.txt")
- **`LENGTH`** - Sort by string length, then lexicographically
- **`REVERSE`** - Reverse lexicographic order
- **`ALPHANUM`** - Advanced alphanumeric sorting with mixed text and numbers
- **`PHONETIC`** - Phonetic-like sorting (groups similar-sounding characters)

## Installation

```typescript
import { Database, registerPlugin } from '@quereus/quereus';
import customCollations from '@quereus/quereus-plugin-custom-collations/plugin';

const db = new Database();
await registerPlugin(db, customCollations);
```

## Usage Examples

```sql
-- Natural numeric sorting
SELECT * FROM files ORDER BY filename COLLATE NUMERIC;
-- Results: file1.txt, file2.txt, file10.txt, file20.txt

-- Length-based sorting
SELECT * FROM words ORDER BY word COLLATE LENGTH;
-- Results: 'a', 'to', 'the', 'word', 'hello'

-- Reverse alphabetical order
SELECT * FROM items ORDER BY name COLLATE REVERSE;
-- Results: 'zebra', 'apple', 'aardvark'

-- Alphanumeric sorting
SELECT * FROM mixed ORDER BY value COLLATE ALPHANUM;
-- Results: 'a1', 'a2', 'a10', 'b1', 'b2'

-- Phonetic-like sorting
SELECT * FROM names ORDER BY name COLLATE PHONETIC;
-- Groups similar-sounding names together
```

## Collation Details

### `NUMERIC` Collation

Handles embedded numbers in strings naturally, so "file10.txt" comes after "file2.txt" instead of before it.

**How it works:**
- Splits strings into alternating text and numeric parts
- Compares text parts lexicographically
- Compares numeric parts numerically

```sql
-- Standard binary collation (wrong order)
SELECT * FROM files ORDER BY filename;
-- Results: file1.txt, file10.txt, file2.txt, file20.txt

-- Numeric collation (correct order)
SELECT * FROM files ORDER BY filename COLLATE NUMERIC;
-- Results: file1.txt, file2.txt, file10.txt, file20.txt
```

**Use cases:**
- File listings with numeric sequences
- Version numbers (v1.2.10 vs v1.2.2)
- Natural sorting of mixed content

### `LENGTH` Collation

Sorts by string length first, then lexicographically for strings of equal length.

```sql
SELECT * FROM words ORDER BY word COLLATE LENGTH;
-- Results: 'a', 'I', 'to', 'be', 'the', 'word', 'hello'
```

**Use cases:**
- Organizing text by complexity
- Prioritizing shorter entries
- Length-based grouping

### `REVERSE` Collation

Reverses normal alphabetical order (Z to A instead of A to Z).

```sql
SELECT * FROM items ORDER BY name COLLATE REVERSE;
-- Results: 'zebra', 'yellow', 'apple', 'aardvark'
```

**Use cases:**
- Reverse alphabetical listings
- Most-recent-first when using alphabetical codes
- Alternative sorting perspectives

### `ALPHANUM` Collation

Advanced alphanumeric sorting that properly handles mixed text and numbers.

**How it works:**
- Tokenizes strings into text and numeric components
- Compares tokens by type (text before numbers)
- Handles complex mixed content correctly

```sql
-- Examples of proper alphanumeric sorting
SELECT * FROM mixed ORDER BY value COLLATE ALPHANUM;
-- Input: 'item1', 'item10', 'item2', 'section1', 'section2'
-- Results: 'item1', 'item2', 'item10', 'section1', 'section2'
```

**Use cases:**
- Complex file naming schemes
- Mixed alphanumeric identifiers
- Software version comparisons

### `PHONETIC` Collation

Groups similar-sounding characters together for phonetic-like sorting.

**Normalizations applied:**
- All vowels (a, e, i, o, u) → 'a'
- Similar consonants: b/p, f/v, k/g, s/z, t/d
- Removes silent 'h'
- Collapses consecutive duplicates

```sql
-- Phonetic grouping
SELECT * FROM names ORDER BY name COLLATE PHONETIC;
-- Similar-sounding names will be grouped together
```

**Use cases:**
- Name sorting by sound
- Fuzzy text matching
- Grouping similar pronunciations

## Comparison Usage

Collations can be used in comparisons, not just sorting:

```sql
-- Equality with custom collation
SELECT * FROM files WHERE filename = 'File10.txt' COLLATE NUMERIC;

-- Range comparisons
SELECT * FROM items WHERE name BETWEEN 'a' AND 'c' COLLATE LENGTH;

-- Grouping
SELECT name, COUNT(*) FROM items GROUP BY name COLLATE PHONETIC;
```

## Performance Notes

- All collations are optimized for typical string lengths
- `NUMERIC` and `ALPHANUM` have more complex parsing but are still efficient
- `PHONETIC` does extensive normalization but caches results
- Consider string length and complexity when choosing collations

## Implementation Details

Each collation function receives two strings and returns:
- `-1` if the first string should come before the second
- `0` if the strings are equal
- `1` if the first string should come after the second

```javascript
// Example collation function signature
function myCollation(a, b) {
  // Your comparison logic here
  return a < b ? -1 : a > b ? 1 : 0;
}
```

## Error Handling

All collation functions handle edge cases gracefully:
- Empty strings
- Non-string inputs (converted to strings)
- Unicode characters
- Special characters

## Source Code

The complete source code is available in `packages/sample-plugins/custom-collations/index.ts` and demonstrates:

- String parsing and tokenization
- Numeric comparison logic
- Text normalization techniques
- Efficient comparison algorithms
- Proper collation function patterns
