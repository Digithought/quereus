# Quereus Optimizer

## optimization families for Titan-era optimiser

Each bullet explains ❶ the intent, ❷ the concrete transformation(s) we'll perform on the PlanNode tree, and ❸ why it helps the "virtual-table-centric, cursor-sipping" philosophy.

1. Predicate (restriction) push-down  
   * Move Filter / WHERE / JOIN-ON predicates as close to base scans or table-function calls as possible.  
   * Drive VTab.xBestIndex with richer constraint metadata (already scaffolded by FilterInfo/IndexInfo).  
   * For residual predicates, still push them below projections / window nodes when safe to reduce row counts early.  
   * Extension idea: allow VTab modules to declare "derived constraints" they can honour (e.g., `date BETWEEN...` becomes two range constraints).

2. Constant & literal folding  
   * Pure scalar sub-trees → LiteralNode.  
   * Expression simplification using SQL identities (`x AND 1 → x`, `substr('abc',1,1) → 'a'`).  
   * Fold deterministic scalars inside ValuesNode, TableFunctionCallNode arguments, and even Filter predicates (turning them into TRUE/FALSE and enabling predicate elimination).  
   * Cheap, improves both planning cost estimates and execution.
   * Fold constant tables into values nodes (future)

3. Projection (column) pruning  
   * Re-walk tree marking columns actually referenced by ancestors; trim Attribute / RowDescriptor maps and insert ProjectNodes where it allows earlier discarding of unused columns.  
   * Especially effective before VTab scans that support "column mask" optimization.

4. Join order / algorithm selection  
   * Start with current greedy NLJ cost model, but enrich with:  
     – Row cardinality propagation from predicate push-down.  
     – Index lookup cost vs full scan cost.  
     – Awareness of LEFT / RIGHT OUTER semantics.  
   * Later phases: introduce HashJoin & MergeJoin physical conversions when ordering / hashability make them cheaper.

5. Smart materialisation & caching ("deterministic boundaries")  
   * Heuristic: when a relational subtree is  ❰deterministic, pure, small or referenced >1 time❱ insert CacheNode.  
   * Use estimatedRows + tuning thresholds to decide in-memory vs pass-through.  
   * For recursive CTEs and nested-loop inner sides we already have optimization hooks; generalise those rules.

6. Streamability / pipelining preservation  
   * Prefer operators that don't block (WindowNode, SortNode, DistinctNode can all be blocking).  
   * Convert logical Aggregate→StreamAggregate only when upstream ordering can be guaranteed; otherwise fall back to HashAggregate.  
   * Re-order DISTINCT, LIMIT/OFFSET, ORDER BY when safe to keep pipelines open.

7. Derived-table & view "inlining"  
   * Flatten simple SELECT-views and non-materialised CTEs so restrictions/project-pruning can see through them.  
   * For complex or reusable CTEs fall back to caching rule above.

8. Subquery rewrites  
   * EXISTS/IN → semi-join or anti-join when correlated predicates allow.  
   * Scalar subquery that is provably single-row → turn into SingleRowNode join or even constant if independent of outer scope.

9. Bag/Set semantics optimization  
   * Use RelationType.isSet to drop DISTINCT, deduplicate hash structures, and choose cheaper join algorithms.  
   * Insert SequencingNode only when really needed (e.g., window ROW_NUMBER without PARTITION).

10. Affinity-aware comparison simplification  
    * If both operands are numeric constants we can fold comparisons; if types prove inequality, replace predicate with constant FALSE-literal, enabling dead-branch elimination.

11. Dead-branch / empty-relation elimination  
    * After constant folding: Filter(FALSE) → Values(0 rows); Join where one side is empty reduces to empty quickly; will cascade pruning of later nodes.

12. Physical property exploitation  
    * Propagate ordering/uniqueness/row-count properties through nodes; allow optimizations like:  
      – Skip Sort if upstream ordering already satisfies ORDER BY.  
      – Remove Duplicate Distinct if unique key known.  
      – Push LIMIT into VTab if xBestIndex advertises ORDER BY consumed.

13. Cost-based opportunistic parallelism (future)  
    * Mark sub-trees with `physical.parallelisable=true`; Scheduler can run them concurrently when they have no data dependence (e.g., UNION branches).

14. Adaptive re-optimization hooks (future)  
    * If runtime row counts deviate wildly from estimates, allow feedback loop: PlanNode tree annotated with actual rows fed back into optimiser for next statement execution.

## Groundwork

────────────────────────────────────────
1. Planner layer
────────────────────────────────────────
1.1  Rich logical metadata  
     * Finish plumbing estimatedRows / estimatedCost through *all* builder nodes.  
     * Extract predicate metadata (`FilterPredicate` objects) during build phase instead of optimiser phase; this avoids re-parsing expressions later.  

1.2  Constraint extraction helpers  
     * A pure function `extractConstraints(expr) → VTabConstraint[]` that turns a ScalarPlanNode tree into xBestIndex-style constraints (column, op, constant).  
     * Provide reverse: `residualFilter(constraints) → ScalarPlanNode` to rebuild the leftover predicate.  

1.3  Expression constant-folding utility  
     * Stand-alone util that can evaluate deterministic ScalarPlanNode sub-trees given a simple "literal env"; used by builder, optimiser *and* runtime peephole.  

1.4  Physical-property skeleton  
     * Add default `physical: PhysicalProperties` on *all* nodes at build time (`ordering: undefined, uniqueKeys: [], deterministic: true,…`).  
     * This guarantees optimiser rules can safely read/augment properties instead of repeatedly checking for existence.

────────────────────────────────────────
2. Optimiser core ("Titan Optimiser v1")
────────────────────────────────────────
2.1  Rule registration & trace framework  
     * Simple decorator/helper `registerRule(type, name, fn)` that auto-logs "Rule X replaced AggregateNode#42 with StreamAggregateNode#87".  
     * Guard against loops by keeping a Set<originalId, ruleName>.  

2.2  Physical-property propagation utilities  
     * `inferOrdering(childProps, requestedKeys)` – central place for ORDER BY reasoning.  
     * `combineUniqueKeys(leftKeys, rightKeys, joinType)` – used by joins & projections.  

