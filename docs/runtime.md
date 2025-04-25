# VDBE Runtime Subsystem – Architectural Overview

## 1. Purpose
The *Virtual DataBase Engine* (VDBE) runtime is the execution core that interprets a low-level, register-based program produced by the SQL compiler. Inspired by SQLite's original VDBE, it provides an easily extensible, JavaScript/TypeScript implementation capable of running both synchronous and asynchronous instructions.

---

## 2. High-Level Components

| Component                                  | Location                        | Responsibility                                                                 |
| ------------------------------------------ | ------------------------------- | ------------------------------------------------------------------------------ |
| **`VdbeInstruction`**                      | `src/vdbe/instruction.ts`       | POJO describing a single instruction (opcode + operands).                       |
| **`Opcode` enum**                          | `src/vdbe/opcodes.ts`           | Canonical list of all opcodes (numeric & human-readable names).                |
| **`VdbeProgram` & `VdbeProgramBuilder`** | `src/vdbe/program.ts`           | Immutable container of compiled instructions plus metadata. Builder assists the compiler in producing it. |
| **`VmCtx` interface & friends**            | `src/vdbe/handler-types.ts`     | Execution context exposed to instruction handlers (stack, cursors, helpers…). |
| **Handler modules**                        | `src/vdbe/instructions/**/*.ts` | Pure functions implementing the semantics of each opcode family.               |
| **Global handler table**                   | `src/vdbe/handlers.ts`          | Populated at startup – maps every opcode index (`0…255`) to a handler. Fallback throws if unimplemented. |
| **`VdbeRuntime`**                          | `src/vdbe/runtime.ts`           | Concrete implementation of the VM. Owns the stack, cursors, error state, and the **fetch-execute** loop. |

![runtime-architecture](./images/vdbe_runtime_high_level.svg)
*(conceptual diagram – generation only, file not included)*

---

## 3. Execution Flow
1.  **Compilation** – The SQL compiler produces a `VdbeProgram` whose `instructions` array is a compact, register-based byte-code.
2.  **Instantiation** – The `Statement` wrapper creates a `VdbeRuntime`, passing the program and owning `Database` reference.
3.  **Binding** – Positional / named parameters are written directly into absolute stack indices via `applyBindings()`.
4.  **Fetch-Execute Loop** –
    ```ts
    while (!done) {
        const inst = code[pc];        // FETCH
        const handler = handlers[inst.opcode];
        const status = await handler(this, inst); // EXECUTE
        // status ≠ undefined ⇒ exit / ROW / ERROR / DONE
        pc = maybeUpdated ? pc : pc + 1; // ADVANCE
    }
    ```
5.  **Yield / Halt** – Handlers mutate `ctx` (the runtime) to indicate `done`, `hasYielded`, jump addresses, or errors, which are translated to `StatusCode` results for the higher layers.

---

## 4. Memory Model

```
┌──────── Stack (MemoryCell[]) ────────┐
│ index 0  : return PC (main)          │
│ index 1  : other control slot        │
│ index 2+ : Register 0 (user‐visible) │
│        … : Locals / Temps            │
└──────────────────────────────────────┘
```

*   **`stackPointer (SP)`** – first free slot (`length` of the active stack segment).
*   **`framePointer (FP)`** – base of the current activation frame. Registers are *relative* to `FP`; absolute index = `FP + offset`.
*   **Local variable offset (`localsStartOffset`)** – hard-coded to **2**. Offsets `< 2` are reserved for internal control data and *must not* be written by instructions outside frame manipulation helpers.
*   **MemoryCell** – thin wrapper `{ value: SqlValue }`, enabling future flag/extensions without breaking references.

### Frame Handling
*   `FrameEnter` pushes a new frame by storing the old `FP` at *FP + 1*, then moving `FP` and adjusting `SP` for declared local size.
*   `FrameLeave` validates and restores the former `FP`, trimming the stack back to it.

---

## 5. Cursor Sub-system
`VdbeCursor` holds the VM-side state for virtual table interaction:
*   `instance` – actual module cursor returned by `xOpen`.
*   `vtab` – owning virtual table.
*   `sortedResults` – optimized output for order-by handling.

Handlers such as `OpenRead`, `OpenWrite`, `VNext`, etc. manipulate these objects asynchronously.

