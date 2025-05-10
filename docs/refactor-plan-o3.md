Below is a set of practices – some purely procedural, others architectural – that teams building compilers / runtimes for a SQL-like engine have found to break the “debug → fix → break again” loop and steadily converge on a clean codebase.  They are ordered roughly from “can start tomorrow” to “larger-ticket refactors”, so you can decide how deep to go.

────────────────────────────────────────
1.  Add First-Class, Versioned *IR Snapshots*
────────────────────────────────────────
Problem  
The current compiler is one huge stateful class:

```25:55:src/compiler/compiler.ts
public constants: SqlValue[] = [];
public instructions: VdbeInstruction[] = [];
// many more mutable maps, stacks and counters …
```

A single bug in one phase can corrupt state that downstream phases also mutate, making root-cause tracing hard.

Fix  
a.  Break compilation into *pipeline stages*, each producing an immutable
    intermediate representation (IR).  
    • Parser → AST (already there)  
    • AST → LogicalPlan  
    • LogicalPlan → PhysicalPlan (your cost-based planner lives here)  
    • PhysicalPlan → Bytecode program  

b.  At the end of every stage, serialize the IR (“snapshot”) and attach it to
   the Statement object or dump it under `DEBUG=sqliter:snap:*`.
   Keep a tiny schema-version number in each snapshot so future refactors can still read old artifacts.

Benefits  
• Reproducer for every failure: attach the last good snapshot + the failing one.  
• Downstream stages become *pure functions* (`PhysicalPlan = plan(LogicalPlan, costModel)`), making them unit-testable in isolation.  
• Once the IR contracts are stable you can refactor internals freely.

────────────────────────────────────────
2.  Introduce Pass Manager & Explicit State
────────────────────────────────────────
Tip: create a `CompilerPass` interface:

```ts
interface CompilerPass<In, Out> {
  name: string;
  run(input: In, ctx: PassContext): Out;
}
```

A tiny `PassManager` drives the pipeline and records timings, diagnostics, and panic-proof “before / after” hooks. Every map or counter the old compiler wrote into ad-hoc fields now lives in an explicit `PassContext` object, so mutation is localized.

────────────────────────────────────────
3.  Guard Invariants with Lightweight Assertions
────────────────────────────────────────
Example: every time a placeholder address is resolved, assert that the target index is ≥ current emit index.  
Use a micro-assert library and turn assertions off in production builds, but *never* during CI. Fail-fast crashes during local development beat silent corruption caught 20 steps later.

────────────────────────────────────────
4.  Make the Cost-Based Planner Plug-In, Not Intrusive
────────────────────────────────────────
Right now the planner writes back into the main `Compiler` instance.  Prefer:

```ts
plan = costPlanner.build(ast, schema, costModel)
compiler.emitFrom(plan)
```

The planner owns its own `PlannerContext` only. All mutable fields stay inside that context so nothing else can “accidentally” read partially-computed data.

────────────────────────────────────────
5.  Snapshot (Golden) Tests Instead of Logic-Only Tests
────────────────────────────────────────
Traditional unit tests grow linearly with features and still miss “any plan is accepted but produces wrong bytecode” failures.

Add two golden test types:

• Bytecode Snapshot: for a given SQL, assert that the generated VDBE instruction sequence matches a saved JSON snapshot.  
• Planner Tree Snapshot: assert the serialized `PhysicalPlan` JSON.

When a change is *expected* (e.g., new optimisation), you *update* the snapshots; when a change is unexpected the diff is obvious.

────────────────────────────────────────
6.  Adopt Property-Based & Fuzz Tests Early
────────────────────────────────────────
You already have `fast-check` for a few modules.  Extend it:

• Generate random tables / data, random queries within a feature subset.  
• Run against SQLiter and against an authoritative engine (SQLite via WASM, DuckDB in node).  
• Any divergence = failing case auto-minimised by `fast-check`.  

This catches whole-pipeline misbehaviours better than hand-written edge cases.

────────────────────────────────────────
7.  Visible Runtime Tracing Layer
────────────────────────────────────────
The runtime already logs each opcode:

