---
description: Make `dml-executor.ts` UPDATE path pass `plan.onConflict` raw (no `?? ABORT`) so column-level `defaultConflict` directives are honored on plain UPDATE. Also teach the memory module's PK-change update path to handle `REPLACE` (not just `IGNORE`).
files:
  packages/quereus/src/runtime/emit/dml-executor.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
  packages/quereus-store/test/isolated-store.spec.ts
prereq:
---

# Implementation summary (work already landed on this branch)

## Code changes

1. `packages/quereus/src/runtime/emit/dml-executor.ts` — UPDATE path (around the
   former line 499) now mirrors the INSERT path:

   ```ts
   const args: UpdateArgs = {
       operation: 'update',
       values: newRow,
       oldKeyValues: keyValues,
       // Pass undefined when there's no statement-level OR clause so the vtab
       // can fall back to per-constraint defaultConflict directives. The memory
       // module treats undefined as ABORT when no constraint default is set.
       onConflict: plan.onConflict,
       mutationStatement
   };
   ```

   (Was previously `onConflict: plan.onConflict ?? ConflictResolution.ABORT` —
   the coercion masked schema defaults.)

   The DELETE path retains `?? ConflictResolution.ABORT` for now — DELETE
   doesn't generally interact with column-level `defaultConflict` (no value
   coming in that could violate a column constraint), so the change wasn't
   needed for the ticket's acceptance and was left alone.

2. `packages/quereus/src/vtab/memory/layer/manager.ts` —
   `performUpdateWithPrimaryKeyChange` (around line 650) previously only
   handled `IGNORE` for a PK collision on UPDATE; for `REPLACE` it fell
   through to a UNIQUE-constraint error. Added the REPLACE branch:

   ```ts
   if (pkAction === ConflictResolution.REPLACE) {
       targetLayer.recordDelete(newPrimaryKey, existingRowAtNewKey);
       targetLayer.recordDelete(oldPrimaryKey, oldRowData);
       targetLayer.recordUpsert(newPrimaryKey, newRowData, null);
       return { status: 'ok', row: newRowData, replacedRow: existingRowAtNewKey };
   }
   ```

   This was a latent gap exposed once the executor stopped coercing to ABORT.

## Test coverage added

- `packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic`:
  appended sections 7 and 8 covering `update ... where id = old_id` against a
  PK declared `ON CONFLICT REPLACE` (silent replace) and `ON CONFLICT IGNORE`
  (silent no-op).
- `packages/quereus-store/test/isolated-store.spec.ts`: restored the two
  UPDATE-path cases that were dropped during the prior isolation ticket
  (REPLACE + IGNORE), replacing the explanatory `// UPDATE-path column-level
  defaultConflict is NOT honored` comment block.

The originally-listed `UPDATE OR ABORT` acceptance case was dropped: per
`docs/sql.md` § DML, Quereus deliberately does NOT support SQLite's
`UPDATE OR <action>` syntax. The parser rejects it with "Expected table name",
and an existing test (`42.1-returning-extras.sqllogic` § 7) pins that
behavior. Column-level REPLACE on UPDATE is therefore not overridable
statement-locally — which matches the documented model.

## Validation

- `yarn workspace @quereus/quereus test` — 2940 passing, 2 pending.
- `yarn workspace @quereus/store test` — 252 passing.
- `yarn workspace @quereus/quereus test --grep "29.1"` — 1 passing (sqllogic
  file with new cases 7 & 8).
- `yarn workspace @quereus/store test --grep "PK column-level"` — 5 passing
  (3 INSERT-path + 2 new UPDATE-path).

Store-mode run (`yarn test:store`) not exercised by this agent; left for
review or CI.

## TODO

- Verify the changes are present and complete.
- Move to review/.