---

## 6. Handler Architecture

*   All handlers share signature `(ctx: VmCtx, inst: VdbeInstruction) → Status | Promise<Status>`.
*   Families are grouped in modules under `src/vdbe/instructions/` for clarity (core, arith, compare, …).
*   Each module exposes a `registerHandlers(handlers)` helper that writes into the shared table.
*   Synchronous and asynchronous handlers coexist transparently – the runtime `run()` loop `await`s the result only when necessary.
*   Safety helpers (bounds checks, division-by-zero, etc.) throw **`SqliteError`** or **`ConstraintError`** which propagate into runtime error handling.

### Adding a New Instruction
1.  Add a new enum entry in `opcodes.ts` (ensure unique numeric code).
2.  Implement its semantics inside a new or existing category module.
3.  Call `handlers[Opcode.YourNewOp] = …` during module initialization.
    *Tip: re-export a `registerHandlers` function and call it from `src/vdbe/handlers.ts`.*
4.  Update test-suite.

---

## 7. Error & Status Propagation
| Signal           | How to Produce                         | Runtime Interpretation                      |
| ---------------- | -------------------------------------- | ------------------------------------------- |
| Normal advance   | return `undefined`                     | Continue loop, `pc` possibly updated.      |
| Row produced     | `ctx.hasYielded = true` **or** return `StatusCode.ROW` | `run()` returns `ROW`.                      |
| Completion       | `ctx.done = true` **or** return `StatusCode.DONE`  | `run()` returns `DONE`.                     |
| Jump             | mutate `ctx.pc`                        | Next fetch reads from new PC.              |
| Error            | throw `SqliteError` / set `ctx.error` | Execution stops, `run()` returns error code. |

---

## 8. Instruction Reference
Below is a detailed reference for every opcode currently **implemented** (has a handler function in `src/vdbe/instructions/`). Opcodes are grouped by the module where their handler is defined. Each entry describes the purpose, operands (p1-p5), and effect on the VM state.

**Operand Notation:**
*   `regX`: Refers to a register (memory cell) relative to the current Frame Pointer (`FP`). Access via `ctx.getMem(X)`, `ctx.setMem(X, value)`.
*   `addrX`: Refers to a program counter address (instruction index).
*   `constX`: Refers to an index into the program's constant pool (`program.constants`).
*   `cursorX`: Refers to a cursor index (`vdbeCursors[X]`).
*   `p4TYPE`: Indicates the expected type/interface for the `p4` operand.

---

### 8.1 Core / Control Flow (`instructions/core.ts`)

