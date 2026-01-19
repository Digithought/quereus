# Error Handling in Quereus

Quereus employs a structured approach to error handling to provide context and aid debugging. Errors are generally propagated as instances of `QuereusError` (or its subclasses) found in `src/common/errors.ts`.

## Error Propagation Flow

1.  **Lexer/Parser Errors:**
    *   Syntax errors detected during lexing or parsing generate a `ParseError`.
    *   `ParseError` inherits from `QuereusError` and includes the specific `Token` that caused the error, providing line and column information.

2.  **Compiler Errors:**
    *   The `Compiler` (`src/compiler/compiler.ts`) wraps the parsing process.
    *   If a `ParseError` occurs, the Compiler catches it and re-throws it as a `QuereusError`. The original `ParseError` is attached as the `cause` property, and the line/column information is preserved.
    *   Semantic errors detected during compilation (e.g., "table not found", "ambiguous column", "type mismatch") also throw `QuereusError`.
    *   These compiler-generated errors attempt to include the location (`line`, `column`) derived from the relevant Abstract Syntax Tree (AST) node (`loc` property) where the error was detected.

3.  **Runtime Errors:**
    *   The runtime executes the compiled plan.
    *   Calls to potentially error-prone operations are wrapped in `try-catch` blocks:
        *   User-Defined Functions (UDFs) via function calls.
        *   Virtual Table methods (`query`, `update`, `disconnect`, etc.) via runtime emitters.
    *   If an error occurs within a UDF or VTab method:
        *   The runtime catches the exception.
        *   If it's not already a `QuereusError`, it's wrapped in one.
        *   Contextual information (e.g., "Error in function X:", "Error in VTab Y.query:", location) is added to the error message.
        *   The original caught error is attached as the `cause` property.
        *   The VDBE halts execution and surfaces the `QuereusError`.
    *   Internal VDBE errors (e.g., stack issues, invalid opcode) are also caught and reported as `QuereusError` with an `INTERNAL` status code.

## QuereusError Structure

The base `QuereusError` class provides the following properties:

*   `message`: (String) The primary error description.
*   `code`: (Number) A `StatusCode` enum value (from `src/common/constants.ts`) indicating the error type (e.g., `ERROR`, `CONSTRAINT`, `INTERNAL`).
*   `cause`: (Error | undefined) The original underlying error object, if the `QuereusError` is wrapping another exception.
*   `line`: (Number | undefined) The 1-based line number where the error originated (if available).
*   `column`: (Number | undefined) The 1-based column number where the error originated (if available).

This structure allows consumers to access specific details about the error, including its origin and potential root cause, facilitating better error reporting and debugging. 
