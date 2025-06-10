# Quereus Optimizer

## optimization families for Titan-era optimiser

Each bullet explains ❶ the intent, ❷ the concrete transformation(s) we’ll perform on the PlanNode tree, and ❸ why it helps the “virtual-table-centric, cursor-sipping” philosophy.

1. Predicate (restriction) push-down  
   * Move Filter / WHERE / JOIN-ON predicates as close to base scans or table-function calls as possible.  
   * Drive VTab.xBestIndex with richer constraint metadata (already scaffolded by FilterInfo/IndexInfo).  
   * For residual predicates, still push them below projections / window nodes when safe to reduce row counts early.  
   * Extension idea: allow VTab modules to declare “derived constraints” they can honour (e.g., `date BETWEEN...` becomes two range constraints).

2. Constant & literal folding  
   * Pure scalar sub-trees → LiteralNode.  
   * Expression simplification using SQL identities (`x AND 1 → x`, `substr('abc',1,1) → 'a'`).  
   * Fold deterministic scalars inside ValuesNode, TableFunctionCallNode arguments, and even Filter predicates (turning them into TRUE/FALSE and enabling predicate elimination).  
   * Cheap, improves both planning cost estimates and execution.
   * Fold constant tables into values nodes (future)

3. Projection (column) pruning  
   * Re-walk tree marking columns actually referenced by ancestors; trim Attribute / RowDescriptor maps and insert ProjectNodes where it allows earlier discarding of unused columns.  
   * Especially effective before VTab scans that support “column mask” optimization.

4. Join order / algorithm selection  
   * Start with current greedy NLJ cost model, but enrich with:  
     – Row cardinality propagation from predicate push-down.  
     – Index lookup cost vs full scan cost.  
     – Awareness of LEFT / RIGHT OUTER semantics.  
   * Later phases: introduce HashJoin & MergeJoin physical conversions when ordering / hashability make them cheaper.

5. Smart materialisation & caching (“deterministic boundaries”)  
   * Heuristic: when a relational subtree is  ❰deterministic, pure, small or referenced >1 time❱ insert CacheNode.  
   * Use estimatedRows + tuning thresholds to decide in-memory vs pass-through.  
   * For recursive CTEs and nested-loop inner sides we already have optimization hooks; generalise those rules.

6. Streamability / pipelining preservation  
   * Prefer operators that don’t block (WindowNode, SortNode, DistinctNode can all be blocking).  
   * Convert logical Aggregate→StreamAggregate only when upstream ordering can be guaranteed; otherwise fall back to HashAggregate.  
   * Re-order DISTINCT, LIMIT/OFFSET, ORDER BY when safe to keep pipelines open.

7. Derived-table & view “inlining”  
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
     * A pure function `extractConstraints(expr) → VTabConstraint[]` that turns a ScalarPlanNode tree into xBestIndex‐style constraints (column, op, constant).  
     * Provide reverse: `residualFilter(constraints) → ScalarPlanNode` to rebuild the leftover predicate.  

1.3  Expression constant-folding utility  
     * Stand-alone util that can evaluate deterministic ScalarPlanNode sub-trees given a simple “literal env”; used by builder, optimiser *and* runtime peephole.  

1.4  Physical-property skeleton  
     * Add default `physical: PhysicalProperties` on *all* nodes at build time (`ordering: undefined, uniqueKeys: [], deterministic: true,…`).  
     * This guarantees optimiser rules can safely read/augment properties instead of repeatedly checking for existence.

────────────────────────────────────────
2. Optimiser core (“Titan Optimiser v1”)
────────────────────────────────────────
2.1  Rule registration & trace framework  
     * Simple decorator/helper `registerRule(type, name, fn)` that auto-logs “Rule X replaced AggregateNode#42 with StreamAggregateNode#87”.  
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

2.4  “Materialisation advisory” utility  
     * Given a sub-tree, decide cache strategy (none / stream / spill) based on: deterministic, estimatedRows, referencedCount (needs ref graph).  

2.5  Plan validator pass  
     * Ensures every node is physical + every ColumnReferenceNode’s attributeId exists in some ancestor rowDescriptor.  Fails fast before emission.

