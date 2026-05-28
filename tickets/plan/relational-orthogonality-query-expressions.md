---
description: Make VALUES (and DML-with-RETURNING) usable anywhere a SELECT can appear; unify under a single `QueryExpr` AST surface.
files:
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/src/planner/building/block.ts
  - packages/quereus/src/emit/ast-stringify.ts
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/parser/visitor.ts
  - docs/architecture.md
  - docs/sql.md
---

## Background

`docs/architecture.md` lists **Relational Orthogonality** as a design tenet:

> any statement that results in a relation can be used anywhere that expects a relation value, including mutating statements with RETURNING clauses.

The parser today only partially honors this. Three forms produce a relation — `SELECT`, `VALUES`, and DML-with-`RETURNING` — but each one is wired in by hand at every site, and the table is sparse:

| Context | `SELECT` | `VALUES` | `INSERT/UPDATE/DELETE RETURNING` |
|---|---|---|---|
| Top-level statement | ✅ | ✅ | ✅ |
| `INSERT ... <source>` | ✅ | ✅ (parallel AST field) | ❌ |
| FROM-clause subquery `(...) AS t` | ✅ | ✅ | ✅ (`MutatingSubquerySource`) |
| CTE body `WITH t AS (...)` | ✅ | ❌ (parser TODO `parser.ts:260`) | ✅ |
| Scalar / row subquery `(...)` in expression | ✅ (`parser.ts:1779`) | ❌ | ❌ |
| `EXISTS (...)` | ✅ (`parser.ts:1609`) | ❌ | ❌ |
| `IN (...)` / `NOT IN (...)` subquery | ✅ (`parser.ts:1277, 1396`) | ❌ | ❌ |
| Compound leg (`UNION` / `INTERSECT` / `EXCEPT`) | ✅ (`parser.ts:609, 615`) | ❌ | ❌ |
| `CREATE VIEW v AS ...` | ✅ (`AST.CreateViewStmt.select`) | ❌ | n/a |

Every ❌ above is a parser-only artifact. The planner already treats `ValuesStmt` and DML-with-RETURNING as ordinary `RelationalPlanNode`s — `buildFrom`'s `subquerySource` branch (`building/select.ts:455-493`) handles both paths interchangeably, and `buildValuesStmt` (`building/select.ts:291`) returns the same node shape `buildSelectStmt` does.

## Goal

Introduce a single AST surface — call it `QueryExpr` — covering everything that yields a relation, and accept it uniformly at every relation site. This is a structural refactor of the AST + parser; the planner, optimizer, and runtime are largely unchanged because they already operate on `RelationalPlanNode`.

## AST shape

```ts
// New union; replaces every ad-hoc `SelectStmt | ValuesStmt | ...` site.
export type QueryExpr =
  | SelectStmt
  | ValuesStmt
  | InsertStmt   // must have `returning`
  | UpdateStmt   // must have `returning`
  | DeleteStmt;  // must have `returning`
```

Site-by-site impact:

- **`InsertStmt`** — replace the parallel `values?: Expression[][]; select?: SelectStmt` fields with `source: QueryExpr`. `parser.ts:375-406` collapses to one dispatch. `building/insert.ts` (wherever it currently branches on `values` vs `select`) collapses to a single `buildQueryExpr(source)` call feeding the DML pipeline. `ast-stringify.ts` and `rename-rewriter.ts` lose their dual paths.
- **`SubquerySource.subquery`** — widen from `SelectStmt | ValuesStmt` to `QueryExpr`. `MutatingSubquerySource` then becomes redundant; fold it into `SubquerySource`. Parser's FROM-source dispatch (`parser.ts:808-820`) loses its `SELECT|VALUES|WITH` vs `INSERT|UPDATE|DELETE` split.
- **`SubqueryExpr`** (scalar / row, `parser.ts:1776-1794`), **`ExistsExpr`** (`parser.ts:1605-1616`), **`InExpr.subquery`** (`parser.ts:1273-1296, 1392-1408`) — all widen from `SelectStmt` to `QueryExpr`. The lookahead inside `(` accepts `SELECT`, `VALUES`, `WITH`, `INSERT`, `UPDATE`, `DELETE`.
- **Compound legs** (`SelectStmt.compound`, `parser.ts:609, 615`) — widen so `values (1) union all values (2)` and `select … union all (insert … returning …)` parse. The compound-result node is already relational-only, so semantics are unaffected.
- **CTE body** (`parser.ts:242-263`) — accept `VALUES` (closing the explicit TODO at line 260). `INSERT/UPDATE/DELETE` already work.
- **`CreateViewStmt.select`** → `body: QueryExpr`. `create view v as values (1,'a'),(2,'b')` becomes valid. View-updateability (see `docs/view-updateability.md`) is already FD-driven and operates on the planner-side relation, so no semantic change.