```65:88:src/vdbe/runtime.ts
log('[%s] %s P1=%d …', currentPc, Opcode[inst.opcode], …);
```

Add a pluggable trace subscriber that can emit:

• `trace.json` – every executed opcode with inputs → outputs.  
• Optional CPU-time / wall-time per opcode for perf hunting.  
• Ability to replay a trace to *just before failure* and step manually.

A failing integration test then ships a self-contained trace, often enough to pinpoint the bug without re-running the test at all.

────────────────────────────────────────
8.  Leverage TypeScript for Static Guarantees
────────────────────────────────────────
• Replace `any` / `Map<string, unknown>` with algebraic data types (`type Expr = …`).  
• Model “maybe uninitialised” values with `| undefined`; turn on `strictNullChecks`.  
• Use branded types for stack indices, cursor IDs, register numbers to avoid accidental mix-ups.

────────────────────────────────────────
9.  Gradual Refactor: Thin Facades
────────────────────────────────────────
Instead of a flag-day rewrite:

1. Create *facade* objects (e.g., `RegisterAllocator`, `CursorTable`) that wrap the current global state mutations.  
2. Move one responsibility at a time behind the facade.  
3. The old big `Compiler` slowly sheds fields until it becomes a coordinator only.

────────────────────────────────────────
10.  Process / Team Discipline
────────────────────────────────────────
• RFC-Before-Code: a one-pager for *every* non-trivial change (planner heuristics, new opcodes) stating motivation, design, and acceptance criteria.  
• PR size limits (e.g., ≤ 400 LOC net change).  
• Mandatory code review + green CI for every PR.  
• Monthly “stability weeks”: no new features, only bug-hunt / refactor.  
• Track technical debt explicitly (GitHub project, “Needs-refactor” label) so it competes for backlog space.

────────────────────────────────────────
11.  Big-Picture Roadmap
────────────────────────────────────────
Short term (1-2 weeks)  
• Snapshot framework, basic pass manager, golden tests for a handful of statements.  
• Hook cost-planner behind a façade so it no longer mutates `Compiler`.

Medium term (1-2 months)  
• Refactor compiler into stages; eliminate most mutable shared fields.  
• Introduce branded types & stricter `tsconfig`.  
• Trace exporter + replay tool.

Long term (3-6 months)  
• Full property-based differential testing versus SQLite.  
• Replace internal bytecode with table-driven definition so new opcodes require zero boilerplate changes.  
• Public API stabilisation → semver 1.0.

────────────────────────────────────────
Key Take-Away
────────────────────────────────────────
Fragility usually comes from *implicit, mutable cross-stage state*.  Making every stage explicit (typed inputs & outputs, serialized snapshots) and *pure* is the single biggest structural change that turns debugging into a deterministic exercise instead of whack-a-mole.  The other practices – golden tests, trace replay, disciplined PR flow – reinforce that structure and keep future complexity contained.

*** Nodes Chat ***

──────────────────────────────────
1.  The three explicit phases
──────────────────────────────────
A.  AST  (already produced by the parser – **unchanged**)  

B.  Logical Plan Nodes  
    • Pure data structures, no side-effects.  
    • Contain **only** semantic information needed for rewrite / cost.  
      Example:
      ```ts
      type Plan =
        | { op: 'Scan',   table: TableRef,  alias: string }
        | { op: 'Filter', input: Plan,     predicate: Expr }
        | { op: 'Project',input: Plan,     columns: ProjectItem[] }
        | { op: 'Join',   left: Plan, right: Plan,
                          joinType: 'inner' | 'left',
                          condition: Expr };   // etc.
      ```

C.  Runtime Nodes (a.k.a. Physical Plan / Operators)  
    • Implement a small iterator protocol – *no* global VM, no shared register file.  
      ```ts
      export interface Cursor {
        open(): Promise<void>;
        next(): Promise<Row | null>;   // Row = SqlValue[]
        close(): Promise<void>;
      }
      ```
    • One‐to‐one with the physical plan tree, but can wrap children in *debug* proxies.