| Opcode                | p1         | p2          | p3          | p4                  | p5          | Effect                                                                                    |
| --------------------- | ---------- | ----------- | ----------- | ------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| **`Init`**            | _unused_   | `addrSTART` | _unused_    | _unused_            | _unused_    | Jumps program counter (`pc`) to `p2`. Typically the first instruction.                     |
| **`Goto`**            | _unused_   | `addrTARGET`| _unused_    | _unused_            | _unused_    | Unconditionally jumps `pc` to `p2`.                                                       |
| **`Halt`**            | `status`   | _unused_    | _unused_    | `string ERROR_MSG`  | _unused_    | Stops execution. Sets `ctx.done=true`. If `p1 != OK`, sets `ctx.error` with code `p1` and message `p4`. |
| **`Noop`**            | _unused_   | _unused_    | _unused_    | _unused_            | _unused_    | Does nothing. `pc` advances normally.                                                    |
| **`Integer`**         | `value`    | `regDEST`   | _unused_    | _unused_            | _unused_    | `Mem[p2] = p1`                                                                            |
| **`Int64`**           | _unused_   | `regDEST`   | _unused_    | `constIDX`          | _unused_    | `Mem[p2] = Const[p4]` (expects BigInt constant)                                           |
| **`String8`**         | _unused_   | `regDEST`   | _unused_    | `constIDX`          | _unused_    | `Mem[p2] = Const[p4]` (expects String constant)                                           |
| **`Null`**            | _unused_   | `regDEST`   | _unused_    | _unused_            | _unused_    | `Mem[p2] = null`                                                                          |
| **`Real`**            | _unused_   | `regDEST`   | _unused_    | `constIDX`          | _unused_    | `Mem[p2] = Const[p4]` (expects Number constant)                                           |
| **`Blob`**            | _unused_   | `regDEST`   | _unused_    | `constIDX`          | _unused_    | `Mem[p2] = Const[p4]` (expects Uint8Array constant)                                      |
| **`ZeroBlob`**        | `regSIZE`  | `regDEST`   | _unused_    | _unused_            | _unused_    | `Mem[p2] = new Uint8Array(Number(Mem[p1]))`                                              |
| **`SCopy`**           | `regSRC`   | `regDEST`   | _unused_    | _unused_            | _unused_    | `Mem[p2] = Mem[p1]`                                                                       |
| **`IfTrue`**          | `regCOND`  | `addrTARGET`| _unused_    | _unused_            | _unused_    | If `evaluateIsTrue(Mem[p1])`, jumps `pc` to `p2`.                                         |
| **`IfFalse`**         | `regCOND`  | `addrTARGET`| _unused_    | _unused_            | _unused_    | If `!evaluateIsTrue(Mem[p1])`, jumps `pc` to `p2`.                                        |
| **`IfZero`**          | `regVAL`   | `addrTARGET`| _unused_    | _unused_            | _unused_    | If `Mem[p1]` is 0, 0n, or null, jumps `pc` to `p2`.                                     |
| **`IfNull`**          | `regVAL`   | `addrTARGET`| _unused_    | _unused_            | _unused_    | If `Mem[p1] == null`, jumps `pc` to `p2`.                                               |
| **`IfNotNull`**       | `regVAL`   | `addrTARGET`| _unused_    | _unused_            | _unused_    | If `Mem[p1] != null`, jumps `pc` to `p2`.                                               |
| **`IsNull`**          | `regVAL`   | `regDEST`   | _unused_    | _unused_            | _unused_    | `Mem[p2] = (Mem[p1] == null)`                                                             |
| **`NotNull`**         | `regVAL`   | `regDEST`   | _unused_    | _unused_            | _unused_    | `Mem[p2] = (Mem[p1] != null)`                                                             |
| **`Move`**            | `offSRC`   | `offDEST`   | `count`     | _unused_            | _unused_    | Copies `p3` stack values from `FP+p1` to `FP+p2`. Handles overlap.                      |
| **`Clear`**           | `offSTART` | `count`     | _unused_    | _unused_            | _unused_    | Sets `p2` stack values starting at `FP+p1` to `null`.                                   |
| **`ConstraintViolation`** | _unused_ | _unused_    | _unused_    | `string ERROR_MSG`  | _unused_    | Throws `ConstraintError` with message `p4`. Stops execution.                             |

---

### 8.2 Comparison (`instructions/compare.ts`)

| Opcode    | p1        | p2          | p3        | p4              | p5        | Effect                                                                                 |
| --------- | --------- | ----------- | --------- | --------------- | --------- | -------------------------------------------------------------------------------------- |
| **`Eq`**  | `regA`    | `addrTARGET`| `regB`    | `P4Coll`        | _unused_  | If `compare(Mem[p1], Mem[p3], p4) == 0`, jumps `pc` to `p2`.                           |
| **`Ne`**  | `regA`    | `addrTARGET`| `regB`    | `P4Coll`        | _unused_  | If `compare(Mem[p1], Mem[p3], p4) != 0`, jumps `pc` to `p2`.                           |
| **`Lt`**  | `regA`    | `addrTARGET`| `regB`    | `P4Coll`        | _unused_  | If `compare(Mem[p1], Mem[p3], p4) < 0`, jumps `pc` to `p2`.                            |
| **`Le`**  | `regA`    | `addrTARGET`| `regB`    | `P4Coll`        | _unused_  | If `compare(Mem[p1], Mem[p3], p4) <= 0`, jumps `pc` to `p2`.                           |
| **`Gt`**  | `regA`    | `addrTARGET`| `regB`    | `P4Coll`        | _unused_  | If `compare(Mem[p1], Mem[p3], p4) > 0`, jumps `pc` to `p2`.                            |
| **`Ge`**  | `regA`    | `addrTARGET`| `regB`    | `P4Coll`        | _unused_  | If `compare(Mem[p1], Mem[p3], p4) >= 0`, jumps `pc` to `p2`.                           |

