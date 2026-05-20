description: Review the `delegatesNotNullBackfill` module capability that lets a structurally-total vtab module opt out of the engine-generic ADD-COLUMN NOT-NULL-backfill rejection and own the decision in its own `alterTable`. Native modules (memory, store) leave the flag off, so their behavior and Quereus's own conformance suite are unchanged. Prerequisite half of cross-repo Lamina ticket `lamina-quereus-add-column-not-null-structurally-total`.
files:
  - packages/quereus/src/vtab/capabilities.ts                 (NEW flag `delegatesNotNullBackfill?: boolean` on `ModuleCapabilities`, ~:24)
  - packages/quereus/src/runtime/emit/alter-table.ts          (`runAddColumn` ~:226 — reads `module.getCapabilities?.().delegatesNotNullBackfill` and skips `validateNotNullBackfill` when set; `validateNotNullBackfill` itself unchanged ~:404)
  - packages/quereus/test/alter-add-column-delegate.spec.ts   (NEW spec — 3 tests: native regression, delegation success, APPLY SCHEMA delegation)
  - packages/quereus/src/vtab/memory/layer/manager.ts         (~:1024 native memory reject — UNCHANGED; still the dead backstop, generic check fires first for memory)
  - packages/quereus-store/src/common/store-module.ts         (~:575 native store reject — UNCHANGED; same)
  - docs/sql.md                                               (ADD COLUMN restriction note updated ~:1143)
----

# Review: `delegatesNotNullBackfill` capability for ADD COLUMN NOT NULL backfill

## What landed

A new opt-in capability flag, `delegatesNotNullBackfill?: boolean`, on `ModuleCapabilities` (`vtab/capabilities.ts`). Default/absent ⇒ current behavior.

`runAddColumn` (`runtime/emit/alter-table.ts`) now computes:

```ts
const delegatesBackfill = module.getCapabilities?.().delegatesNotNullBackfill === true;
const hasNotNull = columnDef.constraints?.some(c => c.type === 'notNull') ?? false;
if (hasNotNull && !delegatesBackfill) {
  // ...existing defaultIsNullish logic...
  await validateNotNullBackfill(rctx, tableSchema, columnDef.name);
}
```

When the target table's module advertises the capability, the engine-generic `validateNotNullBackfill` pre-check is skipped and `module.alterTable` owns the ADD-COLUMN NOT-NULL decision. Everything else in `runAddColumn` (duplicate-column, PK-add, non-foldable-DEFAULT, CHECK-backfill, generated-graph) is untouched and still applies to all modules. APPLY SCHEMA is covered for free because `emitApplySchema` re-executes generated DDL through this same path (verified by test).

## Design decisions / why X not Y

- **Gated strictly on the explicit capability, not "is a virtual table".** In Quereus all tables are virtual, so a broad "vtab ⇒ skip" would have changed semantics for every third-party module. The flag is read off the resolved `tableSchema.vtabModule` the emit path already holds.
- **Native in-module rejects KEPT, not deleted.** `memory/layer/manager.ts:1024` and `store-module.ts:575` are unchanged. For native modules the capability is off, so the *generic* check still fires first and those in-module rejects remain dead backstops — exactly as before. Native behavior is byte-for-byte unchanged.
- SET NOT NULL: no engine-generic backfill pre-check exists for `ALTER COLUMN … SET NOT NULL` (see investigation below) — the module already owns it — so no gate was needed there.

## Validation performed

- `yarn typecheck` (tsc --noEmit): clean.
- `yarn lint`: clean.
- `yarn test` (memory-backed): **2867 passing, 1 failing**. The single failure is `Stress tests › Deep/complex queries › 5-way join chain with 200 rows each` — a 60s mocha timeout on a perf stress test, **unrelated** to the ALTER path (does not touch ADD COLUMN). Reviewer should confirm it reproduces on a clean checkout.
- New spec `alter-add-column-delegate.spec.ts` — 3 passing:
  - (a) native (default `memory`) ADD COLUMN NOT NULL on a non-empty table still rejects.
  - (b) a `TotalMemoryModule` advertising the flag gets ADD COLUMN delegated; column added, 2 pre-existing rows carried forward with NULL.
  - (c) APPLY SCHEMA over the advertising module reconciles a `tier TEXT NOT NULL` add against a non-empty table without aborting.