2.3  Statistics interface  
     * `StatsProvider` abstraction (`getRowCount(tableSchema, where?)`) so we can swap in:  
       – naive heuristics (current),  
       – VTab-supplied stats,  
       – future ANALYZE table.  
     * Cost model helpers (`seqScanCost(rows)`, `indexSeekCost(rows)`, …) to keep formulas out of rules.  

2.4  "Materialisation advisory" utility  
     * Given a sub-tree, decide cache strategy (none / stream / spill) based on: deterministic, estimatedRows, referencedCount (needs ref graph).  

2.5  Plan validator pass  
     * Ensures every node is physical + every ColumnReferenceNode's attributeId exists in some ancestor rowDescriptor.  Fails fast before emission.

────────────────────────────────────────
3. Runtime / Emitter layer
────────────────────────────────────────
3.1  Emitter registry keyed by PlanNodeType (already have) but expose `requiresOrdering`, `preservesOrdering` flags so optimiser can query.  

3.2  Shared "mini-executors"  
     * Row cache helper used by CacheNode, NestedLoop inner caching, and CTE materialisation – avoids 3 different cache implementations.  

3.3  Async-stream helpers  
     * `filterAsyncIterable(iter, pred)`, `mapRow(iter, fn)` in runtime/util to keep emitters tiny and readable.  