---

### 8.3 Arithmetic (`instructions/arith.ts`)

| Opcode        | p1             | p2                | p3         | p4        | p5        | Effect                                                                                 |
| ------------- | -------------- | ----------------- | ---------- | --------- | --------- | -------------------------------------------------------------------------------------- |
| **`Add`**     | `regA`         | `regB`            | `regDEST`  | _unused_  | _unused_  | `Mem[p3] = Mem[p1] + Mem[p2]`. Uses BigInt if either operand is BigInt. Result is `null` on type error or non-finite result. |
| **`Subtract`**| `regA`         | `regB`            | `regDEST`  | _unused_  | _unused_  | `Mem[p3] = Mem[p2] - Mem[p1]`. (Note operand order). Uses BigInt rules. Result is `null` on error. |
| **`Multiply`**| `regA`         | `regB`            | `regDEST`  | _unused_  | _unused_  | `Mem[p3] = Mem[p1] * Mem[p2]`. Uses BigInt rules. Result is `null` on error.          |
| **`Divide`**  | `regDIVISOR`   | `regNUMERATOR`    | `regDEST`  | _unused_  | _unused_  | `Mem[p3] = Number(Mem[p2]) / Number(Mem[p1])`. Result is `null` if divisor is 0/null or result is non-finite. |
| **`Remainder`**| `regDIVISOR` | `regNUMERATOR` | `regDEST` | _unused_ | _unused_ | `Mem[p3] = Mem[p2] % Mem[p1]`. Uses BigInt rules. Result is `null` if divisor is 0/null or non-finite. Throws error if `BigInt(0)` divisor. |
| **`Concat`**  | `regSTART`     | `regEND`          | `regDEST`  | _unused_  | _unused_  | Concatenates string representations of `Mem[p1]` through `Mem[p2]` into `Mem[p3]`. Skips nulls and blobs. |
| **`Negative`**| `regSRC`       | `regDEST`         | _unused_   | _unused_  | _unused_  | `Mem[p2] = -Mem[p1]`. Uses BigInt if needed. Result is `null` on error.               |

---

### 8.4 Bitwise (`instructions/bitwise.ts`)

*(All operations treat inputs as BigInt, coercing if necessary. Invalid coercion results in `0n` for binary ops, `-1n` for `BitNot`)*

| Opcode          | p1          | p2         | p3        | p4        | p5        | Effect                                   |
| --------------- | ----------- | ---------- | --------- | --------- | --------- | ---------------------------------------- |
| **`BitAnd`**    | `regA`      | `regB`     | `regDEST` | _unused_  | _unused_  | `Mem[p3] = BigInt(Mem[p1]) & BigInt(Mem[p2])` |
| **`BitOr`**     | `regA`      | `regB`     | `regDEST` | _unused_  | _unused_  | `Mem[p3] = BigInt(Mem[p1]) | BigInt(Mem[p2])` |
| **`ShiftLeft`** | `regAMOUNT` | `regVALUE` | `regDEST` | _unused_  | _unused_  | `Mem[p3] = BigInt(Mem[p2]) << BigInt(Mem[p1])` |
| **`ShiftRight`**| `regAMOUNT` | `regVALUE` | `regDEST` | _unused_  | _unused_  | `Mem[p3] = BigInt(Mem[p2]) >> BigInt(Mem[p1])` |
| **`BitNot`**    | `regSRC`    | `regDEST`  | _unused_  | _unused_  | _unused_  | `Mem[p2] = ~BigInt(Mem[p1])`             |

---

### 8.5 Type / Affinity (`instructions/types.ts`)

| Opcode       | p1          | p2       | p3        | p4             | p5        | Effect                                                                          |
| ------------ | ----------- | -------- | --------- | -------------- | --------- | ------------------------------------------------------------------------------- |
| **`Affinity`** | `offSTART`  | `count`  | _unused_  | `string TYPE`  | _unused_  | Applies affinity `p4` (`NUMERIC`, `INTEGER`, `REAL`, `TEXT`, `BLOB`) to registers `FP+p1` through `FP+p1+p2-1`. |

---

