description: Reduce `any` usage and improve type safety in planner analysis/stats/scopes modules
dependencies: none
files:
  packages/quereus/src/planner/analysis/predicate-normalizer.ts
  packages/quereus/src/planner/scopes/registered.ts
  packages/quereus/src/planner/scopes/global.ts
  packages/quereus/src/planner/stats/histogram.ts
----

## 1. predicate-normalizer.ts — Remove `as any` casts

`ScalarPlanNode` (interface in `plan-node.ts:283`) extends `PlanNode` (class in `plan-node.ts:102`)
which has `public readonly scope: Scope`. `ScalarPlanNode` adds `readonly expression: Expression`.
All concrete scalar nodes (BinaryOpNode, UnaryOpNode, LiteralNode, ColumnReferenceNode, InNode,
BetweenNode) implement ScalarPlanNode and have both `.scope` and `.expression` accessible.

### Changes

**`rebuildAssociative` (line 152)**: Change `scope: any` to `scope: Scope`.
Add `import type { Scope } from '../scopes/scope.js';`.

**`tryCollapseOrToIn` (line 195)**: Change `scope: any` to `scope: Scope`.

**Lines 133-134** (generic fallback in `pushNotDown`):
```ts
// Before:
const notAst: AST.UnaryExpr = { type: 'unary', operator: 'NOT', expr: (node as any).expression };
return new UnaryOpNode((node as any).scope, notAst, normalize(node));

// After — node is ScalarPlanNode, which has both .expression and .scope:
const notAst: AST.UnaryExpr = { type: 'unary', operator: 'NOT', expr: node.expression };
return new UnaryOpNode(node.scope, notAst, normalize(node));
```

**Line 163** (in `rebuildAssociative`):
```ts
// Before:
const newAst: AST.BinaryExpr = { type: 'binary', operator: op, left: (acc as any).expression ?? baseExpr.left, right: (right as any).expression ?? baseExpr.right };

// After — acc and right are ScalarPlanNode:
const newAst: AST.BinaryExpr = { type: 'binary', operator: op, left: acc.expression ?? baseExpr.left, right: right.expression ?? baseExpr.right };
```

**Lines 232-235** (in `tryCollapseOrToIn`):
```ts
// Before:
expr: (column as any).expression,
values: values.map(v => (v as any).expression)
const inNode = new InNode((column as any).scope, ast, column, undefined, values);

// After — column is ColumnReferenceNode (ScalarPlanNode), values are LiteralNode[] (ScalarPlanNode[]):
expr: column.expression,
values: values.map(v => v.expression)
const inNode = new InNode(column.scope, ast, column, undefined, values);
```

## 2. registered.ts — Remove duplicate `subscribeFactory`

`subscribeFactory` (line 40) is identical to `registerSymbol` (line 32). Neither is on the
`Scope` interface (which only declares `resolveSymbol`). `registerSymbol` is canonical (12+ call
sites). `subscribeFactory` has 3 call sites:

- `packages/quereus/src/planner/building/constraint-builder.ts` lines 71, 74
- `packages/quereus/src/planner/building/foreign-key-builder.ts` lines 159, 284
- `packages/quereus/src/planner/building/insert.ts` lines 448, 451

### Changes

1. Remove the `subscribeFactory` method from `RegisteredScope`.
2. Replace all `subscribeFactory(` calls with `registerSymbol(` in the 3 files above.

## 3. global.ts — Extract shared scalarType helper

Lines 26-28 and 55-57 duplicate:
```ts
const scalarType: ScalarType = isScalarFunctionSchema(func)
    ? func.returnType
    : { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true };
```

### Changes

Extract a module-level helper:
```ts
function getFunctionScalarType(func: FunctionSchema): ScalarType {
    return isScalarFunctionSchema(func)
        ? func.returnType
        : { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: true, isReadOnly: true };
}
```

Import `FunctionSchema` type from `../../schema/function.js`. Replace both inline patterns with
`const scalarType = getFunctionScalarType(func);`.

## 4. histogram.ts — Type-aware distinct counting

Line 99 uses `String(sortedValues[j])` which conflates numeric `1` and string `"1"`.

### Changes

Replace:
```ts
distinct.add(String(sortedValues[j]));
```
With:
```ts
const val = sortedValues[j];
distinct.add(typeof val + ':' + String(val));
```

This produces distinct keys like `number:1` vs `string:1`.

## 5. catalog-stats.ts — Already fixed

The `eslint-disable` for `@typescript-eslint/no-explicit-any` was already removed and the
introspection helpers were fixed with typed imports in ticket `4-catalog-stats-broken-introspection`.
No further work needed.

## TODO

- Replace `as any` casts in predicate-normalizer.ts with direct property access; add `Scope` import
- Remove `subscribeFactory` from registered.ts and update 3 callers to use `registerSymbol`
- Extract `getFunctionScalarType` helper in global.ts and use in both locations
- Fix `String()` distinct counting in histogram.ts to use type-aware key
- Run lint, build, and tests to verify