## Mutating sources in expression position — semantics

`(insert into t values (...) returning id) in (...)` is the spicy case. Two questions to settle in this ticket, with proposed defaults:

1. **Execution order / cardinality.** Mutating subqueries are *not* idempotent. Proposal: a mutating subquery in expression position is executed **once per evaluation**, identical to its FROM-position behavior today. The planner already enforces this via the `Sink`/`MutatingSubquerySource` distinction; widening the parser does not relax it.

2. **Allowed positions.** Proposal: permitted in scalar/row subquery, `EXISTS`, `IN`, compound legs, CTE bodies, and view bodies. **Disallowed** in `CHECK`/`DEFAULT`/assertion expressions (already gated by the determinism enforcer — see `docs/runtime.md#determinism-validation` — the existing check should catch DML naturally, but verify). Disallow inside expressions evaluated as part of *another* DML's per-row context (e.g. `update t set x = (insert into u ... returning y)`) for v1 — listing as a `backlog/` follow-up keeps this ticket scoped.

## Column naming for unnamed-source bodies

`VALUES` (and to a lesser extent expression columns in `SELECT`) supply no natural column names. The precedence rule is:

1. **Binding-site column list wins absolutely** — the existing optional list on `CreateViewStmt.columns`, on `commonTableExpr.columns`, and on FROM-subquery `AS t(a, b)` already supplies names and continues to.
   ```sql
   create view v(a, b) as values (1,'x'),(2,'y');
   with t(a, b) as (values (1,'x'),(2,'y')) select * from t;
   select * from (values (1,'x'),(2,'y')) as t(a, b);
   ```
2. **Body-supplied names** — `SELECT` aliases/column-refs as today; `RETURNING` aliases/column-refs for DML; `VALUES` has none.
3. **Fallback** — synthesized `column_0`, `column_1`, … matching today's `ValuesNode` defaults (`values-node.ts:57, 81`).

**Policy for persistent named relations** (view bodies, top-level CTE bodies): **silently synthesize** when no name is supplied at either site. Rationale:

- Matches today's `ValuesNode` default already in production code.
- Matches what `create view v as select 1, 'a'` does for unnamed expression columns (verify as the implementer's first cross-check — if today's SELECT path errors instead, VALUES must error too; consistency across body types is the rule, not the specific behavior).
- Synthesized names are stable and addressable.
- A stricter "must name explicitly" rule applied only to VALUES would be an inconsistent special case.

**DML-RETURNING view bodies** are rejected at view-creation time (see "Mutating sources in expression position — semantics" above), so they do not surface a naming question.

**Out of scope here**: changing the synthesized-name format from `column_0` (zero-indexed) to `column1` (one-indexed, PostgreSQL/SQLite convention) — would break any existing query that references synthesized names from FROM-`VALUES` use. File a separate backlog ticket if desired.

## Runtime and optimizer implications

This is the non-trivial half of the work. Widening `VALUES` is mechanical; widening DML-RETURNING is a behavior change to the planner contract, because **every existing `RelationalPlanNode` is pure**, and a lot of machinery quietly assumes that. The ticket adds DML to expression position; the core mitigation is to make impurity a first-class fact on the plan tree and audit every rule that re-shapes plans against it.

### Side-effect tagging on `PlanNode`

