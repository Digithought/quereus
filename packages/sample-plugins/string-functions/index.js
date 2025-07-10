/**
 * String Functions Plugin for Quereus
 *
 * This plugin demonstrates how to register custom functions in Quereus.
 * It provides additional string manipulation functions beyond the built-ins.
 *
 * Functions provided:
 * - reverse(text) - Reverses a string
 * - title_case(text) - Converts to title case
 * - repeat(text, count) - Repeats a string N times
 * - slugify(text) - Converts text to URL-friendly slug
 * - word_count(text) - Counts words in text
 * - str_concat(...args) - Concatenates strings (variadic)
 * - str_stats(text) - Table-valued function returning string statistics
 */

export const manifest = {
  name: 'String Functions',
  version: '1.0.0',
  author: 'Quereus Team',
  description: 'Additional string manipulation functions for SQL queries',
  provides: {
    functions: [
      'reverse', 'title_case', 'repeat', 'slugify', 'word_count', 'str_concat', 'str_stats'
    ]
  }
};

/**
 * Reverses a string
 */
function reverse(text) {
  if (text === null || text === undefined) return null;
  return String(text).split('').reverse().join('');
}

/**
 * Converts text to title case
 */
function titleCase(text) {
  if (text === null || text === undefined) return null;
  return String(text).toLowerCase().replace(/\b\w/g, l => l.toUpperCase());
}

/**
 * Repeats a string N times
 */
function repeat(text, count) {
  if (text === null || text === undefined) return null;
  if (count === null || count === undefined) return null;
  
  const str = String(text);
  const num = Math.max(0, Math.floor(Number(count)));
  
  if (num === 0) return '';
  if (num > 1000) throw new Error('Repeat count too large (max 1000)');
  
  return str.repeat(num);
}

/**
 * Converts text to URL-friendly slug
 */
function slugify(text) {
  if (text === null || text === undefined) return null;
  
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-')     // Replace spaces with hyphens
    .replace(/-+/g, '-')      // Replace multiple hyphens with single
    .replace(/^-|-$/g, '');   // Remove leading/trailing hyphens
}

/**
 * Counts words in text
 */
function wordCount(text) {
  if (text === null || text === undefined) return 0;
  
  const str = String(text).trim();
  if (str === '') return 0;
  
  return str.split(/\s+/).length;
}

/**
 * Concatenates strings (variadic function)
 */
function strConcat(...args) {
  // Filter out null/undefined values
  const validArgs = args.filter(arg => arg !== null && arg !== undefined);
  return validArgs.map(arg => String(arg)).join('');
}

/**
 * Table-valued function that returns string statistics
 */
function* strStats(text) {
  if (text === null || text === undefined) {
    yield { metric: 'length', value: 0 };
    yield { metric: 'words', value: 0 };
    yield { metric: 'chars', value: 0 };
    yield { metric: 'lines', value: 0 };
    return;
  }
  
  const str = String(text);
  const words = str.trim() === '' ? 0 : str.trim().split(/\s+/).length;
  const chars = str.replace(/\s/g, '').length;
  const lines = str.split('\n').length;
  
  yield { metric: 'length', value: str.length };
  yield { metric: 'words', value: words };
  yield { metric: 'chars', value: chars };
  yield { metric: 'lines', value: lines };
}

/**
 * Plugin registration function
 */
export default function register(db, config = {}) {
  console.log('String Functions plugin loaded with config:', config);
  
  // Return function registrations
  return {
    functions: [
      // Scalar functions
      {
        schema: {
          name: 'reverse',
          numArgs: 1,
          flags: 1, // FunctionFlags.UTF8
          returnType: { typeClass: 'scalar', sqlType: 'TEXT' },
          implementation: reverse
        }
      },
      {
        schema: {
          name: 'title_case',
          numArgs: 1,
          flags: 1, // FunctionFlags.UTF8
          returnType: { typeClass: 'scalar', sqlType: 'TEXT' },
          implementation: titleCase
        }
      },
      {
        schema: {
          name: 'repeat',
          numArgs: 2,
          flags: 1, // FunctionFlags.UTF8
          returnType: { typeClass: 'scalar', sqlType: 'TEXT' },
          implementation: repeat
        }
      },
      {
        schema: {
          name: 'slugify',
          numArgs: 1,
          flags: 1, // FunctionFlags.UTF8
          returnType: { typeClass: 'scalar', sqlType: 'TEXT' },
          implementation: slugify
        }
      },
      {
        schema: {
          name: 'word_count',
          numArgs: 1,
          flags: 1, // FunctionFlags.UTF8
          returnType: { typeClass: 'scalar', sqlType: 'INTEGER' },
          implementation: wordCount
        }
      },
      {
        schema: {
          name: 'str_concat',
          numArgs: -1, // Variable arguments
          flags: 1, // FunctionFlags.UTF8
          returnType: { typeClass: 'scalar', sqlType: 'TEXT' },
          implementation: strConcat
        }
      },
      // Table-valued function
      {
        schema: {
          name: 'str_stats',
          numArgs: 1,
          flags: 1, // FunctionFlags.UTF8
          returnType: { 
            typeClass: 'relation',
            columns: [
              { name: 'metric', type: 'TEXT' },
              { name: 'value', type: 'INTEGER' }
            ]
          },
          implementation: strStats
        }
      }
    ]
  };
}