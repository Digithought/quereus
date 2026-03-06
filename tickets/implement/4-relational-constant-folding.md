description: Implement relational constant folding to materialize foldable relational subtrees at plan time
dependencies: constant-folding pass (implemented), runtime expression evaluator (implemented), TableLiteralNode (implemented)
files:
  - packages/quereus/src/planner/analysis/const-pass.ts (border replacement for relational nodes)
  - packages/quereus/src/planner/analysis/const-evaluator.ts (relational subtree evaluator)
  - packages/quereus/src/planner/nodes/values-node.ts (TableLiteralNode - add predefined attributes)
  - packages/quereus/src/planner/framework/pass.ts (pass wiring)
  - packages/quereus/src/planner/optimizer.ts (pass wiring)
  - docs/optimizer-const.md (update sections 5 and 9)
  - docs/optimizer.md (update Known Issues)
----

## Context

Scalar constant folding is implemented and working (three-phase: bottom-up classification, top-down border detection, replacement). The `replaceBorderNodes` function in `const-pass.ts:260-265` already detects relational border nodes but logs a TODO and returns the original node unchanged.

`TableLiteralNode` already exists in `values-node.ts:177-244` and has a working emitter in `runtime/emit/values.ts:47-65`. It accepts `ReadonlyArray<Row> | AsyncIterable<Row>`.

## Design

### Approach: Deferred Materialization via Self-Caching AsyncIterable

The optimizer pipeline is synchronous (`optimize()` returns `PlanNode`). Rather than making it async (which cascades through many call sites), use a **deferred materialization** pattern:

1. At plan time, emit the relational subtree into an instruction tree and create a Scheduler
2. Wrap execution in a **self-materializing AsyncIterable** — on first iteration it runs the scheduler, collects all rows into an array, and yields them; on subsequent iterations it yields from the cached array
3. Store this iterable in a `TableLiteralNode`, which replaces the original subtree

This keeps the optimizer synchronous while ensuring:
- The subtree is evaluated exactly once at first runtime access
- Subsequent executions (prepared statements) reuse the cached rows
- The plan tree is simplified (no complex subtree to re-optimize or re-emit)

### Changes

#### 1. `TableLiteralNode` — add predefined attributes support

Add an optional `predefinedAttributes` parameter to the constructor (same pattern as `ValuesNode`). When a relational subtree is replaced, the parent nodes still reference the old attribute IDs. The replacement `TableLiteralNode` must preserve these IDs.

```typescript
constructor(
    scope: Scope,
    rows: ReadonlyArray<Row> | AsyncIterable<Row>,
    rowCount: number | undefined,
    type: RelationType,
    predefinedAttributes?: Attribute[]  // NEW
)
```

In `buildAttributes()`, return `predefinedAttributes` if provided.

#### 2. `const-evaluator.ts` — add `createRuntimeRelationalEvaluator`

New exported function that returns a `(node: PlanNode) => PlanNode` evaluator for relational subtrees:

```typescript
export function createRuntimeRelationalEvaluator(
    db: Database
): (node: PlanNode) => PlanNode
```

Implementation:
- Emit the relational subtree via `emitPlanNode`
- Create a `Scheduler` from the instruction
- Create a self-materializing `AsyncIterable<Row>` that:
  - On first `[Symbol.asyncIterator]()` call: creates a minimal `RuntimeContext`, calls `scheduler.run()`, resolves any Promise, collects rows from the `AsyncIterable<Row>` result into an array, caches it
  - On subsequent calls: yields from the cached array
- Construct a `TableLiteralNode` with the iterable, preserving the original node's `RelationType` and attributes

The self-materializing iterable pattern:
```typescript
class MaterializingIterable {
    private cached: Row[] | null = null;

    constructor(private createSource: () => OutputValue) {}

    [Symbol.asyncIterator]() {
        if (this.cached) {
            return arrayToAsyncIterator(this.cached);
        }
        // First iteration: run source, collect, cache, yield
        return this.materializeAndYield();
    }
}
```

#### 3. `const-pass.ts` — handle relational border nodes in replacement

