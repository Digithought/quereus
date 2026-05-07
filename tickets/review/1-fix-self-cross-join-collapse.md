description: Review — self CROSS JOIN column-name collapse fixed via duplicate-name guard in identity-projection check
prereq:
files:
  packages/quereus/src/planner/building/select-modifiers.ts
  packages/quereus/test/logic/01.1-select-projection-extras.sqllogic
----

## What was done

`isIdentityProjection` (`packages/quereus/src/planner/building/select-modifiers.ts:200`) was the gatekeeper for an optimization that elides `ProjectNode` when the projection list is a 1:1 pass-through of the source's attributes. That check was sound for single-source `SELECT *`, but it ignored a precondition needed by downstream consumers: that the source's exposed column **names** are unique.

For a query like `select A.*, B.* from t1 as A cross join t1 as B`, `buildStarProjections` expands into 4 `ColumnReferenceNode` projections whose `expression.name` values are `[a, b, a, b]`, mapping 1:1 to the JoinNode's 4 attributes (which carry the same names). The identity check returned `true`, the `ProjectNode` was elided, and the engine surfaced the JoinNode's raw column list `[a, b, a, b]`. Consumers that key result rows by column name (test harness, `.toArray()` callers building objects) silently collapsed the duplicates and only retained one side's columns — the surface symptom in the ticket.

The fix adds a guard at the top of `isIdentityProjection` (after the length check, before the per-projection loop): if the source's attribute names contain any case-insensitive duplicates, return `false`. This forces a real `ProjectNode`, whose `outputTypeCache` already implements the `name:N` disambiguation rule that produces `[a, b, a:1, b:1]` — the same rule already exercised by the working `select *, * from t1` case.

The cheap pass-through optimization is preserved for everything that was previously fast (single-source `SELECT *`, joins of differently-named tables, etc.); it now correctly bails out only when disambiguation is actually required.

## Files touched

- `packages/quereus/src/planner/building/select-modifiers.ts` — added duplicate-name guard at lines 208-219 of `isIdentityProjection`.
- `packages/quereus/test/logic/01.1-select-projection-extras.sqllogic` — re-enabled the two `-- TODO bug:` cases (self cross join with explicit aliases; `A.*, B.*` self cross join). Both now pass.

## Validation

- `yarn build` — clean.
- `yarn test` — all suites pass (quereus 2523 passing, plus all other workspaces). The two re-enabled cases in `01.1-select-projection-extras.sqllogic` exercise the fix.

## Use cases / regression coverage

- `select A.*, B.* from t1 as A cross join t1 as B` → `[a, b, a:1, b:1]` (previously collapsed to `[a, b]`).
- `select A.a as la, B.a as ra from t1 as A cross join t1 as B` → 4-row cartesian (already worked because explicit aliases differ from source attribute names; preserved as regression coverage).
- `select *, * from t1` → still `[a, b, a:1, b:1]` (unchanged behavior; goes through `ProjectNode` because `projections.length !== sourceAttrs.length`).
- `select * from t1` → still elides `ProjectNode` (no duplicates → fast path retained).

## Things to look at during review

- The fix is one tight loop in one function. Reviewer should confirm there is no other path where same-named source columns could reach a result row without `ProjectNode` disambiguation (e.g., direct emission via JoinNode without a wrapping projection — currently not exercised by any callers that key by name, but worth a glance).
- `isIdentityProjection` is purely a perf optimization; this change makes it slightly more conservative. There is no correctness risk to making it return `false` more often.
