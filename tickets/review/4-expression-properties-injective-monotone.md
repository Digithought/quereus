---
description: Review the new scalar expression property surface (injective + monotone/range-rewrite) on ScalarPlanNode
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/scalar.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/function.ts, packages/quereus/src/schema/function.ts, packages/quereus/src/types/logical-type.ts, packages/quereus/test/optimizer/expression-properties.spec.ts
---

## What was built

A first-class **per-attribute** scalar expression property surface on `ScalarPlanNode`, mirroring the existing `getType()` / `computePhysical()` / `getLogicalAttributes()` pattern: each scalar node answers questions about itself; composite nodes answer by recursing into children. No registry shadow; no parallel `nodeType` switch.

### New API

In `packages/quereus/src/planner/nodes/plan-node.ts`:

- `Monotonicity` type: `'increasing' | 'decreasing' | 'constant' | 'non_monotone' | 'unknown'`
- `InjectivityResult { injective: boolean; reason?: string }`
- `MonotonicityResult { monotonicity: Monotonicity; reason?: string }`
- `RangeRewrite { lowerInclusive: SqlValue; upperExclusive: SqlValue }`
- `DEFAULT_INJECTIVITY` / `DEFAULT_MONOTONICITY` constants
- Helper functions: `negateMonotonicity(m)`, `addMonotonicity(a, b)` — pure lattice operations used by composition rules
- Three concrete methods on `PlanNode` base class with conservative defaults (`isInjectiveIn`, `monotonicityIn`, `rangeRewriteIn`); declared on `ScalarPlanNode` interface so callers don't need null checks.

### Per-node implementations

- **`ColumnReferenceNode`** — injective + `'increasing'` iff `attrId === this.attributeId`; otherwise `'constant'` w.r.t. that attribute.
- **`LiteralNode`** — `'constant'` for any attribute.
- **`ParameterReferenceNode`** — `'constant'` for any attribute (parameters are fixed for the duration of a query).
- **`UnaryOpNode`**:
  - `-` on numeric child → propagates child injectivity, negates monotonicity (`increasing → decreasing`, etc.).
  - unary `+` on numeric child → pass-through.
  - `NOT`, `~`, `IS NULL`, etc. → conservative defaults.
- **`BinaryOpNode`** numeric `+` / `-` only:
  - Monotonicity: `addMonotonicity(left.mon, right.mon)` for `+`; `addMonotonicity(left.mon, negate(right.mon))` for `-`.
  - Injectivity: passes through from the dependent side when the other side is `'constant'` in `attrId`; or claims injectivity when the combined monotonicity is strictly `'increasing'`/`'decreasing'`.
  - Other operators → conservative defaults.
- **`ScalarFunctionCallNode`** — consults new per-function traits (below). For monotonicity, identifies the unique operand that depends on `attrId`, applies the function's per-arg trait, and composes with the operand's own monotonicity. For injectivity, requires the unique-dependent-operand to itself be injective in `attrId` and that arg to be in `injectiveOnArgs`. For range rewrite, defers boundary computation to the operand's `LogicalType.bucketBounds(kind, value)`.

### Function-schema traits (`packages/quereus/src/schema/function.ts`)

Added optional fields to `BaseFunctionSchema`:

- `injectiveOnArgs?: readonly number[]`
- `monotoneOnArgs?: { [argIndex]: 'increasing' | 'decreasing' }`
- `rangeRewriteOnArg?: { [argIndex]: { kind: string } }`

