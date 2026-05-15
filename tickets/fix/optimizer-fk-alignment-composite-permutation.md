---
description: `lookupCoveringFK` (and the older `checkFkPkAlignment`) only verify that the equi-partner of each FK column is *some* primary-key column, not the specific `fk.referencedColumns[i]` the FK declares it should map to. For composite FKs, this silently accepts a misaligned permutation of equi-pairs and the IND-existence / join-elimination rules will then unsoundly fold an `EXISTS` / `NOT EXISTS` / inner join whose ON clause does not actually match what the FK guarantees.
files:
  - packages/quereus/src/planner/util/ind-utils.ts        # lookupCoveringFK — fix the alignment check
  - packages/quereus/src/planner/util/key-utils.ts        # checkFkPkAlignment — same fix
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts  # consumer (inner-join elim)
  - packages/quereus/src/planner/rules/subquery/rule-anti-join-fk-empty.ts
  - packages/quereus/src/planner/rules/subquery/rule-semi-join-fk-trivial.ts
  - packages/quereus/test/optimizer/ind-existence.spec.ts             # add the regression test
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts     # extend with permutation negative case
---

## Repro

Schema:

```sql
CREATE TABLE pcomp (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE ccomp (id INTEGER PRIMARY KEY,
  fa INTEGER NOT NULL,
  fb INTEGER NOT NULL,
  FOREIGN KEY (fa, fb) REFERENCES pcomp(a, b));
INSERT INTO pcomp VALUES (1, 10), (2, 20);
INSERT INTO ccomp VALUES (100, 1, 10), (101, 2, 20);
```

Misaligned query (semantically *not* what the FK guarantees):

```sql
-- Asks: is there a pcomp row whose (a, b) equals ccomp's (fb, fa)?
SELECT id FROM ccomp c WHERE EXISTS (
  SELECT 1 FROM pcomp p WHERE p.a = c.fb AND p.b = c.fa);
```

Correct answer: empty set (no pcomp row has `(a, b) = (10, 1)` or `(20, 2)`).

Current (buggy) answer after IND fold: `[100, 101]` — the semi-join rule folds
to `L` because `lookupCoveringFK` walks `fk.columns = [fa, fb]` and only checks
that each FK col's equi-partner is *some* PK col. Both `fa`'s partner (`b`) and
`fb`'s partner (`a`) are in pcomp's PK column set, so the check returns a match
even though the FK declares `fa → a, fb → b`.

The same shape unsoundly fires for NOT EXISTS, inner-join elimination, and the
new aggregate-over-join entrypoint.

## Root cause

Both `lookupCoveringFK` (new) and `checkFkPkAlignment` (pre-existing) iterate
`fk.columns` and check `pkColSet.has(equiMap.get(fkColIdx))`, but never
compare `equiMap.get(fkColIdx)` against the *specific* `fk.referencedColumns[i]`
that the FK declaration says `fk.columns[i]` should map to. For single-column
PKs the check is incidentally correct (only one PK col exists); for composite
PKs it is too permissive.

## Fix sketch

Change the check from "FK col's equi-partner is in the PK set" to "FK col's
equi-partner equals `fk.referencedColumns[i]`". Iterate `fk.columns` paired
with `fk.referencedColumns`:

```ts
for (let i = 0; i < fk.columns.length; i++) {
  const partner = equiMap.get(fk.columns[i]);
  if (partner !== fk.referencedColumns[i]) { aligned = false; break; }
}
```

Apply the same fix in `checkFkPkAlignment` (key-utils.ts) for the `ruleJoinElimination`
inner-join branch and the diagnostic `ruleJoinKeyInference` consumer.

## Tests

Add negative cases:

- Misaligned composite EXISTS (above) → result must equal the unfolded answer
  (empty for the data above); plan may or may not retain the join, but result
  correctness is the contract.
- Misaligned composite NOT EXISTS → result must include all child rows (the
  misaligned predicate matches no parent, so NOT EXISTS is universally true).
- Misaligned composite inner join elimination via Project — must NOT fold.

## Scope notes

- The reach of the bug is limited to *composite* FKs where the user expresses
  the equi-pairs in a non-canonical column permutation. Single-column FKs are
  unaffected. Composite-FK queries with the canonical alignment (the common
  case) continue to fold as before; the existing "composite-FK both equi-pair
  declaration orders" test in `ind-existence.spec.ts` covers operand-side swaps
  but does *not* exercise this misalignment — that test passes either way
  because operand swap doesn't change the child→parent column mapping.
- Found during review of `optimizer-ind-existence-reasoning`; the new IND rules
  inherit the bug from `checkFkPkAlignment`, which has shipped this way for
  some time.