- Existing conformance: `test/logic/41-alter-table.sqllogic` (the NOT NULL backfill rejection cases checking substrings `NOT NULL`, `'rank'`, `main.t_notnull`) still passes — confirms native path unchanged.

## Use cases to exercise during review

- `ALTER TABLE t ADD COLUMN c <type> NOT NULL` on a non-empty table — must still reject for `memory` and `store`; must succeed (delegated) for a module advertising the flag.
- The implied-NOT-NULL case: with `default_column_nullability='not_null'`, `ADD COLUMN c <type>` (no explicit NOT NULL) — note this is NOT gated. `hasNotNull` keys off an explicit `notNull` *constraint* in the AST, matching the pre-existing generic check (which also only triggered on `c.type === 'notNull'`). The implied-not-null-by-pragma path was never rejected by `validateNotNullBackfill` and still isn't. **Confirm this matches the consumer's expectation** — the ticket's prose mentions "explicit, or implied by `default_column_nullability='not_null'`", but the existing engine check only ever fired on an explicit constraint. Behavior here is unchanged from before; flagging because the ticket wording could be read to imply the pragma path was gated.
- ADD COLUMN with a DEFAULT (foldable / NULL-folding) — unchanged; the gate only skips the NOT-NULL-no-usable-default branch.

## Known gaps / honest notes

1. **Test fake, not the real consumer.** The capability is exercised via a `TotalMemoryModule` test subclass that relaxes NOT NULL→nullable when delegating to the base manager (so the manager backfills NULL) and then re-marks the returned-schema column NOT NULL. The real consumer is the cross-repo Lamina vtab module (`../lamina`, ticket `lamina-quereus-add-column-not-null-structurally-total`); its actual `alterTable` is not exercised by this repo's tests. The two land together.

2. **Message/condition drift between the generic check and the native in-module rejects** (relevant only if a native module is ever flipped to delegate — which it must not be):
   - Substrings: both the generic message (`NOT NULL constraint failed for column 'c' added to S.T — …`) and the native messages (`Cannot add NOT NULL column 'c' to non-empty table 'S.T' without a DEFAULT value`) contain `NOT NULL`, `'c'`, and `S.T`, so the `41-alter-table` substring assertions would pass under either enforcer.
   - **Condition drift (memory only):** for `ADD COLUMN c NOT NULL DEFAULT NULL` (a literal NULL default) on a non-empty table, the generic check *rejects* (folds to NULL ⇒ "nullish"), but `memory/layer/manager.ts`'s in-module check does *not* (it treats any folded literal, including NULL, as `defaultIsLiteral` and skips the reject). Store's check (`defaultValue === null`) matches the generic one. This drift is invisible today because the generic check fires first for both native modules; it only surfaces if memory becomes the sole enforcer. Documented here so it isn't mistaken for a regression.

3. **`test:store` not run.** The change is engine-generic and does not touch the store module's `alterTable`; the store capability is off so its path is unchanged. The slower `yarn test:store` was not run (per agent-runnable time budget). A reviewer preparing a release may want to run it, but no store-path change is expected.

## Investigation results (from the ticket's "Investigate / possibly extend")

- **SET NOT NULL (`ALTER COLUMN … SET NOT NULL`):** there is **no** engine-generic upstream backfill check. `runAlterColumn` (`alter-table.ts:483`) delegates the whole change to `module.alterTable`, and the `SchemaChangeInfo.alterColumn` contract (`vtab/module.ts:249`) explicitly makes the module responsible (`setNotNull=true with rows containing NULL → throw CONSTRAINT`, backfilling from DEFAULT first if present). So a structurally-total module already owns SET NOT NULL with no gate needed — **no action taken**. Lamina gets the structurally-total behavior there automatically.
- **CREATE [UNIQUE] INDEX:** confirmed unaffected — index creation delegates wholly to the module (`SchemaManager.createIndex` → `module.createIndex`) with no core duplicate-scan, so no gate is needed. **No change.**