No built-ins are annotated yet — the surface lands first; specific function traits arrive with downstream consumer tickets (per the original plan's "consumers — separate tickets" section). `LogicalType.bucketBounds?` was added as an optional surface for type-aware boundary computation; no temporal type implements it yet (deferred until a consumer needs it).

## Why this shape

- **Per-node, parameterized by `attrId`.** Injectivity/monotonicity differ per input attribute (`f(x, y)` may be injective in `x` but not `y`), so they're methods, not properties — but they live on the node where the rest of its semantics already do.
- **Conservative defaults via base-class.** Adding the methods to `PlanNode` with safe `'unknown'` / `injective: false` returns means consumers can call `node.isInjectiveIn(id)` without null-checks, and any new scalar node automatically gets the safe answer until someone overrides it.
- **Composition over registry.** `BinaryOpNode('+')` walks `this.left` / `this.right` rather than re-implementing a node-type switch; `ScalarFunctionCallNode` reads per-function traits from `functionSchema` (the only registry-shaped piece, where the data naturally lives).

## Things to verify in review

- **Correctness of composition rules** in `BinaryOpNode.monotonicityIn` / `isInjectiveIn`. The lattice for `addMonotonicity` is in `plan-node.ts`; tests cover same-direction (sum stays monotone), opposite-direction (sum becomes unknown), and one-side-constant (passes through). Cross-check `col1 + col2` (different attrs): when querying mon-in-attr1, `col2` returns `'constant'` (it doesn't depend on attr1), so the sum is correctly `'increasing'` in attr1.
- **`ScalarFunctionCallNode.uniqueDependentOperand` semantic.** It returns an index only when *exactly one* operand has non-`'constant'` monotonicity in `attrId`. If two operands both depend on `attrId`, we return `'unknown'` — even if traits would otherwise apply to one of them. This matches the function-schema trait contract: "...when all other args are constants."
- **`rangeRewriteIn`** returns `undefined` until both a function trait *and* a `LogicalType.bucketBounds` implementation exist. It also requires `monotonicityIn(attrId) === 'increasing'` on the dependent operand — it does not yet handle `'decreasing'`-rewriting (e.g. swapping inclusive/exclusive for a decreasing function); that's a deliberate Phase-2 limitation.
- **`getLogicalAttributes` was deliberately not extended** with these properties (per the architecture note in the original ticket — they're parameterized by `attrId` and would be noisy in EXPLAIN). When a consumer rewrite uses one of these properties, the **consumer** is responsible for adding a debug field like `"matched: injective via UnaryOpNode(-)"` to the rewriting node.

## Use cases / validation

Unit tests in `packages/quereus/test/optimizer/expression-properties.spec.ts` (35 tests) cover:

- Helper-function lattice (`addMonotonicity`, `negateMonotonicity`).
- Per-node defaults: `ColumnReferenceNode` (own-attr vs other-attr), `LiteralNode`, `ParameterReferenceNode`, `UnaryOpNode` (`-`, `+`, `NOT`, `~`, `IS NULL`), and the `BinaryOpNode` numeric-arith cases.
- Compositional cases: `(col + 1) - 2`, `-(col + 1)`, double negation.
- `ScalarFunctionCallNode` trait consultation: untraited (default), `injectiveOnArgs` propagation, `monotoneOnArgs` direction composition, two-arg "other args constant" case, "all operands constant in attrId" → `'constant'` overall.
- Conservative defaults for `CastNode` and `BetweenNode`.
- `rangeRewriteIn` surface — returns `undefined` until traits + `bucketBounds` both line up.

### Manual validation

- `yarn build` (root) — full sequential build clean.
- `yarn test` (root) — full test sweep across all packages clean (2690 tests in the main quereus package, +35 new).
- `yarn run lint` (in `packages/quereus`) — clean.
- Existing tests in `optimizer/keys-propagation.spec.ts` still pass (8 tests) — confirms we didn't disturb existing key/ordering propagation, which still uses trivial-column-reference paths.

## Out of scope (for follow-up tickets)

- **Consuming** the new properties to extend key propagation through non-trivial projections (`ProjectNode` currently only honors trivial `ColumnReferenceNode` projections in `computePhysical`).
- **Consuming** the new properties for sargable predicate rewrites (e.g. `date(ts) = D` → `ts >= startOfDay(D) AND ts < startOfNextDay(D)`).
- **Annotating built-in functions** with traits (e.g. `date`/`datetime` with `rangeRewriteOnArg: { 0: { kind: 'date_bucket' } }`).
- **Implementing `LogicalType.bucketBounds`** on temporal types.
- **`ScalarFunctionCallNode.rangeRewriteIn`** does not yet handle decreasing-monotone functions or the `'decreasing'` side of monotonicity composition.
- **`*` / `/` and `||`** on `BinaryOpNode` — non-trivial sign analysis / collation considerations; defer until a consumer needs them.