3.4  Execution metrics hook  
     * Lightweight counters (#rowsIn/#rowsOut per instruction) behind `QUEREUS_RUNTIME_STATS` env.  Optimiser devs can verify cardinality assumptions.

────────────────────────────────────────
4. Tooling, diagnostics, best practices
────────────────────────────────────────
4.1  Golden-plan tests  
     * Add `test/plan/` fixtures: SQL → expected PlanNode JSON (logical) and expected Physical JSON after optimise().  
     * CI diff tells us when a rule unexpectedly fires / stops firing.  

4.2  "PlanViz" CLI  
     * Node script that dumps colourised tree or emits Mermaid for quick visual sanity.  

4.3  Lint-style rule for optimiser  
     * eslint plugin (or simple script) flags direct `new SomePhysicalNode` calls outside optimiser-rules folder—discourages folks from injecting physical nodes in builder code.  

4.4  Coding conventions  
     * Each rule file ≤200 LoC, single responsibility, returns undefined if not applicable.  
     * Never mutate incoming PlanNodes; always create new instances (already true but document explicitly).  
     * Unit test every rule with at least one positive and one "no-op" case.  

4.5  Debug namespaces  
     * `quereus:optimizer:rule:*` for per-rule logs,  
       `quereus:optimizer:stats` for cardinality/cost dumps.  Encourage devs to grep logs instead of `console.log`.

────────────────────────────────────────
Road-map sequencing
────────────────────────────────────────
Phase 0 (groundwork)  → 1.1, 1.2, 3.2, 4.4  
Phase 1 (core)        → 2.1 – 2.3, 3.1, 4.1  
Phase 2 (cache & stats)→ 2.4, 3.3, 4.2  
Phase 3 (polish)      → 1.3, 1.4, 2.5, 3.4, 4.3, 4.5  

With this scaffolding in place the specific optimisation families we outlined earlier can be dropped in as small, independent rule files with high confidence that they (a) leave the plan in a valid, fully-physical state and (b) are easy to debug and reason about.

### Prerequisite - refactor xBestIndex

### Why revisit `xBestIndex` now?

1. **Type-safety & clarity** – the current `IndexInfo / FilterInfo` structs are thin wrappers around SQLite's C arrays/bit-fields.  In TypeScript we can encode intent directly in the type system and let the compiler stop whole classes of bugs.
2. **Better cost modelling** – an explicit, high-level contract lets modules express things we care about (ordering preserved, cardinality guarantees, remote-side LIMIT, etc.) without the "shoe-horn it into flags and doubles" pattern.
3. **Extensibility for future rules** – upcoming rules (predicate push-down, order-by consumption, limit push-down) will need richer feedback from VTabs.  Refactoring now prevents double-work later.

### Proposed redesign: `BestAccessPlan` API

```
interface BestAccessPlanRequest {
  columns: readonly ColumnMeta[];          // schema info
  filters: readonly PredicateConstraint[]; // extracted by planner
  requiredOrdering?: OrderingSpec;         // ORDER BY that ancestor nodes still need
  limit?: number | null;                   // LIMIT known at plan time
  estimatedRows?: number;                  // hint from planner (can be "unknown")
}

interface PredicateConstraint {
  columnIndex: number;
  op: '=' | '>' | '>=' | '<' | '<=' | 'MATCH' | 'LIKE' | 'GLOB';
  value?: SqlValue;        // value if constant
  usable: boolean;         // planner sets; module may ignore false items
}

interface BestAccessPlanResult {
  handledFilters: boolean[];   // parallel to filters[]
  residualFilter?: (row: Row)=>boolean; // optional JS filter optimiser can inject
  cost: number;                // arbitrary units
  rows: number | undefined;    // estimated rows returned
  providesOrdering?: OrderingSpec; // order guaranteed when cursor yields
  uniqueRows?: boolean;        // true if at most one row per PK (helps DISTINCT)
  explains?: string;           // free-text for debugging
}
```

*All numbers get explicit units:*  
– `cost` in "virtual CPU units" (not milliseconds);  
– `rows` as **integer** not bigint;  
– provide clear guidance that `rows` may be `undefined` if unknown.

Convenience helpers:

```
class AccessPlanBuilder {
  // static methods: .fullScan(), .eqMatch(), .rangeScan()…
}

function validateAccessPlan(req:BestAccessPlanRequest,
                            res:BestAccessPlanResult): void;
```

### Migration steps

Quereus is a new system, with no users.  We don't need to keep any of the old structures around.

1. Adapt existing modules to the new interface.
2. **Planner changes**
   • `extractConstraints()` now produces `PredicateConstraint[]`.  
   • When calling into the module, supply `requiredOrdering` and `limit` fields.  
   • Update `FilterInfo` struct or retire it in favour of the new request object.

3. **Runtime/emitter changes**  
   • Emitters already use `filterInfo`; refactor them to expect the richer `BestAccessPlanResult`.  
   • Residual predicates can be emitted as an extra `FilterNode` when `result.residualFilter` exists.

4. **Module author ergonomics**  
   • Add a tiny `@quereus/vtab-test` package: give it a set of `BestAccessPlanRequest` fixtures and assert the returned plan.  
   • Provide `createLogger('vtab:<moduleName>:bestindex')` scaffold so authors can turn on DEBUG quickly.

5. **Documentation & examples**  
   • Build a docs/modules.md document including a "Design virtual tables with Quereus" section that walks through building a `MemoryTable`, highlights common mistakes (e.g. forgetting `rows` estimate makes optimizer assume worst-case), and shows unit-test usage.

### Impact on optimisation roadmap

*Positive effects*  
• **Predicate push-down** gains binary information ("handledFilters") that lets it *delete* FilterNodes instead of conservatively retaining them.  
• **ORDER-BY elimination** can rely on `providesOrdering` instead of the current "orderByConsumed + careful NLJ tracking" hack.  
• **Join planning** benefits from `uniqueRows` (helps choose hash-join vs loop).  
• **Caching rule**: knowing `uniqueRows=true` + `rows` small means we can confidently skip caching.

*Required adjustments*  
• Update optimiser rule helpers (`inferOrdering`, `combineUniqueKeys`) to read from `BestAccessPlanResult`.  
• Retune default cost functions once real modules start returning richer numbers.  
• Rewrite tests/fixtures that assert old `idxStr`, `idxNum` fields.

### Best-practice guard-rails

1. **Schema-bound helper**  
   ```
   class VTabHelper {
     constructor(public readonly table: TableSchema) { … }
     // validateColumnIndex(), assertAllFiltersHandled()…
   }
   ```
2. **Lint rule** – forbids returning `cost=0` or omitting `handledFilters`, common mistakes in early modules.
3. **Debug assert** – during development builds, the adapter runs `validateAccessPlan()` and throws if obvious contracts are violated.

### Conclusion

Refactoring `xBestIndex` into a typed, intention-revealing `BestAccessPlan` contract will:

• make virtual-table authors productive and less error-prone,  
• feed substantially better metadata to the new optimiser,  
• and remove C-era "flag incantations" before they harden into technical debt.

Note that this will affect some of the below phases, so adjust accordingly.

### Phase 0 – Groundwork ✅ COMPLETED

("Lay the rails before driving the train")

Phase 0 provides the foundational infrastructure for the Titan optimizer, ensuring all plan nodes have consistent metadata and physical properties.

====================================================================
A. Planner metadata refresh ✅ COMPLETED
====================================================================
Goal: Every PlanNode exposes usable cost/row metadata and default PhysicalProperties

**Implemented:**
- ✅ `src/planner/stats/basic-estimates.ts` - Row estimation heuristics and utilities
- ✅ `src/planner/cost/index.ts` - Cost model helpers with consistent formulas  
- ✅ `DEFAULT_PHYSICAL` constant for consistent physical property defaults
- ✅ `PlanNode.setDefaultPhysical()` helper for setting physical properties
- ✅ Enhanced `markPhysical()` in optimizer to use new infrastructure

**Key Features:**
- `BasicRowEstimator` class with operation-specific heuristics
- Comprehensive cost functions for all major operations
- Consistent physical property initialization across all nodes

====================================================================
B. Constraint-extraction utilities ✅ COMPLETED
====================================================================
Purpose: Drive VTab.xBestIndex and enable residual predicate pruning

**Implemented:**
- ✅ `src/planner/analysis/constraint-extractor.ts` - Predicate constraint analysis
- ✅ `PredicateConstraint` interface for VTab-compatible constraints
- ✅ `extractConstraints()` function for converting expressions to constraints
- ✅ Column mapping utilities for attribute ID to column index translation

**Key Features:**
- Handles binary comparison patterns (column op constant)
- Supports constraint flipping for reversed operands
- Provides residual predicate building for unmatched expressions
- Extensible framework for additional constraint types

====================================================================
C. Shared row-cache mini-executor ✅ COMPLETED  
====================================================================
Purpose: Unified caching primitive for CacheNode, NLJ-inner caching, and materialized CTEs

**Implemented:**
- ✅ `src/runtime/cache/shared-cache.ts` - Extracted from proven existing cache emitter
- ✅ Enhanced existing `emit/cache.ts` to use shared utilities
- ✅ Avoided code duplication by consolidating around working implementation
- ✅ Memory and spill strategies (spill framework ready for implementation)

**Key Features:**
- Based on proven streaming-first pattern from existing CacheNode
- Auto-bail when memory limits exceeded with threshold management
- Re-consumable cached iterables with state tracking
- Deep copying to prevent mutations
- Comprehensive logging and metrics for debugging

**Design Decision:**
Consolidated around the existing working cache emitter rather than creating redundant implementations. The existing closure-based approach was already optimal for the streaming-first philosophy.

====================================================================
D. Coding conventions & rule skeletons ✅ COMPLETED
====================================================================
Purpose: Establish consistent patterns for optimizer rule development

**Implemented:**
- ✅ `docs/optimizer-conventions.md` - Comprehensive rule development guide
- ✅ `src/planner/rules/README.md` - Directory structure and organization
- ✅ Rule template with proper guard clauses and attribute preservation
- ✅ Testing requirements and patterns
- ✅ Performance guidelines and anti-patterns

**Key Features:**
- Standardized rule signature: `(node: PlanNode, optimizer: Optimizer) => PlanNode | null`
- Mandatory attribute ID preservation
- Consistent logging patterns
- Required unit test coverage
- Directory structure by optimization area

====================================================================
Phase 0 Results
====================================================================
✅ **Infrastructure Ready**: All foundational components implemented
✅ **Consistent Metadata**: Every node has reliable cost/row estimates  
✅ **Physical Properties**: Default properties set on all nodes
✅ **Constraint Analysis**: Framework ready for predicate pushdown
✅ **Caching Infrastructure**: Shared cache ready for multiple use cases
✅ **Development Standards**: Clear conventions for rule development

**Next Steps**: Ready to proceed with xBestIndex refactor and Phase 1 optimization rules.

### Phase 1 – Core Optimization Families

Phase 1 goal Make the "Titan optimiser loop" production-ready so that new optimisation rules can be added quickly and safely.  
Scope Only internal plumbing—no new optimization logic yet.

────────────────────────────────────────
1 Rule registration & trace framework
────────────────────────────────────────
Target files  
• `src/optimizer/framework/registry.ts` – central rule registry  
• `src/optimizer/framework/trace.ts`    – debug helpers  
• `src/optimizer/framework/context.ts`  – wraps Optimizer + StatsProvider

API sketch

```ts
// registry.ts
export type RuleFn = (node: PlanNode, ctx: OptContext) => PlanNode | undefined;

export interface RuleHandle {
  id: string;                 // "Aggregate→StreamAggregate"
  nodeType: PlanNodeType;
  phase: 'rewrite' | 'impl';  // rewrite = logical  ⇢ logical/phys
  fn: RuleFn;
}

export function registerRule(handle: RuleHandle): void
export function rulesFor(nodeType: PlanNodeType): readonly RuleHandle[];
```

```ts
// trace.ts
export interface TraceHook {
  onRuleStart?(h: RuleHandle, n: PlanNode): void;
  onRuleEnd?  (h: RuleHandle, before: PlanNode, after: PlanNode | undefined): void;
}

export function setTraceHook(h: TraceHook): void;
```

Optimizer changes  
• Replace the current `Map<PlanNodeType, RuleFn[]>` with `registry.rulesFor()` look-ups.  
• Maintain a `visited` set of `(nodeId, ruleId)` to avoid infinite rule loops; log "skipped (already applied)".  
• Trace hooks emit DEBUG logs under `quereus:optimizer:rule:<ruleId>`.

Usage example

```ts
registerRule({
  id: 'Aggregate→StreamAggregate',
  nodeType: PlanNodeType.Aggregate,
  phase: 'impl',
  fn: aggRuleFunc,
});
```

1.5 Introduce seek & range scan

Introducing an explicit "seek / range-scan" access node; this is the **vehicle** that lets several of the families (predicate push-down, join-order costing, cache decisions) reason about "cheap, indexed access" vs "expensive full scan".  

Changes needed:

1. Planner output  
   • Keep the builder simple: still produce a single logical `TableAccessNode` (rename the current `TableScanNode` to `TableAccessNode`, mark it *logical*).  
   • Attach the raw `FilterInfo` and `ORDER BY` requirements gathered during build.  No index decision yet.

2. New physical access nodes  
   We already reserved enum tags in `PlanNodeType`.  We now add real nodes + emitters:  
   • `SeqScanNode` – trivial wrapper around current scan emitter; used when no usable index exists.  
   • `IndexScanNode` – streaming range scan when `xBestIndex` says "this index satisfies ORDER BY".  
   • `IndexSeekNode` – point lookup or tight range (LOW/HIGH keys supplied).  Think "rowid/PK seek"; yields ≤ few rows.  
   → All three share a base class `PhysicalTableAccessNode` so emitters get common helpers (row-descriptor building, column mask handling).

3. Optimiser rule  
   `ruleSelectAccessPath(TableAccessNode)`  
   1. Call VTab.xBestIndex with extracted constraints + order info.  
   2. Decide which physical node fits (`SeqScan`, `IndexScan`, `IndexSeek`).  
   3. Attach `physical.estimatedRows / cost / ordering` from the chosen path.  
   4. Return the new physical node; if nothing better, just wrap into `SeqScanNode`.

4. Cost model helpers (in the "statistics" utilities we listed)  
   • `seqScanCost(rows)`  ≈ c * rows  
   • `indexSeekCost(rows)` ≈ small constant + rowsTouched  
   • `indexScanCost(rows)` ≈ rowsTouched * (log_fanout?)  
   Having these lets join-order and caching rules reason about "outerRows × innerSeekCost".

5. Predicate push-down tie-in  
   The same rule that extracts constraints for xBestIndex also rewrites the residual predicate (if any) and leaves a `FilterNode` above the physical scan when needed.

6. Runtime emitter work  
   • `emitSeqScan` is basically today's scan emitter.  
   • `emitIndexSeek` gets `lowKey`, `highKey`, `seekMode` from `IndexSeekNode`.  
   • `emitIndexScan` passes the chosen index + orderByConsumed flag.  
   • All three must honour the column-mask optimisation when VTabs expose it.

7. Validation / tooling  
   • Extend the plan-validator: every `TableAccessNode` must be rewritten to *one* of the three physical access nodes before emission.  
   • Add golden-plan tests to guard against regressions (e.g. WHERE  pk = ? must yield `IndexSeekNode`).


────────────────────────────────────────
2 Physical-property utilities
────────────────────────────────────────
New file `src/optimizer/physical-utils.ts`

Functions (all pure):

1. `mergeOrderings(parent: Ordering[], child: Ordering[] | undefined): Ordering[] | undefined`
2. `combineUniqueKeys(left: number[][], right: number[][], joinType: JoinType): number[][]`
3. `propagateConstantFlag(children: PhysicalProperties[]): boolean`
4. `estimateResultRows(op: 'filter'|'aggregate'|'join', params…): number`

These concentrate bookkeeping logic that today lives inside many rule functions.

────────────────────────────────────────
3 Statistics provider abstraction
────────────────────────────────────────
Files  
• `src/optimizer/stats/index.ts`  
• `src/optimizer/stats/naive.ts`

```ts
export interface StatsProvider {
  /** Base table cardinality */
  tableRows(table: TableSchema): number | undefined;
  /** Selectivity estimation for predicate attached to table */
  selectivity(table: TableSchema, pred: ScalarPlanNode): number | undefined;
}

export const defaultStats = new NaiveStats(); // heuristics only
```

Optimizer receives `OptContext` containing `stats: StatsProvider` and `tuning: OptimizerTuning`.

Implementation for NaiveStats  
– returns `table.estimatedRows ?? tuning.defaultRowEstimate`  
– selectivity: constant 0.1 for equality predicate, 0.3 otherwise.

Later we can add a `HistogramStats` that reads ANALYZE data or delegates to virtual tables.

────────────────────────────────────────
4 Emitter registry meta-data
────────────────────────────────────────
Problem Optimiser needs to ask "does node X preserve ordering?" without instantiating the Instruction.

Solution  
• Introduce `EmitterMeta`:

```ts
export interface EmitterMeta {
  preservesOrdering?: boolean;
  requiresOrdering?: number[]; // column indexes
  note?: string;
}

registerEmitter(
  PlanNodeType.StreamAggregate,
  emitStreamAggregate,
  { preservesOrdering: false }
);
```

File changes  
`src/runtime/emitters.ts` → keep a parallel `metaMap`.  
Optimizer fetches meta via `getEmitterMeta(nodeType)` when doing physical-property inference.

────────────────────────────────────────
5 Golden-plan test harness
────────────────────────────────────────
Directory `test/plan/`

• Fixture format:  
  – `.sql` file with input query  
  – `.logical.json` reference (output of build phase)  
  – `.physical.json` reference (after optimise())

Script `npm run build-plans`  
1. reads each `.sql`, runs planner+optimiser, serialises with existing `serializePlanTree()`, writes/updates the JSON.  
2. commits JSON to repo; CI uses mocha test to compare current plan vs checked-in file.

Assertion tolerance  
• Ignore generated node `id` fields.  
• Sort properties to avoid diff noise.

Add ENV `UPDATE_PLANS=true` to overwrite golden files (like Jest snapshots).

With Phase 1 in place, adding or refactoring optimisation rules becomes a matter of dropping a file into `optimizer/rules/`, writing two snapshot tests, and verifying the DEBUG trace, setting us up for the richer optimisation families in later phases.

## Phase 2 – Cache & Statistics ✅ COMPLETED

Phase 2 – "Cache & Visualise"  
(Prereqs: richer physical props, StatisticsAPI, rule registry, basic optimiser passes & emitter metadata already in place)

────────────────────────────────────────
A.  Materialisation-Advisory Framework
────────────────────────────────────────
Goal Auto-decide when/where to inject CacheNode (or spill-cache) so the inner side of repeated scans and expensive pure sub-trees is read only once.

A.1  Reference-Graph builder  
 • Walk final logical tree, build `Map<PlanNode, RefStats>` where  
  RefStats = { parentCount, appearsInLoop?, estimatedRows, deterministic }.  
 • `appearsInLoop` flagged if node sits on inner side of NestedLoop OR right side of OUTER query in correlated subquery.  
 • Re-uses each node's existing `physical.deterministic` & `estimatedRows`.

A.2  Advisory algorithm  
```
function adviseCaching(node: PlanNode, stats: RefStats, tun: OptimizerTuning): boolean {
  if (!node.deterministic) return false;
  if (stats.parentCount <= 1 && !stats.appearsInLoop) return false;

  const rows = stats.estimatedRows ?? tun.defaultRowEstimate;
  const cheap = rows < tun.join.maxRightRowsForCaching;
  return cheap || stats.appearsInLoop;
}
```
 • Result true ⇒ insert `new CacheNode(node.scope,node,'memory',calcThreshold(rows))`.  
 • `calcThreshold` = `min(rows * tun.join.cacheThresholdMultiplier, tun.join.maxCacheThreshold)`.

A.3  Spill strategy  
 • extend CacheNode.strategy ∈ {memory,spill}.  
 • Pick spill when rows > `tun.cache.spillThreshold` **and** host module reports `fs` available (browser runtime gets "memory" only).  
 • Spill implementation is just `tmpdir + JSONL`, streamed via AsyncIterable.

A.4  Rule wiring  
 • Add optimisation rule `registerRule('*', applyMaterialisationAdvisory)`.  
 • Runs last; traverses tree bottom-up injecting caches where `adviseCaching()` says "yes" and no cache already present.

A.5  Unit tests  
 1.  SELECT with same TVF used twice → exactly one CacheNode.  
 2.  COUNT(*) subquery correlated → CacheNode on inner.  
 3.  Huge table (> threshold) → no cache.  
 4.  Nondeterministic TVF → no cache.

────────────────────────────────────────
B.  Async-Stream Utilities
────────────────────────────────────────
File `src/runtime/async-util.ts`

API  
```
export function mapRows<T extends Row,R>(src: AsyncIterable<T>, fn:(row:T)=>R): AsyncIterable<R>
export function filterRows<T>(src: AsyncIterable<T>, pred:(row:T)=> MaybePromise<boolean>): AsyncIterable<T>
export function tee<T>(src: AsyncIterable<T>): [AsyncIterable<T>,AsyncIterable<T>]
export function buffered<T>(src:AsyncIterable<T>, max:number): AsyncIterable<T>
```
Implementation guidelines  
 • zero deps, pure async generators.  
 • `buffered` uses ring-buffer; yields rows eagerly, back-pressures when max reached (for CacheNode).  
 • `tee` duplicates stream by materialising chunks internally; used by spill cache & tracing.

Emitter integration  
 • CacheNode emitter uses `buffered` to stop caching when row-limit exceeded.  
 • NestedLoopJoin inner side uses `tee` when right side already cached but also needed un-cached for SELECT list.

Tests  
 • property test that `tee` produces identical streams.  
 • memory profile for `buffered`.

────────────────────────────────────────
C.  PlanViz CLI
────────────────────────────────────────
Package `packages/tools/planviz`

C.1  Command spec  
```
quereus-planviz file.sql \
  --phase logical|physical|emitted    (default physical)
  --format tree|json|mermaid          (default tree)
  --output out.txt
```

C.2  Implementation  
 • Leverage existing `serializePlanTree()` for JSON.  
 • Tree renderer: depth-first pretty print with cost/rows/ordering badges.  
 • Mermaid: emit `graph TD; N1["SCAN users"] --> N2["FILTER age>30"]; …`.  
 • Accept piped SQL; internally `Database().prepare(sql).planTree(/*phase*/)`.  
 • Add flag `--open` that pops browser with Mermaid live view when available.

C.3  Integration with tests/CI  
 • `yarn planviz test/visual/*.sql --format mermaid` generates artifacts committed to `/docs/planviz/` so diffs show plan changes in PRs.

Risk & Mitigation  
 • Incorrect ref-graph counts → add debug flag `DEBUG=quereus:optimizer:materialise` that logs decisions.  
 • Memory bloat in buffered cache → env `QUEREUS_CACHE_MAX_MB` overrides thresholds.

====================================================================
Phase 2 Results
====================================================================
✅ **Materialisation-Advisory Framework**: Intelligent cache injection based on reference graph analysis
✅ **Async-Stream Utilities**: Comprehensive async iterable processing helpers with tee, buffering, and tracing
✅ **PlanViz CLI Tool**: Visual query plan inspection with tree, JSON, and Mermaid output formats
✅ **Enhanced Cache Integration**: CacheNode emitter enhanced with async utilities for better performance
✅ **Spill Strategy Configuration**: Tunable cache strategy selection with memory/spill thresholds

**Key Features:**
- Reference graph builder identifies nodes appearing in loops or with multiple parents
- Advisory algorithm with deterministic heuristics for cache injection decisions
- Async utilities provide zero-dependency stream processing with back-pressure and memory management
- PlanViz CLI supports multiple output formats and browser integration for Mermaid diagrams
- Enhanced cache emitter uses buffering and tracing for improved debugging and performance

**Next Steps**: Ready to proceed with Phase 3 polishing and additional optimization rule families.

## Phase 2.5 – Generic Tree Rewriting Infrastructure ✅ COMPLETED

Phase 2.5 addresses a critical architectural limitation that was causing attribute ID regressions and limiting optimizer extensibility. This phase implements a generic tree rewriting system that eliminates the need for manual node-specific handling in the optimizer core.

### Problem Statement

The original optimizer used a massive 200-line `optimizeChildren()` method with manual `instanceof` checks for each node type:

```typescript
// OLD: Manual, error-prone approach
if (node instanceof FilterNode) {
  const newSource = this.optimizeNode(node.source);
  const newPredicate = this.optimizeNode(node.predicate);
  if (newSource !== node.source || newPredicate !== node.predicate) {
    return new FilterNode(node.scope, newSource, newPredicate); // ❌ Could break attribute IDs
  }
}
// ... 40+ more cases
```

**Critical Issues:**
- **Attribute ID Breakage**: Manual node reconstruction often failed to preserve attribute IDs correctly
- **Maintenance Burden**: Adding new node types required updating the central optimizer method
- **Code Duplication**: Similar patterns repeated across many node types
- **Error Prone**: Easy to forget edge cases or mishandle attribute preservation

### Solution: Abstract `withChildren()` Method

Every `PlanNode` now implements an abstract `withChildren()` method that handles generic tree rewriting:

```typescript
abstract class PlanNode {
  abstract getChildren(): readonly PlanNode[];
  abstract withChildren(newChildren: readonly PlanNode[]): PlanNode;
}
```

### Design Principles

**1. Immutable Tree Rewriting**
- Each `withChildren()` returns a new instance only if children changed
- Returns `this` when no changes are detected (optimization)
- Never mutates existing nodes

**2. Type-Safe Reconstruction**  
- Proper type checking ensures only valid child types are accepted
- Throws descriptive errors for invalid child configurations
- Maintains node-specific invariants during reconstruction

**3. Attribute ID Preservation**
- **Critical**: All `withChildren()` implementations preserve original attribute IDs
- Enables robust column reference resolution across plan transformations
- Eliminates the regression issues that plagued manual reconstruction

**4. Generic Optimizer Core**
The optimizer's tree walk is now completely generic:

```typescript
// NEW: Generic, robust approach
private optimizeChildren(node: PlanNode): PlanNode {
  const originalChildren = node.getChildren();
  const optimizedChildren = originalChildren.map(child => this.optimizeNode(child));
  
  const childrenChanged = optimizedChildren.some((child, i) => child !== originalChildren[i]);
  if (!childrenChanged) {
    return node;
  }
  
  return node.withChildren(optimizedChildren); // ✅ Attribute IDs preserved
}
```

### Example Implementation Patterns

**Zero-ary Nodes (Leaf Nodes):**
```typescript
withChildren(newChildren: readonly PlanNode[]): PlanNode {
  if (newChildren.length !== 0) {
    quereusError(`${this.nodeType} expects 0 children, got ${newChildren.length}`, StatusCode.INTERNAL);
  }
  return this; // No children, so no change
}
```

**Unary Relational Nodes:**
```typescript
withChildren(newChildren: readonly PlanNode[]): PlanNode {
  if (newChildren.length !== 1) {
    quereusError(`${this.nodeType} expects 1 child, got ${newChildren.length}`, StatusCode.INTERNAL);
  }
  
  const [newSource] = newChildren;
  if (!('getAttributes' in newSource)) {
    quereusError(`${this.nodeType}: child must be a RelationalPlanNode`, StatusCode.INTERNAL);
  }
  
  if (newSource === this.source) return this;
  
  return new FilterNode(this.scope, newSource, this.predicate); // Preserves attribute IDs
}
```

**Complex Multi-Child Nodes:**
```typescript
withChildren(newChildren: readonly PlanNode[]): PlanNode {
  const expectedLength = 1 + this.projections.length;
  if (newChildren.length !== expectedLength) {
    quereusError(`ProjectNode expects ${expectedLength} children, got ${newChildren.length}`, StatusCode.INTERNAL);
  }
  
  const [newSource, ...newProjectionNodes] = newChildren;
  
  // Type checking and change detection...
  
  // Preserve original attribute IDs when creating new projections
  const newProjections = this.projections.map((proj, i) => ({
    node: newProjectionNodes[i] as ScalarPlanNode,
    alias: proj.alias,
    attributeId: proj.attributeId // ✅ Preserve original attribute ID
  }));
  
  return new ProjectNode(this.scope, newSource, newProjections);
}
```

### `getChildren()` Consistency

All nodes now consistently implement `getChildren()` to return ALL children (both relational and scalar) in a predictable order:

```typescript
// ProjectNode example
getChildren(): readonly PlanNode[] {
  return [this.source, ...this.projections.map(p => p.node)];
}

// FilterNode example  
getChildren(): readonly [RelationalPlanNode, ScalarPlanNode] {
  return [this.source, this.predicate];
}
```

## Remaining Development Areas

While the core Titan optimizer architecture is complete with Phases 0-3 implemented, several areas remain for future development:

### Advanced Optimization Rules
- **Predicate Pushdown**: Push filter predicates closer to data sources
- **Join Reordering**: Cost-based join order optimization using cardinality estimates  
- **Subquery Optimization**: Transform correlated subqueries to joins where beneficial
- **Aggregate Pushdown**: Push aggregations below joins when semantically valid

### Access Path Infrastructure  
- **Physical Access Nodes**: `SeqScanNode`, `IndexScanNode`, `IndexSeekNode` for optimal data access
- **Access Path Selection**: Cost-based selection between scan strategies based on VTab capabilities
- **Index Utilization**: Enhanced integration with VTab `getBestAccessPlan` for index optimization

### Performance & Tooling
- **Plan Validation**: Runtime tree validation to catch optimizer bugs early
- **Execution Metrics**: Row-level telemetry for verifying cardinality estimates  
- **ESLint Rules**: Prevent physical nodes in builder code, enforce conventions
- **Enhanced Debugging**: Standardized debug namespaces and logging patterns

### Statistics & Costing
- **Advanced Statistics**: Move beyond naive heuristics to VTab-supplied or ANALYZE-based stats
- **Sophisticated Cost Models**: Better formulas for complex operations and join algorithms
- **Adaptive Optimization**: Runtime feedback loops for cost model refinement

## Guiding principles

Here is the "constitution" we have been following internally when adding Titan-era planner/optimiser code.  Keep it handy—when a patch feels awkward it usually violates one of these paragraphs.

────────────────────────────────────────
A.  Architectural invariants
────────────────────────────────────────
1.  Immutability of PlanNodes  
    • A PlanNode is *never* mutated once constructed.  
    • Every rule that wants a change returns a brand-new node (or subtree) and re-threads it upward.  
    • Corollary: do not keep external references to nodes between optimiser passes.

2.  Stable Attribute IDs  
    • Column identity == `attributeId`, not name, not position, not node reference.  
    • Any rule that rewrites projections *must* copy the original IDs (or document why it legitimately generates new ones).  
    • Emitters rely on this; breaking it causes "column not found" at runtime.

3.  Logical vs Physical separation  
    • Nodes can be both logical and physical, but not all nodes are physical.
    • Optimiser must finish with a tree where every relational node has `physical` set and has a registered emitter.

4.  Single-purpose rules  
    • One `.ts` file = one clear "If X then rewrite to Y" responsibility.  
    • Rule returns `undefined` for "not applicable", never a partially mutated node.

5.  No hidden side-effects  
    • Rule functions are pure: (node, optimiser) → newNode | undefined.  
    • All statistics, cost models, caches are passed in via optimiser context; nothing reads globals.

────────────────────────────────────────
B.  Coding style & expressiveness
────────────────────────────────────────
1.  "Expressive > imperative" (echoing the workspace rule)  
    • Prefer short helpers (`const sortCost = n * log2(n)`) over inline maths in five places.  
    • Break complex transforms into smaller functions; the optimiser orchestrates, helpers do the math.

2.  Centralised utilities only  
    • Type coercion → `util/coercion.ts`  
    • Constant folding → `util/expr-fold.ts`  
    • Cost formulas / stats lookup → `optimizer/cost-utils.ts`  
    • Never embed bespoke logic in a rule file; if you need it twice, extract it.

3.  Guardrails by types  
    • All PlanNode subclasses must implement the correct interface explicitly (`implements UnaryRelationalNode`, etc.)—this catches missing overrides in TS.  
    • `PhysicalProperties` is always fully initialised before a node leaves a rule.

────────────────────────────────────────
C.  Testing & diagnostics
────────────────────────────────────────
9.  Golden-plan tests are mandatory  
    • Any new rule ships with at least one `.sql → .json` fixture verifying the rewrite.  
    • Snapshots live under `test/plan/`.  If a later change updates the snapshot, you must explain **why** in the PR.

10.  Logging namespace discipline  
    • `quereus:optimizer:rule:<ruleName>` inside each rule, nothing else.  
    • Don't `console.log`; use the debug helper so users keep control of verbosity.

11.  Plan validation after every phase  
    • The `validatePlan()` pass (cheap DFS) checks:  
      – every ColumnReferenceNode resolves to an Attribute present upstream,  
      – no logical node remains,  
      – physical properties are populated.  
    • CI fails fast if validation fails.

────────────────────────────────────────
D.  Performance & maintainability
────────────────────────────────────────
12.  "Pay-as-you-go" complexity  
    • Start with simple heuristics; only add stats-heavy or combinatorial algorithms when a benchmark proves the need.  
    • Keep cost model formulas readable—arithmetical expressions, not half pages of algebra.

13.  Stream-first mindset  
    • Always ask: "does this transform increase blocking, buffering or duplicate scans?"  
    • Prefer streaming/online variants; fallback to caching/materialisation only via the dedicated rule.

14.  Reuse before invention  
    • CacheNode, RowDescriptor creation helpers, etc., exist—use them.  
    • If a rule needs "mini materialisation" it should call the shared cache helper, not hand-roll a new one.

15.  Future-proof signatures  
    • Export *interfaces* not classes from helper modules so we can swap implementations (e.g., new stats engine) without ripples.

────────────────────────────────────────
E.  Human factors
────────────────────────────────────────
16.  Self-describing code beats comments  
    • Use descriptive variable/function names; keep comments for *why*, not *what* (rule already enforced by workspace guidelines).

17.  All public helper functions carry JSDoc with intent & pre-/post-conditions.

18.  Review checklist includes:  
    • Does the patch follow points 1-11?  
    • Are cost/row estimates reasonable?  
    • Does it add or update tests?  
    • If removing a rule, does another rule subsume its behaviour?

## Phase 3 – Constant Folding ✅ COMPLETED

Phase 3 implements comprehensive constant folding and expression simplification at the optimizer level, enabling better cost estimates and runtime performance by evaluating constant expressions at plan time.

### Implementation Overview

Phase 3 delivers a complete constant folding system with:

**Functional Safety System:**
- `functional` flag in `PhysicalProperties` indicating fold-safety (`pure` AND `deterministic`)
- Helper `isFunctional(node)` for checking fold eligibility
- Default logic: `functional = deterministic && readonly` if omitted

**Two-Phase Algorithm:**
1. **Bottom-up Classification** (`const-pass.ts`): DFS assigns `ConstInfo` to every node
   - `const`: Literal values that can be folded immediately
   - `dep`: Depends on specific attribute IDs (columns)
   - `non-const`: Cannot be folded (side effects, non-deterministic)

2. **Top-down Propagation**: Carries known constant attributes down the tree
   - When dependencies are satisfied, expressions are folded and attributes marked constant
   - Converges in single pass as constant set only grows

**Runtime-Based Evaluation:**
- Uses existing scheduler/emitter infrastructure for evaluation
- Handles `MaybePromise<SqlValue>` to support async subqueries
- No special interpreter needed - reuses production evaluation logic

### Key Technical Achievements

**Expression Boundary Optimization:**
- Rules target expression-producing nodes (Project, Filter, Aggregate, etc.)
- Triggers only where folding provides maximum benefit
- Avoids per-node overhead on non-expression nodes

**Generic Tree Walking:**
- Uses `getProducingExprs(): Map<number, ScalarPlanNode>` interface
- Eliminates node-type-specific knowledge from folding logic
- Extensible to new expression-producing node types

**Promise Integration:**
- `LiteralExpr.value: MaybePromise<SqlValue>` stores promises directly
- Scheduler handles awaiting when needed
- Enables folding of constant subqueries that return promises

**Database Access:**
- Optimizer receives database context for full expression evaluation
- Supports complex expressions requiring schema/function access
- Maintains clean separation between optimizer and runtime

### Architecture Benefits

**Before Phase 3:**
- Constant expressions evaluated repeatedly at runtime
- Complex dependency tracking in ad-hoc folding utilities
- Limited expression simplification capabilities

**After Phase 3:**
- Constants folded once at plan time with cached results
- Systematic dependency resolution with convergence guarantees  
- Runtime evaluation enables full SQL expression folding
- Clean integration with existing optimizer rule system

### Implementation Status

✅ **Functional Safety Infrastructure**: Complete with `isFunctional()` helper
✅ **Const-Pass Framework**: Bottom-up classification and top-down propagation
✅ **Runtime-Based Evaluator**: Uses production scheduler for evaluation
✅ **Optimizer Rule Integration**: Expression boundary targeting with rule registration
✅ **Generic Tree Rewriting**: Eliminates node-type-specific folding logic
✅ **Promise Support**: Async subquery constant folding via `MaybePromise<SqlValue>`
✅ **Database Integration**: Full expression evaluation with schema access

**Technical Reference**: See [Constant Folding Design Document](optimizer-const.md) for detailed implementation specifications.

**Next Steps**: Phase 3 provides the foundation for advanced expression optimization and enables more sophisticated cost-based optimization decisions.

## Current Implementation Status Summary

**Titan Optimizer Implementation Status:**
*   ✅ **Phase 0 - Groundwork**: Foundational infrastructure complete with cost models, constraint analysis, shared caching utilities, and development standards
*   ✅ **xBestIndex Refactor**: Modern type-safe BestAccessPlan API replacing legacy SQLite-style interfaces  
*   ✅ **Phase 1 - Core Framework**: Complete rule registration system, trace framework, physical property utilities, statistics provider abstraction, emitter metadata, and golden plan test harness
*   ✅ **Phase 2 - Cache & Visualize**: Intelligent materialization advisory, async stream utilities, and PlanViz CLI tool for visual plan inspection
*   ✅ **Phase 2.5 - Generic Tree Rewriting**: Abstract `withChildren()` method eliminating manual node handling and preserving attribute IDs
*   ✅ **Phase 3 - Constant Folding**: Functional safety flags, runtime-based evaluation, and expression boundary optimization
*   🔄 **Phase 1.5 - Access Path Selection**: Seek/range scan infrastructure and access path selection rules  
*   📋 **Upcoming**: Advanced optimization rules, join algorithms, and performance tooling

### Rule System Modernization ✅ COMPLETED

As part of Phase 3, the optimizer rule system was significantly modernized:

**Architecture Improvements:**
- **Context-Based Rules**: Rule signatures changed from `(node, optimizer)` to `(node, context)` providing richer context access
- **Framework-Managed Children**: Rules no longer manually optimize children - framework handles via `optimizeChildren()`
- **Framework-Managed Properties**: Rules no longer manually set physical properties - framework computes via `markPhysical()` + `getPhysical()`
- **Rule Elimination**: Removed redundant rules that only set properties without transformation

**Deleted Redundant Rules:**
- `ruleProjectOptimization` - No transformation needed, framework handles properties
- `ruleFilterOptimization` - No transformation needed, framework handles properties  
- `ruleSortOptimization` - No transformation needed, framework handles properties

**Enhanced Framework:**
- Generic `optimizeChildren()` uses `withChildren()` for robust tree rewriting
- Physical properties computed from children via node-specific `getPhysical()` methods
- Proper inheritance of `readonly`, `deterministic` flags from children
- Attribute ID preservation guaranteed across all transformations

**Current Rule Inventory:**
- `ruleAggregateStreaming` - Transforms `AggregateNode` → `StreamAggregateNode` + optional `SortNode`
- `ruleSelectAccessPath` - Transforms `TableScanNode` → physical access nodes
- `ruleCteOptimization` - Adds intelligent caching to CTEs
- `ruleConstantFolding` - Folds constant expressions at expression boundaries
- `ruleMaterializationAdvisory` - Global caching analysis and injection
- `ruleMarkPhysical` - Fallback for nodes needing no transformation

This modernization eliminates maintenance burden, prevents regressions, and provides a clean foundation for future optimization rules.
