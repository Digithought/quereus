# Error Handling in Quereus

Quereus employs a structured approach to error handling to provide context and aid debugging. Errors are generally propagated as instances of `SqliteError` (or its subclasses) found in `src/common/errors.ts`.

## Error Propagation Flow

1.  **Lexer/Parser Errors:**
    *   Syntax errors detected during lexing or parsing generate a `ParseError`.
    *   `ParseError` inherits from `SqliteError` and includes the specific `Token` that caused the error, providing line and column information.

2.  **Compiler Errors:**
    *   The `Compiler` (`src/compiler/compiler.ts`) wraps the parsing process.
    *   If a `ParseError` occurs, the Compiler catches it and re-throws it as a `SqliteError`. The original `ParseError` is attached as the `cause` property, and the line/column information is preserved.
    *   Semantic errors detected during compilation (e.g., "table not found", "ambiguous column", "type mismatch") also throw `SqliteError`.
    *   These compiler-generated errors attempt to include the location (`line`, `column`) derived from the relevant Abstract Syntax Tree (AST) node (`loc` property) where the error was detected.

3.  **VDBE Runtime Errors:**
    *   The Virtual Database Engine (VDBE) (`src/vdbe/engine.ts`) executes the compiled bytecode.
    *   Calls to potentially error-prone operations are wrapped in `try-catch` blocks:
        *   User-Defined Functions (UDFs) via `Opcode.Function`, `Opcode.AggStep`, `Opcode.AggFinal`.
        *   Virtual Table methods (`xFilter`, `xNext`, `xColumn`, `xUpdate`, etc.) via VTab opcodes.
    *   If an error occurs within a UDF or VTab method:
        *   The VDBE catches the exception.
        *   If it's not already a `SqliteError`, it's wrapped in one.
        *   Contextual information (e.g., "Error in function X:", "Error in VTab Y.xFilter:", Program Counter) is added to the error message.
        *   The original caught error is attached as the `cause` property.
        *   The VDBE halts execution and surfaces the `SqliteError`.
    *   Internal VDBE errors (e.g., stack issues, invalid opcode) are also caught and reported as `SqliteError` with an `INTERNAL` status code.

## SqliteError Structure

The base `SqliteError` class provides the following properties:

*   `message`: (String) The primary error description.
*   `code`: (Number) A `StatusCode` enum value (from `src/common/constants.ts`) indicating the error type (e.g., `ERROR`, `CONSTRAINT`, `INTERNAL`).
*   `cause`: (Error | undefined) The original underlying error object, if the `SqliteError` is wrapping another exception.
*   `line`: (Number | undefined) The 1-based line number where the error originated (if available).
*   `column`: (Number | undefined) The 1-based column number where the error originated (if available).

This structure allows consumers to access specific details about the error, including its origin and potential root cause, facilitating better error reporting and debugging. 
