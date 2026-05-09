---
description: Add first-class scalar expression properties (injective + monotone/range-preserving) on ScalarPlanNode for use by optimizer/planner
prereq: Type system, optimizer analysis framework
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/scalar.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/function.ts, packages/quereus/src/schema/function.ts, packages/quereus/src/types/logical-type.ts
---

## Architecture

Quereus currently propagates uniqueness and ordering only through **trivial column references** (e.g. `projectUniqueKeys(...)` and `projectOrdering(...)` rely on column index mappings). This misses important cases where projections/predicates transform values while preserving key/order semantics:

- **Injective (key-preserving)** transforms: e.g. `id + 1`, `-id`, `id || ':x'` (domain-dependent)
- **Monotone / order-preserving** transforms that enable **range rewrites** for sargability: e.g. `date(ts) = d` → `ts >= d and ts < d + 1 day`

This task adds those properties **directly on `ScalarPlanNode`**, mirroring the existing `getType()` / `computePhysical()` / `getLogicalAttributes()` pattern. Each scalar node answers questions about itself; composite nodes answer by recursing into children. There is no separate registry or analysis module — that would just shadow the plan tree with a parallel `nodeType` switch and re-implement bottom-up propagation that the plan node hierarchy already gives us for free.

### Goals

- Provide a unified way to ask, of a `ScalarPlanNode` instance: "Are you **injective** in input attribute *a*?" and "What is your **monotonicity** in input attribute *a*?"
- Enable downstream optimizations (key propagation through `ProjectNode`, sargable predicate rewrites) without making rules dependent on specific function names or AST shapes.
- Keep it **safe and conservative**: defaults always say "unknown / not injective". A node only claims injective/monotone when it can prove it from local information plus its children's claims.

### Non-goals

- Full theorem-prover style reasoning over arbitrary expressions.
- Modeling probabilistic uniqueness or approximate distinctness.
- A separate `expression-properties.ts` registry — this lives on the nodes.

### Why on the node, not in a registry

The codebase's established pattern is that scalar nodes answer questions about themselves:

- `getType()` — returns the node's `ScalarType`, recursing into children where needed
- `computePhysical()` — returns the node's piece of `PhysicalProperties`, with `withPhysical()` walking children and merging
- `getLogicalAttributes()` — returns per-node logical metadata for EXPLAIN

Injectivity and monotonicity are properties of an expression node, just like its type or its determinism. Putting them anywhere else would require a parallel `switch (node.nodeType)` dispatcher in the registry, and the moment a new scalar node type is added the registry would silently default to "unknown" without the author noticing. Co-locating with the node forces the question at definition time and keeps composition local (a `BinaryOpNode` consults `this.left` / `this.right`; a `ScalarFunctionCallNode` consults `this.functionSchema` and `this.operands`).

The wrinkle these properties have over `getType()` is that they are **parameterized by an input attribute**: "is `f(x, y)` injective *in x*?" is a different question from "is it injective *in y*?". So the API is a method, not a getter.

### Proposed API on `ScalarPlanNode`

In `plan-node.ts`, add to the `ScalarPlanNode` interface (with default implementations on the abstract `PlanNode` base, or as a mixin/base helper, returning the conservative "unknown" answer):

```ts
export type Monotonicity = 'increasing' | 'decreasing' | 'constant' | 'non_monotone' | 'unknown';

export interface InjectivityResult {
	readonly injective: boolean;
	/** optional explanation for diagnostics */
	readonly reason?: string;
}

export interface MonotonicityResult {
	readonly monotonicity: Monotonicity;
	readonly reason?: string;
}

/**
 * Equivalent range on input x for an equality predicate on f(x), where f is monotone but lossy
 * (e.g. f(x) = date(x); equality on f(x) corresponds to a half-open day range on x).
 */
export interface RangeRewrite {
	readonly lowerInclusive: SqlValue;
	readonly upperExclusive: SqlValue;
}

export interface ScalarPlanNode extends PlanNode {
	readonly expression: Expression;
	getType(): ScalarType;

	/** Is this expression injective in the given input attribute? Default: { injective: false }. */
	isInjectiveIn?(inputAttrId: number): InjectivityResult;

	/** Monotonicity in the given input attribute. Default: { monotonicity: 'unknown' }. */
	monotonicityIn?(inputAttrId: number): MonotonicityResult;

	/**
	 * For monotone-but-lossy transforms only: given a constant `c` from a predicate `f(x) = c`,
	 * return the equivalent half-open range on x. Returns undefined when not applicable / unsafe.
	 * Implementations must be consistent with `monotonicityIn`.
	 */
	rangeRewriteIn?(inputAttrId: number, constant: SqlValue): RangeRewrite | undefined;
}
```

