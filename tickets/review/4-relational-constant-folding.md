description: Review relational constant folding — materialization of foldable relational subtrees at plan time
dependencies: none
files:
  - packages/quereus/src/planner/analysis/const-pass.ts (border detection for void-type nodes, relational evaluator dispatch)
  - packages/quereus/src/planner/analysis/const-evaluator.ts (MaterializingAsyncIterable, createRuntimeRelationalEvaluator)
  - packages/quereus/src/planner/nodes/values-node.ts (TableLiteralNode predefinedAttributes support)
  - packages/quereus/src/planner/framework/pass.ts (wiring relational evaluator in constant folding pass)
  - packages/quereus/src/planner/optimizer.ts (wiring relational evaluator in performConstantFolding)
  - packages/quereus/test/logic/85-relational-const-folding.sqllogic (sqllogic integration tests)
  - packages/quereus/test/optimizer/relational-const-folding.spec.ts (plan-level optimizer tests)
  - packages/quereus/test/logic/03.5-tvf.sqllogic (updated expectations for folded plans)
  - docs/optimizer-const.md (section 5 rewrite, section 9 update)
  - docs/optimizer.md (Known Issues update)
----

## What was built

Relational constant folding: constant relational subtrees (VALUES with all-literal cells, constant subqueries like `SELECT 1+2`, deterministic TVF calls with constant args) are now replaced with `TableLiteralNode` during the optimizer's Pass 0 constant folding.

### Architecture

**Deferred materialization pattern** — keeps the optimizer synchronous:
1. At plan time, the relational subtree is emitted into an instruction tree + Scheduler
2. A `MaterializingAsyncIterable` wraps execution: first iteration runs the scheduler and caches all rows; subsequent iterations yield from cache
3. A `TableLiteralNode` replaces the original subtree, preserving attribute IDs via `predefinedAttributes`

### Key changes

1. **`TableLiteralNode`** — added optional `predefinedAttributes` constructor param to preserve attribute IDs across folding (same pattern as `ValuesNode`)

2. **`const-evaluator.ts`** — added `MaterializingAsyncIterable` class and `createRuntimeRelationalEvaluator()` factory. The evaluator emits the relational subtree, wraps it in a self-caching iterable, and constructs a replacement `TableLiteralNode`

3. **`const-pass.ts`** — three changes:
   - `ConstFoldingContext` gained `evaluateRelation?` field
   - `performConstantFolding` accepts optional relational evaluator
   - `replaceBorderNodes` dispatches to relational evaluator for non-scalar border nodes
   - Border detection now recurses through void-type const nodes (e.g., Block) instead of marking them as borders

4. **`pass.ts` / `optimizer.ts`** — both create and pass the relational evaluator alongside the scalar evaluator

## Testing notes

- `test/logic/85-relational-const-folding.sqllogic` — 11 sqllogic test cases covering VALUES folding, constant subqueries, table references (not folded), mixed joins, nulls, booleans, repeated execution
- `test/optimizer/relational-const-folding.spec.ts` — 6 plan-level tests verifying `TableLiteral` appears in plans, attribute ID stability, correct results after folding, repeated execution
- `test/logic/03.5-tvf.sqllogic` — updated `query_plan()` and `scheduler_program()` expectations to reflect folded inner plans
- Full test suite: 262 passing, 1 pre-existing failure (08.1-semi-anti-join)

## What to verify in review

- Correctness of `MaterializingAsyncIterable` (thread safety of caching, error handling)
- Attribute ID preservation end-to-end
- Border detection logic for void-type nodes
- That non-deterministic and mutating nodes are never folded
- Documentation accuracy
