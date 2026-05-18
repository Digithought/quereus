---
description: Review the CHECK-aware rename rewriter fix that consults a schema-aware column-lookup callback to stop unqualified subquery refs (whose FROM exposes a like-named column) from being false-positively rewritten to the renamed table's column.
prereq:
files:
  - packages/quereus/src/schema/rename-rewriter.ts
  - packages/quereus/src/runtime/emit/alter-table.ts
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
---

# CHECK-rename rewriter respects inner-FROM shadowing

## What changed

1. `rename-rewriter.ts`:
   - Added an exported `ResolveColumnInSource` callback type (`(schema, table, column) => boolean`).
   - Added `realSources: Array<{schema, name}>` to `ScopeFrame` — populated by `collectFromBindings` for every real-table FROM source (the CTE-shadow branch hits `break` before reaching the push, so CTE-shadowed sources stay out). Empty for the seed/synthetic frames (CHECK seed, UPDATE/DELETE synthetic frames).
   - `ColumnRewriteState` carries an optional `resolveColumnInSource` callback.
   - `isTableInUnaliasedScope` now (when the callback is supplied) consults each frame's `realSources` after the CTE-shadow check and before the `unaliased` check: if any source other than the renamed table itself exposes `oldCol`, the walk returns `false`, stopping an outer seed from capturing the ref. The renamed-table-itself source is skipped to defer to the existing `unaliased.has` path and avoid double-capture (preserves the correlated case where the inner FROM is the renamed table).
   - `renameColumnInCheckExpression` now takes the optional callback as its sixth parameter; existing docstring rewritten to describe the new behavior and note the remaining limitation.

2. `alter-table.ts`:
   - `propagateColumnRename` builds the closure once from `rctx.db.schemaManager`: it asks `schemaManager.getSchema(s)?.getTable(t)?.columnIndexMap.has(col)`.
   - The closure is threaded through `propagateColumnRenameInSchema` → `rewriteTableForColumnRename` and supplied only to the `renameColumnInCheckExpression` call (the non-CHECK `renameColumnInAst` call is intentionally left alone — see "Out of scope" in the original ticket).

3. `41.3-alter-rename-propagation.sqllogic`:
   - **Case 15** — CHECK subquery with like-named column on another table (the reproducer). `t_chksub.v` rename must NOT rewrite the inner `v` against `t_chksub_u.v`.
   - **Case 16** — CHECK subquery with correlated outer ref. The other table has no `v`; the inner `v` is correlated; the seed must still capture, so the rewrite happens and the CHECK keeps evaluating.

## Use cases for testing / validation

- Run `41.3-alter-rename-propagation.sqllogic` and confirm cases 15-16 (plus all prior 6{a..p}, 12, 13, 14 cases) pass.
- The interesting axis the new code exercises is `isTableInUnaliasedScope` walking past an inner FROM frame whose real source is asked about. Build manually:
  - CHECK with subquery `(select v from u)` where `u` has `v` → inner `v` not rewritten (case 15).
  - CHECK with subquery `(select v from u)` where `u` lacks `v` → inner `v` rewritten as correlated (case 16).
  - CHECK with subquery `(select v from t)` where `t` is the renamed table → inner `v` rewritten (preserved by the "skip the renamed table itself" branch in the capture check).
- Confirm cross-schema sources are handled: the callback receives the lowercased schema name (defaulting from `state.defaultSchema` when the AST qualifier is undefined). No sqllogic coverage for cross-schema (the test harness uses a single default schema) — the closure itself just delegates to `schemaManager.getSchema(s)` so behavior is by inspection.

## Build / test status

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run test` — 701 passing, 1 failing. The single failure is `95-assertions.sqllogic:202` and is **pre-existing on this branch** (reproduces with this change reverted via `git stash`).
- `yarn workspace @quereus/quereus run lint` — clean for the files touched by this change. The 10 warnings reported are all in pre-existing unstaged files on this branch (`database-transaction.ts`, `dml-executor.ts`, `connection.ts`, `manager.ts`) — none touched here.
- Skipped `yarn test:store` per the ticket — this is a pure-AST helper used during ALTER and has no chance of affecting the store path.

## Known gaps / honest reviewer notes

- **Ticket case 17 (CTE-shadow inside CHECK) was dropped.** Quereus's parser only accepts `(SELECT …)` as a scalar subquery, not `(WITH … SELECT …)` (see `parser.ts` line 1761-1778). The scenario described in the ticket is unconstructable, so the case was replaced with a comment in the sqllogic file. The CTE-shadow code path is already exercised by cases 6f, 6g, 6m, 6n, 12, and 13 on the non-CHECK propagation path; they didn't regress. The CHECK-specific entry doesn't introduce a new code path for CTE shadowing beyond what those already cover.
- **Ticket case 18 (cross-schema source) was not added** as a sqllogic case. The test harness doesn't have an obvious cross-schema fixture, and the ticket itself flagged this as optional ("If a cross-schema fixture is awkward in sqllogic, drop this case"). The closure's behavior for cross-schema is by inspection — `schemaManager.getSchema(s)` already case-insensitively resolves named schemas, and `collectFromBindings` captures `(ts.table.schema ?? state.defaultSchema).toLowerCase()` for the schema field of `realSources`.
- **Aliased subquery / function-source / CTE-projection inner-FROM shadowing is still latent.** A nested subquery whose projection happens to expose a column named `oldCol` would still false-positively rewrite (the rewriter would need recursive column-set inference on the subquery body to ask the callback). This is called out in the rewritten `renameColumnInCheckExpression` docstring. The original ticket explicitly listed this as out-of-scope.
- **The symmetric `renameColumnInAst` (non-CHECK) entry path was not plumbed with the callback.** Same justification as the ticket: the CHECK seed is the only place that creates a virtual top-level binding that doesn't correspond to an actual FROM frame. If the symmetric case ever surfaces in a real-world rename, the callback type and `realSources` plumbing are already in place — only the public entry's signature would need to grow the parameter and the call sites would need to construct the closure.
- **Tests do not exercise the "renamed table is itself in the inner FROM" path explicitly.** The case is reasoned about in this handoff and exercised implicitly by the existing 10b/10/etc. table-level-CHECK tests, but a dedicated case (e.g. `check ((select count(*) from <renamed_table> where v > 0) >= 0)`) would pin the "skip the renamed table itself" branch in the capture check. Worth adding if the reviewer wants belt-and-suspenders coverage.
- **`realSources` is populated on every column-rewrite walk, not only for CHECK rewrites.** The capture check is gated on `state.resolveColumnInSource` being set, so non-CHECK paths see no behavioral change today, but the extra allocations happen for every FROM source. For the rename workflow (one-shot during ALTER) this is fine; if `renameColumnInAst` ever moves to a hot path the gating logic could be tightened to skip the `realSources.push` when the callback is absent.