The methods are declared optional on the interface so that base `PlanNode` provides conservative defaults and node classes opt in by overriding. Helper(s) on the base class provide a single source of truth for "ask a child" recursion (so e.g. `BinaryOpNode` doesn't need to repeat null-handling).

### Per-node implementations (initial set)

- **`ColumnReferenceNode`** — injective and `'increasing'` iff `attr.id === inputAttrId`; otherwise `'constant'` w.r.t. that attribute (it doesn't depend on it).
- **`LiteralNode` / `ParameterNode`** — `'constant'` in any attribute; not injective.
- **`UnaryOpNode`**:
  - `-` on a numeric child → injective and `'decreasing'` if the child is injective/`increasing` in `inputAttrId` (compose direction).
  - `+` (unary plus), numeric → pass through child.
  - `NOT`, bitwise `~`, `IS NULL` etc. → not injective, `'unknown'`.
- **`BinaryOpNode`**:
  - `+` / `-` with one side constant (`computePhysical().constant === true` on the other operand) and a numeric type → propagate child's injectivity/monotonicity, flipping direction for `const - x` and for the right operand of `-`.
  - `*` / `/` with a constant numeric operand whose **sign is statically known nonzero** → propagate, flipping direction on negative.
  - `||` (string concat) with a constant suffix → injective, `'unknown'` monotonicity (string ordering is collation-dependent; defer until needed).
  - All other forms → not injective, `'unknown'`.
- **`CastNode`** — generally **not** injective (lossy by definition for narrowing casts). Defer claiming anything until type-aware widening rules are needed.
- **`CollateNode`** — pass through child for injectivity; monotonicity becomes `'unknown'` unless the new collation matches the child's effective collation.
- **`ScalarFunctionCallNode`** — consult `this.functionSchema` for declared traits (see below) and recurse into the relevant operand.

### Function-level traits on `FunctionSchema`

Function metadata is per-function, not per-call, so it lives on the schema (in `packages/quereus/src/schema/function.ts`). This is the only "registry-shaped" piece, and it only answers the *function part* of the question — `ScalarFunctionCallNode` still answers the *call* question by combining schema traits with operand recursion.

Extend `BaseFunctionSchema` with optional traits:

```ts
interface BaseFunctionSchema {
	// ... existing fields
	/** Argument indices on which f is injective when all other args are constants. */
	injectiveOnArgs?: readonly number[];
	/** Per-argument monotonicity when all other args are constants. */
	monotoneOnArgs?: { readonly [argIndex: number]: 'increasing' | 'decreasing' };
	/** Per-argument range rewrite kind for monotone-lossy functions. */
	rangeRewriteOnArg?: { readonly [argIndex: number]: { kind: 'date_bucket' | 'time_bucket' | string } };
}
```

Built-ins to annotate in the first pass: `abs` (not injective, not monotone), `upper`/`lower` (injective on already-cased text — defer), `+`/`-`/`*`/`/` (handled at the operator level above, not as functions), `date`/`datetime` (monotone-lossy with `date_bucket`-style range rewrite — actual bucket math is type-driven, see below).

### `LogicalType` capabilities for range rewrites

`rangeRewriteIn` needs type-aware boundary computation (e.g. for `date_bucket` on a temporal type, given a `D`, compute `[startOfDay(D), startOfNextDay(D))`). Extend `LogicalType` with an optional helper:

```ts
interface LogicalType {
	// ... existing fields
	bucketBounds?(kind: string, value: SqlValue): { lowerInclusive: SqlValue; upperExclusive: SqlValue } | undefined;
}
```

Date/datetime logical types implement `bucketBounds('date_bucket', d)` etc.; other types leave it undefined and the rewrite is simply not applied.

### Consumers (downstream — separate tickets)

- **Key/unique propagation through `ProjectNode`** (injective)
  - When a key column is projected through an injective transform, the projected column can still participate in uniqueness.

- **Predicate rewrite for sargability** (monotone + rangeRewrite)
  - Rewriting `f(col) = const` (or `between`, `<`, `>=`) into ranges on `col` when safe.

These are explicitly **out of scope for this ticket** — this ticket lands the property surface only.

### Diagnostics / explainability

`getLogicalAttributes()` already feeds EXPLAIN's JSON `properties`. Nodes that override `isInjectiveIn` / `monotonicityIn` should not dump exhaustive analysis into logical attributes (it's parameterized by attribute ID and would be noisy). Instead, downstream consumers that *use* a property to make a rewrite decision should add a debug field to the rewriting node ("matched: injective via UnaryOpNode(-)") — owned by the consumer ticket, not this one.

## TODO

### Phase 1: Planning
- [ ] Inventory current propagation points: `ProjectNode` key mapping, `physical.uniqueKeys`, `constraint-extractor.ts`, Retrieve growth rules. Confirm none of them currently look at a registry — they all consult node-local data.
- [ ] Confirm the API shape (method names, defaults) against existing optional-method conventions on `PlanNode` (e.g. `computePhysical?`).
- [ ] Decide whether to provide the conservative defaults via base-class no-op methods or by leaving the interface methods optional and having callers null-check. Recommend the former (one less thing for callers to remember).

### Phase 2: Implementation (core properties)
- [ ] Add `Monotonicity`, `InjectivityResult`, `MonotonicityResult`, `RangeRewrite` types and the three methods to `ScalarPlanNode` / `PlanNode` base in `plan-node.ts` with conservative defaults.
- [ ] Implement on:
  - [ ] `ColumnReferenceNode`
  - [ ] `LiteralNode` / `ParameterNode`
  - [ ] `UnaryOpNode` (numeric `-` and `+`)
  - [ ] `BinaryOpNode` (numeric `+`/`-` with literal/parameter constant; defer `*`/`/` and `||` until needed)
- [ ] Extend `BaseFunctionSchema` with `injectiveOnArgs` / `monotoneOnArgs` / `rangeRewriteOnArg`. Wire `ScalarFunctionCallNode` to consult them.
- [ ] (Optional, only if needed by Phase 3 tests) Extend `LogicalType` with `bucketBounds` and implement on temporal types.

### Phase 3: Tests
- [ ] Unit tests for property inference per node type (small, direct — call `isInjectiveIn`/`monotonicityIn` on hand-built nodes).
- [ ] Compositional tests: e.g. `BinaryOpNode('+', ColumnReferenceNode(x), LiteralNode(1)).isInjectiveIn(x.id)` → true, increasing; `... LiteralNode(1) - ColumnReferenceNode(x)` → injective, decreasing.
- [ ] Conservative-default tests: every other node type returns the safe answer.
- [ ] Ensure all existing optimizer/planner tests remain stable.