### 8.6 Subroutines & Frames (`instructions/subroutine.ts`)

| Opcode         | p1          | p2           | p3        | p4        | p5        | Effect                                                                                    |
| -------------- | ----------- | ------------ | --------- | --------- | --------- | ----------------------------------------------------------------------------------------- |
| **`FrameEnter`** | `frameSize` | _unused_     | _unused_  | _unused_  | _unused_  | Creates new stack frame. Saves old `FP` at `newFP+1`. Initializes locals `newFP+2` to `newFP+p1-1` to `null`. Sets `FP=newFP`, `SP=newFP+p1`. |
| **`FrameLeave`** | _unused_    | _unused_     | _unused_  | _unused_  | _unused_  | Restores `FP` from `currentFP+1`. Sets `SP = currentFP`.                                  |
| **`Subroutine`** | _unused_    | `addrTARGET` | _unused_  | _unused_  | _unused_  | Pushes return address (`pc+1`) onto stack. Jumps `pc` to `p2`.                             |
| **`Return`**     | _unused_    | _unused_     | _unused_  | _unused_  | _unused_  | Pops return address from stack (`SP-1`). Jumps `pc` to it. Increments `SP`.                 |
| **`Push`**       | `regSRC`    | _unused_     | _unused_  | _unused_  | _unused_  | Pushes `Mem[p1]` onto stack (increments `SP`).                                             |
| **`StackPop`**   | `count`     | _unused_     | _unused_  | _unused_  | _unused_  | Decrements `SP` by `p1`.                                                                  |

---

### 8.7 Cursor Management (`instructions/cursor.ts`)

| Opcode       | p1           | p2        | p3        | p4         | p5        | Effect                                                                                           |
| ------------ | ------------ | --------- | --------- | ---------- | --------- | ------------------------------------------------------------------------------------------------ |
| **`ResultRow`**| `offSTART`   | `count`   | _unused_  | _unused_   | _unused_  | Copies `p2` values from `FP+p1` to result buffer. Sets `ctx.hasYielded = true`. Returns `StatusCode.ROW`. |
| **`OpenRead`** | `cursorIDX`  | _unused_  | _unused_  | `P4Schema` | _unused_  | Opens cursor `p1` for reading via `p4.vtabInstance.module.xOpen`. (Async)                       |
| **`OpenWrite`**| `cursorIDX`  | _unused_  | _unused_  | `P4Schema` | _unused_  | Same as `OpenRead`. (Async)                                                                       |
| **`Close`**    | `cursorIDX`  | _unused_  | _unused_  | _unused_   | _unused_  | Closes cursor `p1` via `instance.close()`. Clears state. (Async)                                |

---

### 8.8 Scalar Functions (`instructions/function.ts`)

| Opcode       | p1        | p2            | p3         | p4          | p5        | Effect                                                                                      |
| ------------ | --------- | ------------- | ---------- | ----------- | --------- | ------------------------------------------------------------------------------------------- |
| **`Function`** | _unused_  | `regARGS_START` | `regRESULT`| `P4FuncDef` | _unused_  | Calls scalar function `p4.funcDef.xFunc` with `p4.nArgs` args from `Mem[p2]` onwards. Stores result in `Mem[p3]`. |

---

### 8.9 Aggregation (`instructions/aggregate.ts`)