────────────────────────────────────────
3. Runtime / Emitter layer
────────────────────────────────────────
3.1  Emitter registry keyed by PlanNodeType (already have) but expose `requiresOrdering`, `preservesOrdering` flags so optimiser can query.  

3.2  Shared “mini-executors”  
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

4.2  “PlanViz” CLI  
     * Node script that dumps colourised tree or emits Mermaid for quick visual sanity.  

4.3  Lint-style rule for optimiser  
     * eslint plugin (or simple script) flags direct `new SomePhysicalNode` calls outside optimiser-rules folder—discourages folks from injecting physical nodes in builder code.  

4.4  Coding conventions  
     * Each rule file ≤200 LoC, single responsibility, returns undefined if not applicable.  
     * Never mutate incoming PlanNodes; always create new instances (already true but document explicitly).  
     * Unit test every rule with at least one positive and one “no-op” case.  

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

### Phase 0 – Groundwork

(“Lay the rails before driving the train”)
CONTENTS
A. Planner metadata refresh (Rich logical meta)
B. Constraint extraction utilities
C. Shared row-cache mini-executor
D. Coding-convention & rule skeletons
E. Sequencing, ownership & acceptance gates
====================================================================
A. Planner metadata refresh
====================================================================
Goal Every PlanNode produced by the builder exposes usable
cost/row metadata and a default PhysicalProperties object so the
optimiser can reason without repeated undefined-checks.
Add file src/planner/stats/basic-estimates.ts
Apply to titan-optimi...
Extend PhysicalProperties
make all fields optional but create a DEFAULT_PHYSICAL object
static helper PlanNode.setDefaultPhysical(node, propsOverride?)
Audit builder Nodes
Where estimatedRows is undefined set a heuristic (usually the
parent’s or defaultRowEstimate from tuning).
Pack that value into physical.estimatedRows in the constructor
via setDefaultPhysical.
Cost helpers
src/planner/cost/index.ts
Apply to titan-optimi...
Builders use these instead of hand-rolled math.
Result Every node entering the optimiser has
node.estimatedRows, node.estimatedCost,
node.physical.estimatedRows.
====================================================================
B. Constraint-extraction utilities
====================================================================
Purpose Drive VTab.xBestIndex and enable residual predicate pruning.
New module src/planner/analysis/constraint-extractor.ts
API
Apply to titan-optimi...
Algorithm
a) Walk the ScalarPlanNode tree.
b) Accept forms (ColumnRef op Literal) or (Literal op ColumnRef)
c) Recurse across AND/OR (initial phase – AND only).
d) Build residual by re-assembling un-matched branches.
Utility used in two places
During builder: create FilterInfo immediately for TableScan.
Optimiser rules: further split predicates when moving Filters.
Fast unit tests in test/unit/extract-constraints.spec.ts.
====================================================================
C. Shared row-cache mini-executor
====================================================================
The same primitive will back CacheNode, NLJ-inner caching,
and materialised (non-recursive) CTEs.
File src/runtime/cache/row-cache.ts
Apply to titan-optimi...
Characteristics
Streaming first: rows are yielded immediately while also pushed
into an array until maxRows reached.
Auto-bail: if limit hit, clears array, continues pass-through.
Exposes cacheRowCount(): number|undefined helper for metrics.
Emitters (emitCache, emitNestedLoopJoin) import this instead of
own ad-hoc caches.
====================================================================
D. Coding conventions & rule skeletons
====================================================================
Doc docs/optimizer-conventions.md
each rule in src/planner/rules/<area>/rule-X.ts
must be a pure function (node,opt)→PlanNode|undefined
never mutate incoming PlanNodes
unit tests live next to file as .spec.ts
Simple eslint custom rule (optional for now) that forbids
new StreamAggregateNode( outside src/planner/rules.
Boiler-plate generator script yarn new-rule distinct-pushdown
(to be added later) to scaffold rule + spec.
====================================================================
E. Sequencing & acceptance
====================================================================
PR-1 Stats & Physical defaults (A.1–A.4)
green unit tests, no plan diff except added physical.
PR-2 Constraint extractor (B) + tests
proves residual predicate matches original semantics.
PR-3 Row-cache helper (C) with micro-benchmark showing ≤2 µs
overhead and auto-bail logic.
PR-4 Conventions doc (D) – reviewed by at least two team-members.
Merge order must follow 1 → 2 → 3 → 4 because later pieces import the earlier modules but PRs can be prepared in parallel.
Definition of Done for Phase 0
✔ All commits merged on titan/optimizer-phase0 branch
✔ yarn test passes with DEBUG=quereus:*
✔ New docs visible in README “Developer Guide” TOC
✔ No TODO or console.log left in added code
After this groundwork the Phase 1 rules (predicate push-down, join
ordering, etc.) can be implemented with clean helpers and a
reliable metadata substrate.

### Phase 1 – Core Optimization Families

Phase 1 goal Make the “Titan optimiser loop” production-ready so that new optimisation rules can be added quickly and safely.  
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
• Maintain a `visited` set of `(nodeId, ruleId)` to avoid infinite rule loops; log “skipped (already applied)”.  
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

Introducing an explicit “seek / range-scan” access node; this is the **vehicle** that lets several of the families (predicate push-down, join-order costing, cache decisions) reason about “cheap, indexed access” vs “expensive full scan”.  

Changes needed:

1. Planner output  
   • Keep the builder simple: still produce a single logical `TableAccessNode` (rename the current `TableScanNode` to `TableAccessNode`, mark it *logical*).  
   • Attach the raw `FilterInfo` and `ORDER BY` requirements gathered during build.  No index decision yet.

2. New physical access nodes  
   We already reserved enum tags in `PlanNodeType`.  We now add real nodes + emitters:  
   • `SeqScanNode` – trivial wrapper around current scan emitter; used when no usable index exists.  
   • `IndexScanNode` – streaming range scan when `xBestIndex` says “this index satisfies ORDER BY”.  
   • `IndexSeekNode` – point lookup or tight range (LOW/HIGH keys supplied).  Think “rowid/PK seek”; yields ≤ few rows.  
   → All three share a base class `PhysicalTableAccessNode` so emitters get common helpers (row-descriptor building, column mask handling).

3. Optimiser rule  
   `ruleSelectAccessPath(TableAccessNode)`  
   1. Call VTab.xBestIndex with extracted constraints + order info.  
   2. Decide which physical node fits (`SeqScan`, `IndexScan`, `IndexSeek`).  
   3. Attach `physical.estimatedRows / cost / ordering` from the chosen path.  
   4. Return the new physical node; if nothing better, just wrap into `SeqScanNode`.

4. Cost model helpers (in the “statistics” utilities we listed)  
   • `seqScanCost(rows)`  ≈ c * rows  
   • `indexSeekCost(rows)` ≈ small constant + rowsTouched  
   • `indexScanCost(rows)` ≈ rowsTouched * (log_fanout?)  
   Having these lets join-order and caching rules reason about “outerRows × innerSeekCost”.

5. Predicate push-down tie-in  
   The same rule that extracts constraints for xBestIndex also rewrites the residual predicate (if any) and leaves a `FilterNode` above the physical scan when needed.

6. Runtime emitter work  
   • `emitSeqScan` is basically today’s scan emitter.  
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
Problem Optimiser needs to ask “does node X preserve ordering?” without instantiating the Instruction.

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

## Phase 2 – Cache & Statistics

Phase 2 – “Cache & Visualise”  
(Prereqs: richer physical props, StatisticsAPI, rule registry, basic optimiser passes & emitter metadata already in place)

────────────────────────────────────────
A.  Materialisation-Advisory Framework
────────────────────────────────────────
Goal Auto-decide when/where to inject CacheNode (or spill-cache) so the inner side of repeated scans and expensive pure sub-trees is read only once.

A.1  Reference-Graph builder  
 • Walk final logical tree, build `Map<PlanNode, RefStats>` where  
  RefStats = { parentCount, appearsInLoop?, estimatedRows, deterministic }.  
 • `appearsInLoop` flagged if node sits on inner side of NestedLoop OR right side of OUTER query in correlated subquery.  
 • Re-uses each node’s existing `physical.deterministic` & `estimatedRows`.

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
 • Pick spill when rows > `tun.cache.spillThreshold` **and** host module reports `fs` available (browser runtime gets “memory” only).  
 • Spill implementation is just `tmpdir + JSONL`, streamed via AsyncIterable.

A.4  Rule wiring  
 • Add optimisation rule `registerRule('*', applyMaterialisationAdvisory)`.  
 • Runs last; traverses tree bottom-up injecting caches where `adviseCaching()` says “yes” and no cache already present.

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
export function filterRows<T>(src: AsyncIterable<T>, pred:(row:T)=> boolean | Promise<boolean>): AsyncIterable<T>
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

This completes the detailed blueprint for Phase 2, giving us intelligent caching, better streaming helpers, and the visual tooling developers need to reason about ever-more-sophisticated optimisation phases.

### Phase 3 – Polishing

Phase 3 (“Polish”) turns the optimiser/runtime into a production-grade substrate that is safe to extend and easy to debug.  Below is a drill-down for every Phase 3 item: purpose, API changes, reference implementation sketch, and acceptance tests.

────────────────────────────────────────
1. Planner Enhancements
────────────────────────────────────────
1.3  Aggressive constant-folding utility
---------------------------------------
Goal  
 Evaluate *deterministic* scalar sub-trees at plan time so later rules see Literals and simpler predicates.

Public API  
```ts
// src/optimizer/folding.ts
export function tryFold(node: ScalarPlanNode,
                        opts?: { allowNonDeterministic?: false }): ScalarPlanNode;
```

Algorithm  
1. DFS walk.  
2. A node is foldable when:  
   • Every child is LiteralNode, **and**  
   • node.getType().isReadOnly && (opts.allowNonDeterministic ? true : node.physical?.deterministic !== false).  
3. Evaluate via small interpreter (`evalScalar(node)` lives in util, uses same coercion helpers as runtime).  
4. Replace with LiteralNode carrying value & inferred type.

Integration Points  
• Builder: immediately fold in ValuesNode, Insert VALUES, default expressions.  
• Optimiser rule hooks: a tiny rule `FoldScalars` registered for *all* ScalarPlanNode types; runs first so subsequent rules work on folded tree.

Tests  
• `SELECT 1+2*3` → literal 7.  
• Non-deterministic e.g. `random()` not folded unless option set.

1.4  Physical-property skeleton
------------------------------
Why  
Rules shouldn’t keep checking “if (child.physical)”.  Initialise every PlanNode with *empty* PhysicalProperties at build time.

Implementation  
Add in `PlanNode` ctor:
```ts
if (!this.physical) this.physical = { deterministic: true, readonly: true };
```
and ensure builders never override with `undefined`.

Acceptance  
`expect(every node.physical).toBeDefined()` in plan validator (see 2.5).

────────────────────────────────────────
2. Optimiser Core
────────────────────────────────────────
2.5  Plan validator pass
------------------------
Purpose  
Hard fail before emit if the tree violates invariants; catches rule bugs early.

API  
```ts
export function validatePhysicalTree(root: PlanNode): void;
/* throws QuereusError with path to offending node */
```

Checks  
1. `node.physical` present.  
2. For every RelationalPlanNode:  
   • `getAttributes()` non-empty iff relation has columns.  
   • All `attribute.id` are unique across *entire* tree.  
3. For every ColumnReferenceNode: its `attributeId` appears in some ancestor’s RowDescriptor (build map via upward traversal).  
4. No logical-only PlanNodeType present (`Aggregate`, `Join`, etc.).  
5. Optionally: `physical.ordering` indices < column count.

Hook  
Called automatically at the end of `Optimizer.optimize()` when `DEBUG_VALIDATE_PLAN` env or unconditionally in test mode.

────────────────────────────────────────
3. Runtime / Emitters
────────────────────────────────────────
3.4  Execution metrics hook
---------------------------
Goal  
Cheap row-level telemetry to verify optimiser row-count assumptions.

Design  
• Extend `Instruction` interface with optional counters field (filled by a wrapper).  
```ts
interface InstructionRuntimeStats {
  in:  number;
  out: number;
  elapsedNs: bigint;
}
```
• Build flag or env `QUEREUS_RUNTIME_STATS`; when on, Scheduler wraps each `run` call:

```ts
const start = process.hrtime.bigint();
const result = await fn(...);
stats.out += (isIterable(result) ? /*count rows*/ : 1);
stats.elapsedNs += process.hrtime.bigint() - start;
```
• At program end emit aggregate table when `DEBUG` contains `quereus:runtime:stats`.

Emitters only need to label their instructions (`note`) correctly.

Unit test  
Run a simple query, assert stats JSON has `in/out`.

────────────────────────────────────────
4. Tooling & Dev-Practices
────────────────────────────────────────
4.3  ESLint rule: “no-physical-in-builder”
-----------------------------------------
Quick custom eslint rule in `tools/eslint-plugin-quereus`:

```js
module.exports = {
  meta:{ type:'problem', docs:{}, schema:[] },
  create(ctx){
    return {
      'NewExpression[callee.name=/.*Node$/]'(node){
        const file = ctx.getFilename();
        if (file.includes('/planner/building/') &&
            /Node$/.test(node.callee.name) &&
            physicalNodeSet.has(node.callee.name)) {
          ctx.report(node, `Physical node '${node.callee.name}' must be created in optimiser rules, not builder.`);
        }
      }
    };
  }
};
```

Add to CI lint step.

4.5  Debug namespace conventions
--------------------------------
Reserve namespaces:  
• `quereus:optimizer:rule:<RuleName>` – rule entry/exit log.  
• `quereus:optimizer:validate` – validator failures.  
• `quereus:runtime:stats` – metrics dump.  

Provide `createLogger` wrappers:  
```ts
export const ruleLog = (rule: string) => createLogger(`optimizer:rule:${rule}`);
```

Dev-doc update with examples.

Once these are merged, new optimisation rules can rely on:
• guaranteed `physical` presence,  
• literal folding done,  
• fast failure when invariants break,  
• cheap runtime feedback to tune heuristics.

## Guiding principles

Here is the “constitution” we have been following internally when adding Titan-era planner/optimiser code.  Keep it handy—when a patch feels awkward it usually violates one of these paragraphs.

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
    • Emitters rely on this; breaking it causes “column not found” at runtime.

3.  Logical vs Physical separation  
    • Nodes can be both logical and physical, but not all nodes are physical.
    • Optimiser must finish with a tree where every relational node has `physical` set and has a registered emitter.

4.  Single-purpose rules  
    • One `.ts` file = one clear “If X then rewrite to Y” responsibility.  
    • Rule returns `undefined` for “not applicable”, never a partially mutated node.

5.  No hidden side-effects  
    • Rule functions are pure: (node, optimiser) → newNode | undefined.  
    • All statistics, cost models, caches are passed in via optimiser context; nothing reads globals.

────────────────────────────────────────
B.  Coding style & expressiveness
────────────────────────────────────────
1.  “Expressive > imperative” (echoing the workspace rule)  
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
    • Don’t `console.log`; use the debug helper so users keep control of verbosity.

11.  Plan validation after every phase  
    • The `validatePlan()` pass (cheap DFS) checks:  
      – every ColumnReferenceNode resolves to an Attribute present upstream,  
      – no logical node remains,  
      – physical properties are populated.  
    • CI fails fast if validation fails.

────────────────────────────────────────
D.  Performance & maintainability
────────────────────────────────────────
12.  “Pay-as-you-go” complexity  
    • Start with simple heuristics; only add stats-heavy or combinatorial algorithms when a benchmark proves the need.  
    • Keep cost model formulas readable—arithmetical expressions, not half pages of algebra.

13.  Stream-first mindset  
    • Always ask: “does this transform increase blocking, buffering or duplicate scans?”  
    • Prefer streaming/online variants; fallback to caching/materialisation only via the dedicated rule.

14.  Reuse before invention  
    • CacheNode, RowDescriptor creation helpers, etc., exist—use them.  
    • If a rule needs “mini materialisation” it should call the shared cache helper, not hand-roll a new one.

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
