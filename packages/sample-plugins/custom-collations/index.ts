/**
 * Custom Collations Plugin for Quereus
 *
 * This plugin demonstrates how to register custom collation functions in Quereus.
 * Collations control how text is sorted and compared in ORDER BY clauses and comparisons.
 *
 * Collations provided:
 * - NUMERIC - Natural numeric sorting ("file2.txt" < "file10.txt")
 * - LENGTH - Sort by string length, then lexicographically
 * - REVERSE - Reverse lexicographic order
 * - ALPHANUM - Alphanumeric sorting (handles mixed text and numbers)
 * - PHONETIC - Simple phonetic-like sorting (vowels treated as equivalent)
 */

import type { Database, SqlValue, CollationFunction } from '@quereus/quereus';

/**
 * Natural numeric sorting collation
 * Handles embedded numbers naturally: "file2.txt" < "file10.txt"
 */
const numericCollation: CollationFunction = (a: string, b: string): number => {
  // Split strings into alternating text and numeric parts
  const parseString = (str: string): (string | number)[] => {
    const parts: (string | number)[] = [];
    let current = '';
    let inNumber = false;
    
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      const isDigit = char >= '0' && char <= '9';
      
      if (isDigit !== inNumber) {
        if (current) {
          parts.push(inNumber ? Number(current) : current);
          current = '';
        }
        inNumber = isDigit;
      }
      current += char;
    }
    
    if (current) {
      parts.push(inNumber ? Number(current) : current);
    }
    
    return parts;
  };
  
  const partsA = parseString(a);
  const partsB = parseString(b);
  
  const maxLen = Math.max(partsA.length, partsB.length);
  
  for (let i = 0; i < maxLen; i++) {
    const partA = partsA[i];
    const partB = partsB[i];
    
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    
    // Compare numbers numerically, strings lexicographically
    if (typeof partA === 'number' && typeof partB === 'number') {
      if (partA !== partB) return partA < partB ? -1 : 1;
    } else {
      const strA = String(partA);
      const strB = String(partB);
      if (strA !== strB) return strA < strB ? -1 : 1;
    }
  }
  
  return 0;
};

/**
 * Length-based collation
 * Sort by string length first, then lexicographically
 */
const lengthCollation: CollationFunction = (a: string, b: string): number => {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Reverse lexicographic collation
 * Opposite of normal sorting
 */
const reverseCollation: CollationFunction = (a: string, b: string): number => {
  return a < b ? 1 : a > b ? -1 : 0;
};

/**
 * Alphanumeric collation
 * More sophisticated handling of mixed text and numbers
 */
const alphanumCollation: CollationFunction = (a: string, b: string): number => {
  interface Token {
    type: 'text' | 'number';
    value: string | number;
  }

  const tokenize = (str: string): Token[] => {
    const tokens: Token[] = [];
    let i = 0;
    
    while (i < str.length) {
      if (str[i] >= '0' && str[i] <= '9') {
        // Extract number
        let num = '';
        while (i < str.length && str[i] >= '0' && str[i] <= '9') {
          num += str[i++];
        }
        tokens.push({ type: 'number', value: parseInt(num, 10) });
      } else {
        // Extract text
        let text = '';
        while (i < str.length && (str[i] < '0' || str[i] > '9')) {
          text += str[i++];
        }
        tokens.push({ type: 'text', value: text.toLowerCase() });
      }
    }
    
    return tokens;
  };
  
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  
  const maxLen = Math.max(tokensA.length, tokensB.length);
  
  for (let i = 0; i < maxLen; i++) {
    const tokenA = tokensA[i];
    const tokenB = tokensB[i];
    
    if (!tokenA) return -1;
    if (!tokenB) return 1;
    
    // Different types: text comes before numbers
    if (tokenA.type !== tokenB.type) {
      return tokenA.type === 'text' ? -1 : 1;
    }
    
    // Same type: compare values
    if (tokenA.value !== tokenB.value) {
      return tokenA.value < tokenB.value ? -1 : 1;
    }
  }
  
  return 0;
};

/**
 * Phonetic-like collation
 * Groups similar-sounding characters together
 */
const phoneticCollation: CollationFunction = (a: string, b: string): number => {
  const normalize = (str: string): string => {
    return str.toLowerCase()
      // Group similar vowels
      .replace(/[aeiou]/g, 'a')
      // Group similar consonants
      .replace(/[bp]/g, 'b')
      .replace(/[fv]/g, 'f')
      .replace(/[kg]/g, 'k')
      .replace(/[sz]/g, 's')
      .replace(/[td]/g, 't')
      // Remove silent letters (basic)
      .replace(/h/g, '')
      .replace(/(.)\1+/g, '$1'); // Remove consecutive duplicates
  };
  
  const normA = normalize(a);
  const normB = normalize(b);
  
  // If normalized forms are different, use that
  if (normA !== normB) {
    return normA < normB ? -1 : 1;
  }
  
  // If normalized forms are the same, fall back to exact comparison
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Plugin registration function
 */
export default function register(db: Database, config: Record<string, SqlValue> = {}) {
  console.log('Custom Collations plugin loaded with config:', config);
  
  // Return collation registrations
  return {
    collations: [
      {
        name: 'NUMERIC',
        func: numericCollation
      },
      {
        name: 'LENGTH',
        func: lengthCollation
      },
      {
        name: 'REVERSE',
        func: reverseCollation
      },
      {
        name: 'ALPHANUM',
        func: alphanumCollation
      },
      {
        name: 'PHONETIC',
        func: phoneticCollation
      }
    ]
  };
}

