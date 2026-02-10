# Error Handling in Quereus

Quereus employs a structured approach to error handling to provide context and aid debugging. Errors are generally propagated as instances of `QuereusError` (or its subclasses) found in `src/common/errors.ts`.

## Error Class Hierarchy

*   **`QuereusError`** — Base error class for all Quereus-specific errors. Extends `Error` with status code, line/column location, and cause chaining.
*   **`ParseError`** — Thrown by the parser for SQL syntax errors. Extends `QuereusError` with the offending `Token`, providing line/column from the token position.
*   **`ConstraintError`** — Thrown when a database constraint (UNIQUE, NOT NULL, CHECK) is violated. Uses `StatusCode.CONSTRAINT`.
*   **`MisuseError`** — Thrown when the API is used incorrectly (e.g., operating on a closed database or finalized statement). Uses `StatusCode.MISUSE`.

All subclasses support error cause chaining via the `cause` parameter.

## Error Propagation Flow

1.  **Lexer/Parser Errors:**
    *   Syntax errors detected during lexing or parsing generate a `ParseError`.
    *   `ParseError` extends `QuereusError` and includes the specific `Token` that caused the error, providing line and column information.

2.  **Planner Errors:**
    *   The planner builds a `PlanNode` tree from the AST.
    *   Semantic errors (e.g., "table not found", "ambiguous column", "type mismatch") throw `QuereusError` using the `quereusError()` helper, which extracts line/column from AST node `loc` properties.
    *   These errors include `StatusCode.ERROR` by default.

3.  **Runtime Errors:**
    *   The runtime executes the emitted instruction graph.
    *   Calls to potentially error-prone operations are wrapped in `try-catch` blocks:
        *   User-Defined Functions (UDFs) via function calls.
        *   Virtual Table methods (`query`, `update`, `disconnect`, etc.) via runtime emitters.
    *   If an error occurs within a UDF or VTab method:
        *   The runtime catches the exception.
        *   If it's not already a `QuereusError`, it's wrapped in one.
        *   Contextual information (e.g., "Error in function X:", "Error in VTab Y.query:", location) is added to the error message.
        *   The original caught error is attached as the `cause` property.
        *   The scheduler halts execution and surfaces the `QuereusError`.
    *   Constraint violations return `ConstraintError` with `StatusCode.CONSTRAINT`.

## QuereusError Structure

The base `QuereusError` class provides the following properties:

*   `message`: (String) The primary error description. Enhanced with location info if available.
*   `code`: (Number) A `StatusCode` enum value indicating the error type (e.g., `ERROR`, `CONSTRAINT`, `MISUSE`, `UNSUPPORTED`).
*   `cause`: (Error | undefined) The original underlying error object, if the `QuereusError` is wrapping another exception.
*   `line`: (Number | undefined) The 1-based line number where the error originated (if available from AST/token).
*   `column`: (Number | undefined) The 1-based column number where the error originated (if available from AST/token).

## Error Utilities

*   **`quereusError(message, code?, cause?, astNode?)`** — Helper that throws a `QuereusError`, automatically extracting `line`/`column` from an AST node's `loc` property.
*   **`unwrapError(error)`** — Recursively unwraps an error and its causes into an `ErrorInfo[]` chain.
*   **`formatErrorChain(chain, includeStack?)`** — Formats an error chain for display, showing "Error: ..." / "Caused by: ..." lines.
*   **`getPrimaryError(error)`** — Gets the `ErrorInfo` for the primary (outermost) error.

This structure allows consumers to access specific details about the error, including its origin and potential root cause, facilitating better error reporting and debugging.
