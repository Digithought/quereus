# Enhanced Error Handling for Quoomb Clients

## Overview

This document describes the enhanced error handling features implemented for both the Quoomb web and CLI clients. The enhancements provide recursive unwrapping of nested QuereusError causes and click-to-navigate functionality in the web client.

## Features Implemented

### 1. Recursive Error Unwrapping

Both clients now recursively unwrap the `cause` chain of QuereusError instances, providing complete error context:

#### Core Utilities (`packages/quereus/src/common/errors.ts`)

- **`unwrapError(error: Error): ErrorInfo[]`** - Recursively unwraps an error and its causes
- **`formatErrorChain(errorChain: ErrorInfo[], includeStack: boolean): string`** - Formats an error chain for display
- **`getPrimaryError(error: Error): ErrorInfo`** - Gets the primary error info from a chain

#### ErrorInfo Interface
```typescript
interface ErrorInfo {
  message: string;
  code?: number;
  line?: number;
  column?: number;
  name: string;
  stack?: string;
}
```

### 2. Web Client Enhancements

#### Enhanced Error Display Component (`packages/quoomb-web/src/components/EnhancedErrorDisplay.tsx`)

- **Click-to-Navigate**: Error locations with line/column information are clickable and navigate to the source code
- **Expandable Error Chain**: Nested errors can be expanded to show the full causal chain
- **Selection Offset Adjustment**: Properly calculates line/column offsets when errors occur in selected text

#### Key Features:
- Primary error displayed prominently with location info
- Expandable section for nested errors
- Click handlers that navigate to error locations in Monaco editor
- Visual highlighting of error locations with automatic cleanup
- Proper offset calculation for selected code execution

#### Selection Tracking

The session store now tracks selection information when executing SQL:

```typescript
selectionInfo?: {
  isSelection: boolean;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}
```

#### Updated Components:
- **ResultsGrid**: Uses `EnhancedErrorDisplay` for error messages
- **MessagesPanel**: Shows enhanced error information with full error chain
- **EditorPanel**: Passes selection information when executing SQL

### 3. CLI Client Enhancements (`packages/quoomb-cli/src/repl.ts`)

#### Enhanced Error Display Method

The CLI now includes a `printEnhancedError()` method that:

- **Unwraps Error Chains**: Shows complete causal relationships
- **Color-Coded Output**: Different colors for primary errors, causes, and location info
- **Formatted Display**: Professional error presentation with separators
- **Location Information**: Highlights line and column numbers

#### Features:
- Colored error headers with separator lines
- Distinguishes between primary errors and causes
- Highlights location information (line/column)
- Graceful fallback for non-Error objects
- Consistent formatting with optional color support

#### Example Output:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SQL ERROR
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Error: Syntax error in SQL statement (at line 1, column 8)
Caused by: Unexpected token 'INVALID' 
Caused by: Parser failed to match expected pattern
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### 4. Technical Implementation Details

#### Session Store Updates

The `executeSQL` method now:
- Accepts optional `selectionInfo` parameter
- Captures full error chains using `unwrapError()`
- Stores both simple error messages and detailed error chains
- Tracks selection information for proper offset calculation

#### Monaco Editor Integration

Error navigation in the web client:
- Calculates target positions considering selection offsets
- Uses Monaco editor API to navigate to error locations
- Applies temporary visual highlighting with auto-cleanup
- Focuses the editor and positions cursor at error location

#### CSS Styling

Added error highlighting styles:
```css
.error-highlight {
  background-color: rgba(239, 68, 68, 0.2) !important;
  border: 1px solid rgb(239, 68, 68) !important;
  border-radius: 3px !important;
}

.error-glyph {
  background-color: rgb(239, 68, 68) !important;
  color: white !important;
}
```

## Usage Examples

### Web Client

1. **Basic Error Display**: Errors show with enhanced formatting and location information
2. **Click Navigation**: Click on line/column indicators to jump to error location
3. **Nested Errors**: Expand error chains to see full causal relationships
4. **Selection Errors**: Proper offset calculation when executing selected text

### CLI Client

1. **Enhanced Formatting**: Rich error display with color coding
2. **Error Chains**: Full causal relationship display
3. **Location Info**: Clear line and column information
4. **Professional Presentation**: Consistent formatting with separators

## Benefits

1. **Improved Debugging**: Complete error context with causal chains
2. **Better UX**: Click-to-navigate functionality in web client
3. **Consistent Experience**: Similar error handling across web and CLI
4. **Developer Friendly**: Detailed location information for quick issue resolution
5. **Robust Error Handling**: Graceful handling of both simple and complex error scenarios

## Future Enhancements

Potential improvements could include:
- Stack trace display options
- Error filtering and search
- Error history and tracking
- Integration with external debugging tools
- Custom error handling rules