Introduce a `hasSideEffects: boolean` (or equivalent `purity` enum) on `PlanNode`, computed bottom-up: `true` at any `Sink`/DML-write node, propagated up through every relational and scalar parent that contains a side-effecting child. This is the single signal every downstream consumer reads. Cheap, additive, doesn't touch the existing physical-properties contract.

### Optimizer rule audit

Every rule that *moves, duplicates, drops, or merges* a subtree must consult `hasSideEffects` and refuse the rewrite (or weaken it to a side-effect-preserving form) when set:

- **Subquery decorrelation** (`planner/rules/subquery/`) — EXISTS/IN → semi/anti-join rewrites change cardinality of side-effect execution. Skip when inner is impure.
- **Predicate pushdown** (`planner/rules/predicate/`) — pushing a filter past a mutating node changes *which* rows trigger writes. Refuse.
- **Cache / materialization** (`planner/rules/cache/`) — CTE materialization with run-once-and-memoize semantics is fine *and required* (multiple references must not re-drive the DML). CSE / dedup of two textually-identical DML subqueries is forbidden (collapses two writes into one). Cache invalidation across references is once-only.
- **Dead-code / unused-projection elimination** — cannot drop a subtree whose child writes, even when no column is consumed above.
- **Constant folding / `EmptyRelation` collapse** — cannot fold a mutating subtree to a constant even when outputs are statically known.
- **Compound reordering** — order of side effects matters in `values (insert …) union all values (insert …)`. Preserve textual order across impure legs.
- **FK→PK join elimination and assertion-as-premise hoisting** (architecture.md:135) — both assume the dropped/hoisted relation is observable but pure. Skip when impure.

### Parallel-track rules (hard correctness gate)

`EagerPrefetchNode`, `AsyncGatherNode`, `FanOutLookupJoinNode` fork `RuntimeContext` and drive children concurrently. The module concurrency contract (`'serial'` / `'reentrant-reads'` / `'fully-reentrant'`) governs *reads*. A DML subtree inside a parallel-driven sibling violates the connection lock under everything except `'fully-reentrant'`, which no module currently advertises. The parallel-rule recognition pass (`rule-async-gather-zip-by-key.ts` and the future fan-out rule) must refuse to gather/fork when any sibling has `hasSideEffects = true`. Lift the existing `concurrencySafe` per-branch flag on `FanOutLookupJoinNode` into a shared "branch is concurrency-safe" predicate the parallel rules consult.

### Runtime emitters

- **Scalar / EXISTS / IN subquery emitters must fully consume** their inner iterator when `hasSideEffects = true`, even when short-circuiting would suffice for a pure SELECT. EXISTS-stops-after-row-1 is correct for SELECT, wrong for `EXISTS (insert … returning …)` — partial execution leaves writes undone.
- **Run-once fence**: a re-evaluated outer expression (e.g. a scalar subquery in a correlated context) must not re-drive a nested DML. Existing `Sink` semantics likely cover this — verify and pin with a test that wraps a DML subquery in a correlated outer.

### `Statement.getChangeScope()` / `Database.watch`

Currently `SELECT` reports only reads (architecture.md:115). A SELECT *containing* a mutating subquery now writes too — `getChangeScope` must propagate writes from any nested DML, and `Database.watch(scope, …)` reactive callbacks fire correspondingly. Behavioral change to a public API; once `hasSideEffects` exists, the propagation is mechanical, but it deserves explicit doc + test coverage.

### Smaller cross-cutting items

- **Determinism enforcer** — already rejects non-deterministic expressions in CHECK / DEFAULT / assertions. Should catch DML via the same path; verify rather than assume, and add a negative test.
- **View updateability** — `create view v as values …` should bottom out as unupdateable (no base table to fan out to). The FD-driven propagation in `docs/view-updateability.md` should handle this naturally; pin with a regression test. View bodies that *are* DML-RETURNING are interesting and likely should be rejected at view-creation time — call out and decide.
- **Conflict resolution scope** — an outer `INSERT OR REPLACE` does not propagate to nested DML. Each DML carries its own `onConflict`. Pin explicitly in `docs/sql.md`.
- **`ValuesNode` reach** — existing FD/key propagation gets exercised much harder once `VALUES` appears in compound legs, scalar/EXISTS/IN subqueries, and view bodies. The recent `values-singleton-fd` commit covered the singleton case; multi-row + compound paths will surface fresh edge cases. Golden-plan sweep (`test/plan/golden-plans.spec.ts`) needed.

