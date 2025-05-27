# Quereus Runtime

## Emission Context (`src/runtime/emission-context.ts`)

The `EmissionContext` provides schema lookups during query plan emission and captures schema dependencies for runtime consistency. This ensures that queries maintain a consistent view of the schema from emission time, preventing obscure runtime errors when schema objects are modified after planning.

### Key Components

1. **Schema Dependency Tracking:** Records dependencies on tables, functions, virtual table modules, and collations during emission.
2. **Schema Snapshot:** Captures actual schema object references at emission time for runtime use.
3. **Validation:** Provides early error detection when schema objects are removed after planning.

### Usage Pattern

```typescript
// During emission
const table = emissionContext.findTable('users');
const func = emissionContext.findFunction('custom_func', 2);

// At runtime - uses captured objects
const capturedTable = emissionContext.getCapturedSchemaObject('table:main:users');
```

### Benefits

- **Predictable Behavior:** Queries see consistent schema view from emission time
- **Clean Error Messages:** Schema validation provides clear error context
- **No Complex Invalidation:** Avoids plan caching complexity for embedded systems
- **Minimal Overhead:** Just holds references to already-looked-up objects

## Scheduler (`src/runtime/scheduler.ts`)

The `Scheduler` is responsible for executing a potentially complex tree of `Instruction` objects efficiently. It handles the dependencies between instructions and manages the flow of data, including asynchronous results (`Promise<SqlValue>`).

### Construction

1.  **Input:** The `Scheduler` is constructed with a single `root` `Instruction`, which represents the final operation in a query plan (e.g., yielding a result row).
2.  **Tree Traversal:** The constructor performs a post-order traversal of the instruction tree starting from the `root`.
3.  **Flattening:** As it traverses, it flattens the tree structure into a linear array (`this.instructions`). The order ensures that an instruction's parameters (child nodes in the original tree) appear *before* the instruction itself in the flat list. The `root` instruction will always be the *last* element in this array.
4.  **Dependency Mapping:** It also builds a `destinations` array. This array maps the output of each instruction (by its index in the flattened list) to the input argument (parameter) of the instruction that consumes it. If an instruction's output is not used by another instruction (e.g., the final `root` instruction), its destination is `null`.

### Execution (`run` method)

The `async run(ctx: RuntimeContext)` method executes the flattened instruction list:

1.  **Single Pass:** It iterates through the `instructions` array from index 0 up to `length - 1`.
2.  **Argument Preparation:** For each instruction `i`, it retrieves the arguments prepared for it (`instrArgs[i]`). These arguments are the outputs of previously executed instructions, routed via the `destinations` map.
3.  **Asynchronous Handling:**
    *   It maintains a `hasPromise` flag for each instruction's argument list.
    *   If `hasPromise[i]` is true, it means at least one argument for instruction `i` is a `Promise`.
    *   It uses `await Promise.all(args)` to wait for *all* promise arguments to resolve *before* executing the instruction. This allows dependencies to be resolved concurrently when possible, maximizing efficiency. The resolved values are then passed to the instruction.
4.  **Execution:** It calls `this.instructions[i].run(ctx, ...args)` with the prepared (and potentially awaited) arguments.
5.  **Output Routing:** The `output` of `instructions[i]` is then placed into the argument list (`instrArgs`) for the `destination` instruction, as determined by the `destinations` map. If the `output` is a `Promise`, the corresponding `hasPromise` flag for the destination instruction is set.
6.  **Memory Management:** To minimize peak memory usage, the argument list for instruction `i` (`instrArgs[i]`) is cleared (`undefined`) after its execution.
7.  **Final Result:** After the loop completes, the `output` variable holds the result of the final instruction in the list (which corresponds to the original `root`), and this value is returned.

### Assumptions and Guarantees

*   **Execution Order:** The Scheduler guarantees that an instruction will only execute *after* all the instructions that produce its direct inputs have completed. This sequential dependency is strictly maintained.
*   **Promise Resolution:** While the *resolution* of multiple `Promise` arguments for a single instruction may happen concurrently via `Promise.all`, the instruction itself is only executed *after* all those promises have resolved. The user defining instructions does not need to worry about the exact timing of concurrent promise resolutions, only that the dependencies are met before execution proceeds.
*   **`AsyncIterable`:** The type `RuntimeValue` includes `AsyncIterable<Row>`. The current scheduler implementation passes these values through directly as outputs/inputs. Instructions that receive or produce `AsyncIterable` need to be designed to handle them appropriately (e.g., an instruction consuming rows might iterate the async iterable).

