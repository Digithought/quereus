# Window Function Processing in Titan Architecture

This document outlines a conceptual approach to implementing SQL window functions within Quereus's new Titan architecture (immutable PlanNodes and Instruction-based runtime).

## Overview

Window functions perform calculations across a set of table rows related to the current row without collapsing them. In the Titan architecture, this would likely involve several stages:

1.  **Main Query Plan Execution**: The `PlanNode` tree for the main query (FROM, WHERE, GROUP BY, HAVING, excluding the window functions themselves) is constructed by the planner.
2.  **Data Preparation & Sorting**: 
    *   The result of the main query plan needs to be materialized and sorted according to `PARTITION BY` and `ORDER BY` clauses of all window functions used in the query.
    *   This might involve a `SortNode` in the plan, potentially outputting to a temporary in-memory structure (e.g., an array of `Row` objects or a temporary `MemoryTable` if the dataset is large).
    *   The data fed into this sorting/materialization step would include all columns needed for partitioning, ordering, and as arguments to any window functions, plus any other columns required for the final SELECT list.
3.  **Window Function Calculation Pass**: 
    *   A new set of `Instruction`s (or a dedicated `WindowAggregateInstruction`) would iterate over the sorted and partitioned data.
    *   This pass calculates the window function results for each row.
4.  **Final Projection**: The results, now including the calculated window function values, are projected to produce the final output rows via a `ProjectNode` and its corresponding emitter.

## Key Architectural Components (Titan)

*   **Planner (`src/planner/`)**:
    *   Responsible for parsing window function calls (`AST.WindowFunctionExpr`) in the SELECT list.
    *   It would construct a `PlanNode` (e.g., `WindowAggregateNode` or similar) that depends on the sorted input from the main query.
    *   This node would encapsulate all window function definitions (`PARTITION BY`, `ORDER BY`, frame specifications, and the specific window function like `ROW_NUMBER()`, `SUM() OVER (...)`).
*   **`PlanNode`s (`src/planner/nodes/`)**:
    *   A potential `WindowAggregateNode` (or a series of nodes) would manage the windowing logic. This node would take the sorted relation as input.
    *   `SortNode`: Would be crucial for preparing the data as required by `PARTITION BY` and `ORDER BY` clauses of the window definitions.
*   **`Instruction`-based Runtime (`src/runtime/`)**:
    *   **Emitters (`src/runtime/emitters.ts`, `src/runtime/emit/`)**: A specific emitter for `WindowAggregateNode` (e.g., `emitWindowAggregate`) would generate the graph of `Instruction`s for window calculations.
    *   **Window Function `Instruction`s**: These specialized instructions would:
        *   Iterate the sorted input (an `AsyncIterable<Row>`).
        *   Detect partition boundaries by comparing relevant column values from the current `Row` to the previous `Row`.
        *   Maintain state for each partition (e.g., row counters, running sums for aggregates within a frame).
        *   For each row, calculate the frame boundaries (e.g., `ROWS BETWEEN 2 PRECEDING AND CURRENT ROW`) based on the current row's position within its partition and the frame specification.
        *   Execute the specific window function logic:
            *   **Numbering Functions (`ROW_NUMBER`, `RANK`, `DENSE_RANK`)**: Calculated based on position within the partition and ordering key values.
            *   **Aggregate Functions (`SUM`, `AVG`, `COUNT`, etc. OVER window)**: Iterate rows within the current row's calculated frame, accumulating values.
            *   **Value Functions (`FIRST_VALUE`, `LAST_VALUE`, `LEAD`, `LAG`)**: Access data from other rows within the partition based on frame or offset.
        *   The output of these instructions would be the original row data augmented with the calculated window function results.
*   **Data Structures**: 
    *   If not using a temporary `MemoryTable` for sorted data, the `WindowAggregateInstruction` might need to buffer rows for the current partition or frame, especially for complex frames or functions like `LAG`/`LEAD` that require access to non-adjacent rows.

## Execution Flow (Conceptual for Titan)

1.  **Planning**: Planner creates a main query plan, a `SortNode` to prepare data for windowing, and a `WindowAggregateNode` that consumes the sorted data.
2.  **Execution - Main Query & Sort**: The `Scheduler` executes the main query plan and the `SortNode`. The result is an `AsyncIterable<Row>` sorted by partition and order keys.
3.  **Execution - Window Functions (`emitWindowAggregate` output)**:
    *   The `WindowAggregateInstruction` (or set of instructions) consumes the sorted `AsyncIterable<Row>`. 
    *   It iterates row by row.
    *   **Partition Management**: On encountering a new partition key value, it resets its internal state (accumulators for aggregates, row counters for numbering).
    *   **Frame Calculation**: For each row, it determines the start and end of its window frame within the current partition. This might involve looking ahead or behind in the (potentially buffered) stream of rows for frame types like `ROWS PRECEDING/FOLLOWING` or `RANGE`.
    *   **Function Execution**: 
        *   `ROW_NUMBER()`: Increment counter within partition.
        *   `RANK()` / `DENSE_RANK()`: Compare order keys with previous row to determine rank.
        *   Aggregates (`SUM() OVER...`): Accumulate values from rows within the current frame. This might require buffering rows of the current frame if it's not a simple `PARTITION` or `UNBOUNDED PRECEDING` to `CURRENT ROW`.
        *   `LAG()`/`LEAD()`: Access a row at a specific offset from the current row within the partition, potentially using a small buffer of recent/upcoming rows.
    *   Each input `Row` is augmented with the calculated window function results and yielded.
4.  **Execution - Final Projection**: The `ProjectNode` emitter takes these augmented rows and produces the final SELECT list.

## Key Considerations in Titan Architecture

*   **Streaming vs. Buffering**: Purely streaming window function calculation is hard for many frame types (e.g., `ROWS BETWEEN ... AND ...` requiring future rows, or `RANGE` requiring evaluation of values). The `WindowAggregateInstruction` will likely need to buffer rows, at least for the current partition or a sliding window corresponding to the frame.
*   **Async Iterables**: All data flow between major components (PlanNode emitters) will be via `AsyncIterable<Row>`. Window function instructions must consume and produce these.
*   **Key-Based Addressing**: There's no `rowid` for addressing rows in temporary structures. If a temporary `MemoryTable` is used for sorting, it will be key-based (identified by its `PRIMARY KEY`, which would likely be the PARTITION BY and ORDER BY keys of the window function to ensure uniqueness and sort order).
*   **Frame Boundary Logic**: Calculating frame boundaries dynamically for each row, especially for `RANGE` based on value differences or `GROUPS`, will be complex within an instruction.
*   **Extensibility**: New window functions could be added by defining their specific calculation logic within this framework.

This outlines a high-level approach. The detailed implementation of the `WindowAggregateNode` emitter and its associated `Instruction`s would be a significant undertaking. 