## Parser strategy

A single helper `parseQueryExpr(startToken?, withClause?)` replaces the scattered `selectStatement` / `valuesStatement` / `mutatingSubquerySource` calls at every relation site:

```
parseQueryExpr:
  if WITH      → consume, recurse with innerWith attached to the inner query
  if SELECT    → selectStatement
  if VALUES    → valuesStatement
  if INSERT    → insertStatement   (require RETURNING when used non-top-level)
  if UPDATE    → updateStatement   (require RETURNING when used non-top-level)
  if DELETE    → deleteStatement   (require RETURNING when used non-top-level)
  else error
```

The `(LPAREN, lookahead)` site at the head of `tableSource` / `primary` / `EXISTS` / `IN` all delegate here. The "RETURNING required outside top level" check lives on the caller side (top-level `statement()` skips it; every nested site enforces).

## Out of scope (parked separately)

- DML inside expressions evaluated per row of an outer DML (`update t set x = (insert … returning …)`) — needs ordering semantics review.
- `TABLE t` SQL-standard shorthand for `SELECT * FROM t` as a query expression — adjacent but unrelated.
- Lateral `VALUES` referencing outer columns — works as a side effect once parsing is unified, but verify and pin with a test.

## Test surface (informal — flesh out at implement stage)

The win is that one round-trip + one plan-shape sweep covers a large new matrix:

- **AST round-trip property test** (`test/emit-roundtrip-property.spec.ts`) is the natural net: enumerate `QueryExpr` at every site, assert `parse(stringify(x)) ≡ x`. Catches stealth field-drops in `ast-stringify`.
- **Declarative-schema equivalence** (`test/declarative-equivalence.spec.ts`) gains free coverage of `create view v as values …` and DML-RETURNING view bodies once `CreateViewStmt.body: QueryExpr` lands.
- New `*.sqllogic` cases: `with t(a,b) as (values (1,'x'),(2,'y')) select * from t`; `values (1) union all values (2)`; `(values (1),(2)) in (select id from t)`; `exists (values (1))`; `select (insert into log values (default,'hit') returning id)`; `create view v as values (1,'a'),(2,'b')`.
- Plan-shape parity: a SELECT-form and equivalent VALUES-form of the same constant relation should produce isomorphic optimized plans modulo node-type leaf, since both lower to `ValuesNode` vs `Project(Values…)` shapes the optimizer already normalizes.
- **Side-effect audit fixtures** (`test/optimizer/`) — for each rule that consults `hasSideEffects`, pin one positive case (rule fires on pure subtree) and one negative case (rule refuses on impure subtree). Categories: decorrelation, predicate pushdown, CSE / cache dedup, dead-code elimination, constant folding, FK→PK join elimination, assertion-as-premise hoisting.
- **Run-once fence test**: scalar DML subquery inside a correlated outer expression — assert the DML executes exactly once regardless of how many times the outer row's expression is evaluated.
- **Parallel-track refusal**: hand-construct a plan with `hasSideEffects = true` inside an `AsyncGatherNode` / `FanOutLookupJoinNode` sibling and assert the recognition rule does *not* fold it.
- **`getChangeScope` propagation**: a SELECT containing a nested DML reports the nested writes; `Database.watch` fires on the appropriate base table.
- **EXISTS / IN full-drain**: `select exists (insert into log values (1) returning 1)` followed by `select count(*) from log` returns 1 — confirms the emitter does not short-circuit a side-effecting inner.
- **Determinism gate** (negative): `INSERT … RETURNING` in `CHECK` / `DEFAULT` / assertion expressions must error with the existing determinism diagnostic, not a parser surprise.
- **View-as-VALUES updateability** (negative): `create view v as values (1,'a'),(2,'b')` followed by `insert into v values (3,'c')` errors cleanly (no base relation to fan out to).

## Documentation touch points