──────────────────────────────────
2.  Compiler pipeline (top-down view)
──────────────────────────────────
```
Parser           Planner                Executor
AST ──► (pass1) ► Logical Plan ──► (pass2) ► Physical Plan  ──► (pass3) ► Cursor tree
        constant-fold                  rule based               + optional Debug wrappers
```
• pass1:  “Binder”  
  – Resolves table / column names, substitutes default schemas, annotates AST nodes with type + nullability.  
  – Performs *transitive constant folding* (details below).

• pass2:  “Optimiser”  
  – Classical algebraic rewrites:  
    push Filter → Scan, Project → Scan, re-order Joins, eliminate no-op Projects, etc.  
  – Costing gets easiest if every node carries `(rows, cost)` – you can estimate incrementally.

• pass3:  “Physicaliser”  
  – Chooses concrete runtime operators:  
    e.g. `Join` → `NestedLoopJoinCursor` OR `HashJoinCursor` depending on cost/keys.  
  – Wrap with `DebugCursor` if `DEBUG_SQLITER=true`.

──────────────────────────────────
3.  Constant folding pass  (pass1)
──────────────────────────────────
1.  Walk expressions bottom-up.  
2.  If every child is a literal, evaluate with the built-in scalar-function registry; replace with `Literal(value)`.  
3.  Keep a “fold-once” memo to avoid exponential blow-up on shared sub-exprs.  

Tip: Reuse the existing expression evaluation helpers in `src/func` – call them while **disallowing side-effects** (e.g. no `random()`, `now()`).

Edge cases to handle now (so you never revisit):  
• `NULL` semantics (`NULL op const → NULL`).  
• Division by zero ⇒ `NULL`, not error, to match SQLite.

──────────────────────────────────
4.  Debug wrappers
──────────────────────────────────
A thin higher-order cursor:

```ts
export class DebugCursor implements Cursor {
  constructor(readonly inner: Cursor, readonly label: string) {}

  async open()  { console.debug(`[${this.label}] open()`);  return this.inner.open(); }
  async next()  { const row = await this.inner.next();
                  console.debug(`[${this.label}] next →`, row);
                  return row; }
  async close() { console.debug(`[${this.label}] close()`); return this.inner.close(); }
}
```

`physicalise()` simply does:

```ts
const cur = makeCursor(node);              // real operator
return DEBUG ? new DebugCursor(cur, node.op) : cur;
```

Zero runtime cost when `DEBUG` is falsy.

──────────────────────────────────
5.  Minimal feature slice  (“vertical cut”)
──────────────────────────────────
1.  Table scan (`SELECT * FROM t`)  
2.  Restriction / Predicate (`WHERE a > 10`)  
3.  Projection with scalar expressions (`SELECT a*2, b||c`)  
4.  **Inner join** with equality condition (`FROM a JOIN b ON a.id = b.id`)  
   – Implement only Nested-Loop first; hash join can come later.  
5.  Constant folding for all built-in arithmetic / concat / comparison ops.  
6.  Simple ORDER BY (uses JS `Array.sort` on an in-memory buffer) – optional but nice for demos.

That path exercises: name binding, constant folding, push-down, join reordering, cursor interface.

──────────────────────────────────
6.  Planner API sketch
──────────────────────────────────
```ts
// planner/context.ts
export interface PlannerCtx {
  catalog: Catalog;           // already exists in SchemaManager
  debug:  boolean;
}

export function buildLogicalPlan(ctx: PlannerCtx, ast: SelectStmt): Plan {
  // 1. bind names + fold constants
  // 2. generate naïve plan (scan-filter-project)
  // 3. run rewrite rules until fixed point
  return optimizedPlan;
}
```

Rewrites as pure functions:

```ts
export function pushDownFilter(plan: Plan): Plan { … }
export function reorderJoins(plan: Plan): Plan  { … }
```

A simple rule runner:

