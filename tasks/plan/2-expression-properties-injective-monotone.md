---
description: Add first-class scalar expression properties (injective + monotone/range-preserving) for use by optimizer/planner
dependencies: Type system, optimizer analysis framework
priority: 2
---

## Architecture

Quereus currently propagates uniqueness and ordering only through **trivial column references** (e.g. `projectUniqueKeys(...)` and `projectOrdering(...)` rely on column index mappings). This misses important cases where projections/predicates transform values while preserving key/order semantics:

- **Injective (key-preserving)** transforms: e.g. `id + 1`, `-id`, `id || ':x'` (domain-dependent)
- **Monotone / order-preserving** transforms that enable **range rewrites** for sargability: e.g. `date(ts) = d` → `ts >= d and ts < d + 1 day`

This task introduces a small, explicit “expression properties” surface area that can be queried by optimizer rules and node implementations without embedding ad-hoc knowledge throughout the codebase.

### Goals

- Provide a unified way to ask: “Is this scalar expression **injective** in a given input column?” and “Is it **monotone** (increasing/decreasing) in that column?”
- Enable downstream optimizations without making planner/optimizer dependent on specific function names or AST shapes.
- Keep it safe: properties must be *conservative* (never claim injective/monotone if unsure).

### Non-goals

- Full theorem-prover style reasoning over arbitrary expressions.
- Modeling probabilistic uniqueness or approximate distinctness.

### Proposed core types

Add a new module (suggested): `packages/quereus/src/planner/analysis/expression-properties.ts`.

```ts
export type Monotonicity = 'increasing' | 'decreasing' | 'constant' | 'unknown' | 'non_monotone';

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
 * A “range-rewrite provider” is for lossy monotone transforms (bucketization) where
 * equality/inequality predicates on f(x) can be rewritten to a range predicate on x.
 *
 * Example: f(x) = date(x). If f(x) = D then x ∈ [startOfDay(D), startOfNextDay(D)).
 */
export interface RangeRewriteProvider {
	/**
	 * Given a constant value c used in a predicate on f(x), return an equivalent range
	 * for x, if known. Returns undefined if not applicable / unsafe.
	 */
	equalityToRange(constant: unknown): { lowerInclusive: unknown; upperExclusive: unknown } | undefined;
}

export interface ScalarExpressionProperties {
	/** injective in the given input attribute? */
	isInjectiveIn?(expr: ScalarPlanNode, inputAttrId: number): InjectivityResult;
	/** monotonicity in the given input attribute? */
	monotonicityIn?(expr: ScalarPlanNode, inputAttrId: number): MonotonicityResult;
	/** optional provider for bucket/range rewrites */
	rangeRewriteIn?(expr: ScalarPlanNode, inputAttrId: number): RangeRewriteProvider | undefined;
}
```

### Property sources (where metadata comes from)

1. **Built-in operators** (in planner scalar nodes)
   - Arithmetic `+/-` with constant RHS (injective + monotone for numeric / temporal domains)
   - Unary negation (injective; monotone decreasing)
   - Explicit casts/conversion functions (domain-dependent; typically *not* injective, sometimes monotone)

2. **Function schemas**
   - Extend `FunctionSchema` with optional traits:
     - `injectiveOnArgs?: number[]` (or a predicate form)
     - `monotoneOnArgs?: Record<number, 'increasing'|'decreasing'>`
     - `rangeRewriteOnArg?: Record<number, { kind: 'date_bucket' | ... }>`
   - Extend `WindowFunctionSchema` similarly (even if only used for diagnostics initially).

3. **LogicalType capabilities**
   - For range rewrites, we need type-aware boundary computations.
   - Extend `LogicalType` with optional helpers (name TBD):
     - `bucketBounds?(value): { lowerInclusive, upperExclusive }`
     - or dedicated helpers for datetime/date bucketing used by conversion functions.

### Consumers (downstream)

- **Key/unique propagation through `ProjectNode`** (injective)
  - When a key column is projected through an injective transform, the projected column can still participate in uniqueness.

- **Predicate rewrite for sargability** (monotone + rangeRewrite)
  - Rewriting `f(col) = const` (or `between`, `<`, `>=`) into ranges on `col` when safe.

### Diagnostics / explainability

`query_plan()` already carries JSON `properties`. Add optional debug fields when a rewrite/projection happens:
- which property matched (injective/monotone)
- why it was accepted/rejected

## TODO

### Phase 1: Planning
- [ ] Inventory the current propagation points: `ProjectNode` key mapping, `physical.uniqueKeys`, predicate analysis (`constraint-extractor.ts`), Retrieve growth rules.
- [ ] Decide on the *minimal* property API surface (prefer small functions + conservative defaults).
- [ ] Decide where metadata lives (function schema vs separate registry vs per-node methods).

### Phase 2: Implementation (core properties)
- [ ] Introduce `expression-properties.ts` with conservative inference for:
  - [ ] `ColumnReferenceNode` (injective + increasing)
  - [ ] unary `-` (injective + decreasing) for numeric
  - [ ] binary `+/-` with literal/parameter constant (injective + increasing/decreasing) for numeric; defer temporal until type helpers exist
- [ ] Extend `FunctionSchema` with optional traits and wire registration for built-ins.
- [ ] (Optional) Extend `LogicalType` with bucketing/range helpers needed for datetime/date.

### Phase 3: Tests
- [ ] Unit tests for expression property inference (small, direct).
- [ ] Ensure all existing optimizer/planner tests remain stable.

