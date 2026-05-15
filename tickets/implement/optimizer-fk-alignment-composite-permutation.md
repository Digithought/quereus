---
description: Fix `lookupCoveringFK` and `checkFkPkAlignment` so composite-FK alignment checks compare the equi-partner of each FK column against the *specific* `fk.referencedColumns[i]`, not just any PK column. Today both helpers silently accept a permuted equi-pair set on composite FKs, causing IND-existence folding (EXISTS / NOT EXISTS / semi-join / anti-join / inner-join elimination) to fold queries whose ON clause does not match what the FK actually guarantees.
files:
  - packages/quereus/src/planner/util/ind-utils.ts        # lookupCoveringFK — fix alignment check (~line 81)
  - packages/quereus/src/planner/util/key-utils.ts        # checkFkPkAlignment — same fix (~line 398)
  - packages/quereus/test/optimizer/ind-existence.spec.ts             # add misaligned-permutation regression tests
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts     # add misaligned-permutation negative case
---

## Background

A composite FK declared as `FOREIGN KEY (fa, fb) REFERENCES pcomp(a, b)` guarantees `(child.fa, child.fb) ⊆ (parent.a, parent.b)` — that is, `fa → a` *and* `fb → b`, in that pairing. It does NOT guarantee `(fa, fb) ⊆ (b, a)`. The optimizer's IND/FK helpers were treating the latter as if the FK covered it.

Both `lookupCoveringFK` (ind-utils.ts) and `checkFkPkAlignment` (key-utils.ts) walk `fk.columns` and check `pkColSet.has(equiMap.get(fkColIdx))`. For a 2-column PK both PK columns are in `pkColSet`, so any equi-pair permutation passes. For 1-column PKs the bug is invisible.

The new IND-existence rules inherit this from `checkFkPkAlignment` (which has shipped this way for a while). The reach is limited to composite FKs where the user expresses equi-pairs in a non-canonical permutation — but in that case the rules unsoundly fold and return wrong results.

## Fix

Replace the `pkColSet.has(...)` check with a positional comparison against `fk.referencedColumns[i]`:

```ts
let aligned = true;
for (let i = 0; i < fk.columns.length; i++) {
  const partner = equiMap.get(fk.columns[i]);
  if (partner !== fk.referencedColumns[i]) {
    aligned = false;
    break;
  }
}
```

`fk.referencedColumns` is `ReadonlyArray<number>` (see `packages/quereus/src/schema/table.ts:373`) — column indices in the parent table positionally paired with `fk.columns`. The `pkColSet` membership invariant is preserved indirectly: if the FK references a non-PK column the FK is malformed and the alignment-as-PK check was already false in spirit; the existing length guard (`fk.columns.length !== parentSchema.primaryKeyDefinition.length`) plus the per-position match against `fk.referencedColumns[i]` will fail in that case. We can leave the `pkColSet` construction in place as a defensive cross-check, or drop it — preference is to drop it since the per-position check subsumes it (every `fk.referencedColumns[i]` value must equal the corresponding equi-pair partner, and the partner must be the FK's declared parent col; if the FK declaration itself isn't a PK reference, no equi-pair set can satisfy it because we already required `fk.columns.length === parentSchema.primaryKeyDefinition.length` AND we'd need an additional check that `fk.referencedColumns` is in fact the PK set). Keep one defensive assertion that every `fk.referencedColumns[i]` is in `pkColSet` so we never fold against a non-PK FK.

Apply identical changes to both helpers.

## Tests to add

### `packages/quereus/test/optimizer/ind-existence.spec.ts`

Append the following cases inside the `describe('IND-driven existence folding', ...)` block, after the existing composite-FK test (~line 207):

- **Misaligned composite EXISTS does NOT fold.** Same `pcomp` / `ccomp` schema as the existing composite test, but EXISTS predicate is `p.a = c.fb AND p.b = c.fa`. Data: `pcomp` has `(1,10),(2,20)`; `ccomp` has `(100,1,10),(101,2,20)`. The result must be empty (no pcomp row has `(a,b) = (10,1)` or `(20,2)`). Plan assertion: a join op must survive (the rule abstained). Result assertion: empty rowset.
- **Misaligned composite NOT EXISTS returns all child rows.** Same schema and data. Predicate `p.a = c.fb AND p.b = c.fa`. Result must include all child rows (`[100, 101]`), since the misaligned predicate matches no parent.

### `packages/quereus/test/optimizer/rule-join-elimination.spec.ts`

Append a misaligned inner-join elimination case after the existing INNER JOIN tests:

- **Does NOT eliminate INNER JOIN when composite FK equi-pairs are misaligned.** Same `pcomp` / `ccomp` schema. Query: `SELECT id FROM ccomp c JOIN pcomp p ON p.a = c.fb AND p.b = c.fa`. Result must equal the unfolded answer (empty, given misaligned data). Plan must retain a join op (assertion: `joinCount(...) > 0`). Without the fix the rule folds to `c` and returns `[100, 101]`.

## TODO

- Update `lookupCoveringFK` in `packages/quereus/src/planner/util/ind-utils.ts` to use positional `fk.referencedColumns[i]` comparison instead of `pkColSet.has(partner)`. Keep one assertion-style check that each `fk.referencedColumns[i]` is in `pkColSet` (defensive — a malformed FK referencing non-PK columns must not be folded against).
- Update `checkFkPkAlignment` in `packages/quereus/src/planner/util/key-utils.ts` with the same change.
- Update the doc comments on both helpers — they currently say "the FK col's equi-partner is in the PK set" (or equivalent). Change to "equi-partner equals the FK's declared `referencedColumns[i]`".
- Add the misaligned composite EXISTS + NOT EXISTS regression tests in `packages/quereus/test/optimizer/ind-existence.spec.ts`.
- Add the misaligned composite inner-join elimination regression test in `packages/quereus/test/optimizer/rule-join-elimination.spec.ts`.
- Run the targeted suites: `yarn workspace @quereus/quereus run test --grep 'IND-driven existence folding'` and `... --grep 'ruleJoinElimination'`. Then run the full `yarn test` to confirm no regressions (the existing canonical-alignment composite test at ind-existence.spec.ts:180 must still pass).
- If `yarn lint` is part of the standard validation, run it on `packages/quereus`.