- `docs/architecture.md` — the orthogonality bullet (line 106) graduates from aspiration to literal truth; mention the unified `QueryExpr` surface. Add a note under the optimizer recent-refinements list about the `hasSideEffects` plan-node signal and the rule-audit discipline it imposes.
- `docs/sql.md` — replace the `VALUES is usually part of SELECT` framing throughout; add a short "Query expressions" section listing the five forms and the sites that accept them. Document the run-once-per-statement contract for mutating subqueries in expression position and the conflict-resolution scoping rule.
- `docs/runtime.md` — note the EXISTS / IN / scalar emitter full-drain behavior on side-effecting inners.
- `docs/optimizer.md` — describe the `hasSideEffects` flag, its propagation, and the rule categories that consult it.
- `docs/view-updateability.md` — explicit note that `VALUES`-bodied views are unupdateable and that DML-RETURNING-bodied views are rejected.
- `docs/change-scope.md` — document the propagation of writes from nested DML into the enclosing statement's `ChangeScope`.

## Risks

- **Ambiguous parses** in expression-position when a mutating keyword appears inside `(`: today `(INSERT …)` in expression position is a syntax error, so widening is purely additive — no existing grammar breaks. Confirm by running the full `*.sqllogic` corpus + parser-robustness property test.
- **AST consumer fanout** — anything that pattern-matches `node.type === 'select'` to mean "is a relation" needs auditing. `rename-rewriter.ts`, `visitor.ts`, `ast-stringify.ts`, and any planner-side AST traversal are the main suspects. The `RelationalPlanNode` boundary downstream already abstracts this.
- **Backwards-compat in `InsertStmt`**: dropping `values` + `select` in favor of `source` is a breaking AST change. Per `AGENTS.md` ("Don't worry about backwards compatibility yet"), that's acceptable; the change is mechanical for any in-tree consumer.
- **Silent optimizer breakage** is the highest-impact risk: any rule that re-shapes plans without checking `hasSideEffects` will quietly drop, duplicate, or reorder writes. Mitigation is the side-effect audit fixtures (one positive + one negative per rule), plus a lint-style audit that every rule entry in `planner/framework/registry.ts` either explicitly declares "side-effect-safe" or "side-effect-aware". The latter is worth landing as part of this ticket rather than relying on reviewer vigilance.
- **Parallel-track silent miscompilation** — same shape: a parallel-recognition rule that folds a side-effecting branch breaks concurrency contracts invisibly. Same mitigation pattern.

## Suggested split into implement tickets

Likely too large for a single implement ticket; suggested decomposition (plan-stage agent decides):

1. **AST + parser unification** — introduce `QueryExpr`, fold `InsertStmt.{values,select}` → `source`, fold `MutatingSubquerySource` into `SubquerySource`, widen every `(`-lookahead site. Pure-VALUES coverage only (DML in expression position parses but errors at planning time). Lands the AST round-trip + declarative-equivalence property gains immediately.
2. **`hasSideEffects` plan-node signal + optimizer rule audit** — introduce the flag, propagate it, audit every rule in `planner/rules/` and `planner/framework/registry.ts`. Land the audit fixtures. No new user-visible features yet.
3. **DML in expression position — runtime + planner** — runtime emitter changes (full-drain, run-once fence), `getChangeScope` propagation, view-body rejection. Lifts the planning-time error from ticket 1.
4. **Parallel-track refusal** — the parallel-rule recognition pass consults the shared "branch is concurrency-safe" predicate. May land alongside ticket 2 or as a follow-up depending on the existing parallel-* track's status.

Tickets 2 + 3 are the substantive ones; ticket 1 is mostly mechanical and unblocks the value-only orthogonality win quickly.

## References

- `docs/architecture.md` §"Key Design Decisions" — Relational Orthogonality
- `docs/view-updateability.md` — confirms view-body refactor is safe (FD-driven, not parse-shape-driven)
- `docs/runtime.md#determinism-validation` — gates DML in CHECK/DEFAULT
- Recent commit `f126ba02 ticket(plan): values-singleton-fd` — `ValuesNode`'s FD surface is current, so the existing constant-table optimizer story is in good shape.