Update `ConstFoldingContext` to include an optional relational evaluator:

```typescript
export interface ConstFoldingContext {
    constInfo: Map<string, ConstInfo>;
    borderNodes: Map<string, PlanNode>;
    evaluateExpression: (node: PlanNode) => MaybePromise<OutputValue>;
    evaluateRelation?: (node: PlanNode) => PlanNode;  // NEW
}
```

Update `performConstantFolding` signature to accept the relational evaluator.

In `replaceBorderNodes`, replace the TODO block at lines 260-265:
```typescript
} else {
    // Relational node - replace with TableLiteralNode
    if (ctx.evaluateRelation) {
        const replacement = ctx.evaluateRelation(node);
        log('Replaced relational border node %s with TableLiteralNode', node.id);
        return replacement;
    }
    log('Relational border node %s skipped (no relational evaluator)', node.id);
    return node;
}
```

#### 4. `pass.ts` and `optimizer.ts` — wire the relational evaluator

In `createConstantFoldingPass()` and `optimizer.performConstantFolding()`, create both evaluators and pass them:

```typescript
const scalarEvaluator = createRuntimeExpressionEvaluator(context.db);
const relationalEvaluator = createRuntimeRelationalEvaluator(context.db);
const result = performConstantFolding(plan, scalarEvaluator, relationalEvaluator);
```

#### 5. Docs

- `docs/optimizer-const.md` section 5: Replace "In the future..." with implementation details (deferred materialization, attribute preservation)
- `docs/optimizer-const.md` section 9: Mark item 1 complete
- `docs/optimizer.md` Known Issues: Remove "Relational Folding Pending" bullet

## What gets folded

Relational subtrees classified as `const` by the existing three-phase algorithm:
- `VALUES` clauses with all-literal cells (all children are LiteralNodes → const)
- `SELECT <const-exprs> FROM (SELECT <const-exprs>)` — nested constant projections over SingleRow
- Uncorrelated subqueries that reference no tables (e.g., `SELECT 1+2, 'hello'`)
- Any functional relational node whose entire child subtree is const

What does NOT get folded:
- Anything referencing actual tables (`Retrieve` nodes are non-const due to table access)
- Non-deterministic expressions (`random()`, `datetime('now')`) — marked non-functional
- Mutating operations — marked `readonly: false`

## Key tests

- `SELECT * FROM (VALUES (1,'a'),(2,'b')) AS t(id,name)` → plan shows `TableLiteral` instead of `Values`, correct results
- `SELECT * FROM (SELECT 1+2 AS x, 'hello' AS y)` → folded to `TableLiteral`
- `SELECT * FROM t1` → NOT folded (table reference)
- `SELECT random() AS r` → NOT folded (non-deterministic)
- Attribute IDs preserved after folding (parent ColumnReference nodes still resolve)
- Prepared statement re-execution returns same results (cached materialization)
- Nested constant CTEs: `WITH t AS (SELECT 1 AS x) SELECT * FROM t` → CTE body folded if CTE itself is inlined

----

## TODO

### Phase 1: Core infrastructure
- Add `predefinedAttributes` support to `TableLiteralNode` constructor
- Implement `MaterializingAsyncIterable` utility (self-caching async iterable)
- Implement `createRuntimeRelationalEvaluator` in `const-evaluator.ts`

### Phase 2: Integration
- Update `ConstFoldingContext` with `evaluateRelation` field
- Update `performConstantFolding` to accept and pass relational evaluator
- Update `replaceBorderNodes` to handle relational border nodes (replace TODO block)
- Wire evaluator in `createConstantFoldingPass` (pass.ts) and `optimizer.performConstantFolding` (optimizer.ts)

### Phase 3: Tests
- Add sqllogic tests for relational constant folding (VALUES, constant subqueries)
- Add golden plan test showing TableLiteral replacement
- Add test for attribute ID stability after relational folding
- Test prepared statement re-execution with folded relational nodes
- Verify non-foldable cases remain unchanged

### Phase 4: Docs
- Update `docs/optimizer-const.md` sections 5 and 9
- Update `docs/optimizer.md` Known Issues section