```ts
export function optimise(plan: Plan): Plan {
  const rules = [ pushDownFilter, mergeConsecutiveFilters, ... ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const r of rules) {
      const [newPlan, did] = r(plan);
      changed ||= did;
      plan = newPlan;
    }
  }
  return plan;
}
```

──────────────────────────────────
7.  Physical operator catalogue  (initial set)
──────────────────────────────────
| Cursor class             | Prerequisites                     |
| ------------------------ | --------------------------------- |
| `TableScanCursor`        | Always available                  |
| `FilterCursor`           | Child + JS predicate fn           |
| `ProjectCursor`          | Child + compiled column lambdas   |
| `NestedLoopJoinCursor`   | Left cursor, Right cursor, cond   |
| `MaterialiseCursor`      | Wrap any child to restart scans   |

Later additions: `HashJoinCursor`, `SortedMergeJoinCursor`, `ExternalSortCursor`, `LimitCursor`, `AggregateCursor`, etc.

──────────────────────────────────
8.  Integration with the existing public API
──────────────────────────────────
`Statement` no longer owns a `VdbeRuntime`; instead:

```ts
class Statement {
  private root: Cursor;

  async prepare(sql: string) {
    const ast  = parse(sql);
    const lPlan= buildLogicalPlan(ctx, ast);
    const pPlan= physicalise(lPlan, ctx);
    this.root  = makeCursor(pPlan);
  }

  async step(): Promise<Row | null> {
    if (!this.root) throw Error('Unprepared');
    if (!this.opened) { await this.root.open(); this.opened = true; }
    return this.root.next();
  }

  async reset() { await this.root.close(); this.opened = false; }
}
```

Existing call sites (`db.query(sql, params)`) remain unchanged.

──────────────────────────────────
9.  Incremental roadmap (1-week → 4-week)
──────────────────────────────────
Day 0–1   
• Scaffold packages / folders `src/plan/` & `src/exec/`.  
• Port `SqlValue` type & comparison helpers – they’ll be reused everywhere.

Day 2–3  
• Implement constant-fold walker over existing `AST.Expression`.  
• Write Jest / Mocha tests verifying 50+ expression simplifications.

Day 4–5  
• Implement `Plan` data types and naive builder (`SELECT` → Scan→Filter→Project).  
• Write a push-down rule and verify with golden plan dumps.

Day 6–7  
• Implement `TableScanCursor`, `FilterCursor`, `ProjectCursor`.  
• Expose via new `Statement` pathway; get the first end-to-end `SELECT * FROM t WHERE 1=1` passing.

Week 2  
• Add NestedLoopJoinCursor; extend binder to handle table aliases.  
• Implement join reordering rule based on simple heuristics (#rows estimate from `xBestIndex`).

Week 3  
• ORDER BY cursor, in-memory sort; LIMIT cursor.  
• Introduce `DebugCursor` wrappers, plumb `DEBUG` env var.

Week 4  
• AggregateCursor + HashJoinCursor.  
• Drop the VDBE runtime completely; deprecate opcodes.

──────────────────────────────────
10.  What to keep from the current code-base
──────────────────────────────────
• Parser, AST types, function registry, collation code, schema/catalog, `MemoryTable` implementation, `xBestIndex` heuristics.  
• Many expression helper utilities (`compareSqlValues`, affinity handling) copy-paste with minimal edits.  
• The extensive logic tests – they’ll validate correctness as you swap the engine underneath.

──────────────────────────────────
11.  Immediate next deliverable
──────────────────────────────────
Create two new *empty* files so the scaffolding is visible in the repo:

```
src/plan/plan-types.ts
src/exec/cursor.ts
```

Content (very small):

```ts
// src/plan/plan-types.ts
export type Plan =
  | { op: 'Scan', table: string, alias: string }
  | { op: 'Filter', input: Plan, predicate: Expr }
  | { op: 'Project', input: Plan, columns: ProjectItem[] };

// TODO: add Join, Aggregate …

// src/exec/cursor.ts
export interface Cursor {
  open(): Promise<void>;
  next(): Promise<Row | null>;
  close(): Promise<void>;
}

export type Row = readonly SqlValue[];
```