| Opcode           | p1                   | p2             | p3                    | p4          | p5                | Effect                                                                                                                              |
| ---------------- | -------------------- | -------------- | --------------------- | ----------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **`MakeRecord`** | `offSTART`           | `count`        | `regDEST_KEY`         | _unused_    | _unused_          | Creates serialized key from `p2` values at `Mem[p1]` onwards, stores string key in `Mem[p3]`.                                           |
| **`AggStep`**    | `regGROUP_KEY_START` | `regARGS_START`| `regSERIALIZED_KEY`   | `P4FuncDef` | `numGROUP_KEYS`   | Retrieves/creates aggregate context for key `Mem[p3]`. Calls `p4.funcDef.xStep` with args from `Mem[p2]`. Stores `p5` group key values if new. |
| **`AggFinal`**   | `regSERIALIZED_KEY`  | _unused_       | `regDEST_RESULT`      | `P4FuncDef` | _unused_          | Retrieves context for key `Mem[p1]`. Calls `p4.funcDef.xFinal`. Stores result in `Mem[p3]`.                                          |
| **`AggReset`**   | _unused_             | _unused_       | _unused_              | _unused_    | _unused_          | Clears the aggregate context map and iterator.                                                                                      |
| **`AggIterate`** | _unused_             | _unused_       | _unused_              | _unused_    | _unused_          | Initializes the aggregate results iterator (`ctx.aggregateIterator`).                                                               |
| **`AggNext`**    | _unused_             | `addrIF_DONE`  | _unused_              | _unused_    | _unused_          | Advances iterator. Jumps `pc` to `p2` if done. Stores current `[key, {acc, keyValues}]` in `ctx.currentAggregateEntry`.               |
| **`AggKey`**     | _unused_             | `regDEST_KEY`  | _unused_              | _unused_    | _unused_          | Stores serialized key from `currentAggregateEntry` into `Mem[p2]`.                                                                    |
| **`AggContext`** | _unused_             | `regDEST_ACC`  | _unused_              | _unused_    | _unused_          | Stores accumulator from `currentAggregateEntry` into `Mem[p2]`.                                                                       |
| **`AggGroupValue`** | _unused_          | `keyINDEX`     | `regDEST_VAL`         | _unused_    | _unused_          | Stores the `p2`-th grouping key value from `currentAggregateEntry` into `Mem[p3]`.                                                     |

---

### 8.10 Ephemeral Tables (`instructions/ephemeral.ts`)

| Opcode            | p1           | p2          | p3        | p4              | p5        | Effect                                                                                              |
| ----------------- | ------------ | ----------- | --------- | --------------- | --------- | --------------------------------------------------------------------------------------------------- |
| **`OpenEphemeral`** | `cursorIDX`  | `numCOLS`   | _unused_  | `?TableSchema`  | _unused_  | Creates temporary `MemoryTable`. Opens cursor `p1` on it. Uses `p4` schema if provided, else defaults. (Async) |

---

### 8.11 Sorting (`instructions/sort.ts`)

| Opcode    | p1           | p2        | p3        | p4          | p5        | Effect                                                                                                  |
| --------- | ------------ | --------- | --------- | ----------- | --------- | ------------------------------------------------------------------------------------------------------- |
| **`Sort`**  | `cursorIDX`  | _unused_  | _unused_  | `P4SortKey` | _unused_  | Configures ephemeral `MemoryTable` cursor `p1` to sort based on `p4`. Sorting happens during iteration. |

---

### 8.12 Virtual Table Operations (`instructions/vtab.ts`)

