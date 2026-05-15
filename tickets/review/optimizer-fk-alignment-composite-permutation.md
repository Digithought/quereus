---
description: Review the fix to `lookupCoveringFK` and `checkFkPkAlignment` that closes a soundness bug on composite-FK alignment checks. Previously both helpers verified only that each FK column's equi-partner was *some* parent PK column; they did not verify the *positional* pairing the FK actually declares. As a result, a permuted equi-pair set on a composite FK (e.g. `fa = b AND fb = a` against `FOREIGN KEY (fa, fb) REFERENCES p(a, b)`) was treated as covered, causing IND-existence folding (EXISTS / NOT EXISTS / semi-join / anti-join / inner-join elimination) to produce wrong results.
files:
  - packages/quereus/src/planner/util/ind-utils.ts            # lookupCoveringFK + import + doc
  - packages/quereus/src/planner/util/key-utils.ts            # checkFkPkAlignment + import + doc
  - packages/quereus/test/optimizer/ind-existence.spec.ts     # +2 misaligned-permutation tests
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts # +1 misaligned-permutation test
---

## What changed

### `lookupCoveringFK` (ind-utils.ts) and `checkFkPkAlignment` (key-utils.ts)

Both helpers used to walk `fk.columns` and accept the FK as covering whenever each FK column's equi-pair partner was in `pkColSet`. That's order-blind — for a 2-column PK, *both* PK indices live in `pkColSet`, so permuting the equi-pair set (e.g. swapping which child column equals which parent column) still passed.

The fix replaces that set-membership test with a positional comparison against the FK's declared `referencedColumns[i]`. For each FK column at index `i`, the equi-pair partner must equal exactly `referencedColumns[i]` — the parent column the FK actually references at that position. A defensive cross-check additionally requires every `referencedColumns[i]` to be in the PK set, so malformed FKs that reference non-PK columns can never be reported as IND on a PK.

### `resolveReferencedColumns` wiring

`fk.referencedColumns` is `Object.freeze([])` at CREATE TABLE time (deferred resolution; the parent's column names live in `fk.referencedColumnNames`). Reading the field directly returns an empty array, which would have made every alignment check fail. The fixed helpers call `resolveReferencedColumns(fk, parentSchema)` to materialize the actual parent-column indices, wrapped in a `try/catch` so a resolution failure (e.g. dangling ref name) skips the FK rather than throwing inside the optimizer.

### Tests added

- `ind-existence.spec.ts`:
  - "does NOT fold composite-FK EXISTS when equi-pairs are misaligned with the FK pairing" — predicate `p.a = c.fb AND p.b = c.fa` against `FOREIGN KEY (fa, fb) REFERENCES pcomp(a, b)`. Plan must keep a join op; result must be empty (no parent row matches the swapped pairing on the seeded data).
  - "does NOT fold composite-FK NOT EXISTS when equi-pairs are misaligned with the FK pairing" — same schema/data; NOT EXISTS must return all child rows.
- `rule-join-elimination.spec.ts`:
  - "does NOT eliminate INNER JOIN when composite FK equi-pairs are misaligned with the FK pairing" — same schema/data; plan must retain a join, result is the unfolded (empty) answer.

The existing canonical-permutation composite test at `ind-existence.spec.ts:180` ("folds composite-FK EXISTS regardless of equi-pair declaration order") still passes — it permutes only the *AST order* of the conjuncts, not the FK pairing itself, and the equiMap it builds is identical whether the user writes `p.a = c.fa AND p.b = c.fb` or `c.fb = p.b AND c.fa = p.a`.

## Validation run

- `yarn workspace @quereus/quereus run test --grep "IND-driven existence folding"` → 12 passing.
- `yarn workspace @quereus/quereus run test --grep "ruleJoinElimination"` → 13 passing.
- `yarn test` → all 3024 quereus tests pass (2 pending). The only failures in the monorepo run (`sample-plugins` Comprehensive Demo Plugin "supports delete" / "supports update") are **pre-existing on the base commit cb798c2e** — verified by re-running `sample-plugins` after `git stash` of these changes; both still failed. They are unrelated to FK alignment.
- `yarn workspace @quereus/quereus run lint` → clean (exit 0, no output).

`yarn test:store` was not run (per AGENTS.md it is reserved for store-specific diagnosis and the change touches no store code).

## Known gaps / things a reviewer should poke at

- **`resolveReferencedColumns` lazy resolution.** Wrapping the call in `try/catch` inside an optimizer rule is defensive — the schema is normally already validated by the time these helpers run, so the catch should be unreachable in practice. If a reviewer prefers an explicit invariant assertion over a silent skip, that's a defensible alternative; today we conservatively skip the FK on any resolution failure.
- **Single-column FK path is exercised broadly but not directly tested for the new positional rule.** Every non-composite FK test in the existing suites still passes (a 1-column FK can't be permuted), but there is no dedicated unit test asserting that a 1-column FK with a non-PK `referencedColumns` value (i.e. malformed FK) is rejected. That case is unreachable in normal SQL today (the parser/schema layer would not produce such a thing), so I didn't synthesize one — the defensive `pkColSet.has(refCols[i])` line guards against it. A unit test poking the helper with a hand-constructed `ForeignKeyConstraintSchema` would harden this further.
- **Doc tone.** Both helpers gained multi-line doc-comment updates explaining the positional rule and the malformed-FK defense. Verify they're not overlong relative to the rest of the file.
- **Other callers of `referencedColumns`.** A repo-wide grep for `fk.referencedColumns` confirms the field is read only in `schema.ts` (display) and the two helpers fixed here. Callers that need parent-column indices use `resolveReferencedColumns` (e.g. `runtime/foreign-key-actions.ts`). No other call site needed updating.

## Suggested adversarial probes

- Construct a 3-column composite FK in a test and try all six permutations of the equi-pair set against the predicate — only the canonical pairing should fold.
- Run a query where the FK references a UNIQUE constraint that is not the PK (e.g. `REFERENCES p(u)` where `u` has a UNIQUE index and `p` has a separate PK). The helpers correctly skip this case today via the `pkDef.length === fk.columns.length` and `pkColSet.has(refCols[i])` guards, but a regression test would lock it in.
- Confirm the `try/catch` around `resolveReferencedColumns` doesn't silently swallow real schema bugs in some upstream flow — does any code path build a `ForeignKeyConstraintSchema` whose `referencedColumnNames` references a column that legitimately doesn't exist on the parent at plan time?