| Opcode          | p1                | p2            | p3             | p4                    | p5        | Effect                                                                                                                |
| --------------- | ----------------- | ------------- | -------------- | --------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| **`VFilter`**   | `cursorIDX`       | `addrIF_EMPTY`| `regARGS_START`| `{idxNum,idxStr,nArgs}` | _unused_  | Calls `cursor[p1].instance.filter` with `p4` info and args from `Mem[p3]`. Jumps `pc` to `p2` if EOF after filter. (Async) |
| **`VNext`**     | `cursorIDX`       | `addrIF_EOF`  | _unused_       | _unused_              | _unused_  | Advances `cursor[p1].instance.next()`. Jumps `pc` to `p2` if EOF. Handles `sortedResults`. (Async)                  |
| **`Rewind`**    | `cursorIDX`       | `addrIF_EMPTY`| _unused_       | _unused_              | _unused_  | Resets `cursor[p1]` (like `filter(0,null,[])`). Jumps `pc` to `p2` if EOF. Handles `sortedResults`. (Async)         |
| **`VColumn`**   | `cursorIDX`       | `colIDX`      | `regDEST`      | _unused_              | _unused_  | Gets column `p2` from `cursor[p1].instance.column()` into `Mem[p3]`. Returns `null` if EOF. Handles `sortedResults`.     |
| **`VRowid`**    | `cursorIDX`       | `regDEST`     | _unused_       | _unused_              | _unused_  | Gets `rowid` from `cursor[p1].instance.rowid()` into `Mem[p2]`. Throws if EOF. (Async)                               |
| **`VUpdate`**   | `nDATA`           | `regDATA_START`| `regOUT`      | `P4Update`            | _unused_  | Calls `p4.table.vtabInstance.module.xUpdate` with `p1` values from `Mem[p2]`. Stores output (e.g., new rowid) in `Mem[p3]` if `p3 > 0`. (Async) |
| **`VBegin`**    | `cursorSTART_IDX` | `cursorEND_IDX`| _unused_      | _unused_              | _unused_  | Calls `xBegin` on relevant modules for cursors `p1` to `p2-1`. (Async)                                               |
| **`VCommit`**   | `cursorSTART_IDX` | `cursorEND_IDX`| _unused_      | _unused_              | _unused_  | Calls `xCommit` on relevant modules for cursors `p1` to `p2-1`. (Async)                                              |
| **`VRollback`** | `cursorSTART_IDX` | `cursorEND_IDX`| _unused_      | _unused_              | _unused_  | Calls `xRollback` on relevant modules for cursors `p1` to `p2-1`. (Async)                                            |
| **`VSync`**     | `cursorSTART_IDX` | `cursorEND_IDX`| _unused_      | _unused_              | _unused_  | Calls `xSync` on relevant modules for cursors `p1` to `p2-1`. (Async)                                                |
| **`VSavepoint`**| `cursorSTART_IDX` | `cursorEND_IDX`| `savepointIDX`| _unused_              | _unused_  | Calls `xSavepoint(..., p3)` on relevant modules for cursors `p1` to `p2-1`. (Async)                                  |
| **`VRelease`**  | `cursorSTART_IDX` | `cursorEND_IDX`| `savepointIDX`| _unused_              | _unused_  | Calls `xRelease(..., p3)` on relevant modules for cursors `p1` to `p2-1`. (Async)                                    |
| **`VRollbackTo`**|`cursorSTART_IDX` | `cursorEND_IDX`| `savepointIDX`| _unused_              | _unused_  | Calls `xRollbackTo(..., p3)` on relevant modules for cursors `p1` to `p2-1`. (Async)                                |

---

### 8.13 Schema Operations (`instructions/schema.ts`)

| Opcode          | p1           | p2        | p3        | p4                | p5        | Effect                                                                            |
| --------------- | ------------ | --------- | --------- | ----------------- | --------- | --------------------------------------------------------------------------------- |
| **`SchemaChange`**| `cursorIDX`  | _unused_  | _unused_  | `P4SchemaChange`  | _unused_  | Calls `cursor[p1].vtab.module.xAlterSchema` with `p4` change info. (Async)         |
| **`AlterTable`**  | *TBD*        | *TBD*     | *TBD*     | *TBD*             | *TBD*     | Currently a No-Op. May trigger schema invalidation actions later.                 |

---

### 8.14 Seeking Operations (`instructions/seek.ts`)

| Opcode          | p1           | p2           | p3          | p4        | p5            | Effect                                                                                                                            |
| --------------- | ------------ | ------------ | ----------- | --------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **`SeekRelative`**| `cursorIDX`  | `addrJUMP`   | `regOFFSET` | _unused_  | `invertJUMP?` | Calls `cursor[p1].instance.seekRelative(Mem[p3])`. Jumps `pc` to `p2` if (seek successful AND !p5) OR (seek failed AND p5). (Async) |
| **`SeekRowid`**   | `cursorIDX`  | `addrJUMP`   | `regROWID`  | _unused_  | `invertJUMP?` | Calls `cursor[p1].instance.seekToRowid(Mem[p3])`. Jumps `pc` to `p2` if (seek successful AND !p5) OR (seek failed AND p5). (Async) |

**Note:** Many additional opcodes exist in `opcodes.ts` but are *not* yet implemented; the default handler will throw `Unsupported opcode` if they appear at runtime.

---

## 9. Future Work & Extensibility
*   Implement remaining opcodes (e.g., `IdxInsert`, `Next`, DDL opcodes like `CreateTable`).
*   Swap the simple `MemoryCell` wrapper for richer flags (type, encoding, etc.) closer to SQLite's `Mem` struct.
*   Introduce a cost-based optimizer / JIT for hot instruction sequences.
*   Add structured logging & tracing hooks for debugging.

---

*Generated automatically – keep in sync with source files.*
