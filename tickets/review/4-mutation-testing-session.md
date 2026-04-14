description: Mutation testing infrastructure + killing tests across 4 subsystems
dependencies: none
files:
  packages/quereus/stryker.config.mjs
  packages/quereus/.mocharc.stryker.cjs
  packages/quereus/register-cjs-compat.mjs
  packages/quereus/mutation-subsystem.mjs
  packages/quereus/test/planner/predicate-normalizer.spec.ts
  packages/quereus/test/optimizer/expression-fingerprint.spec.ts (modified)
  packages/quereus/test/optimizer/binding-collector.spec.ts
  packages/quereus/test/optimizer/const-pass.spec.ts
  packages/quereus/test/logic/100-predicate-normalization-edge-cases.sqllogic (modified)
  packages/quereus/test/logic/101-builtin-mutation-kills.sqllogic
  packages/quereus/test/logic/104-emit-mutation-kills.sqllogic
  packages/quereus/test/logic/105-vtab-memory-mutation-kills.sqllogic
  docs/zero-bug-plan.md (updated with session results)
  .gitignore (added stryker exclusions)
----

## What was built

**Stryker mutation testing infrastructure:**
- `stryker.config.mjs` with mocha runner, typescript checker, and per-run `--mutate` scoping
- `mutation-subsystem.mjs` script with aliases (`analysis`, `emit`, `builtins`, `memory`)
- `yarn mutation:subsystem <alias>` runs a targeted mutation session
- Output is gitignored; only deterministic killing tests are committed

**Killing tests (140 net new tests, 1728 → 1868):**

| Subsystem | Tests added | Key coverage gaps filled |
|-----------|------------|------------------------|
| planner/analysis | 139 (unit + integration) | OR-to-IN collapse paths, De Morgan, comparison inversion, expression fingerprinting, binding collection, constant folding |
| runtime/emit | ~40 sqllogic assertions | cast null passthrough, bigint filter truthiness, negative/null limit-offset, null arithmetic, unary edge cases |
| func/builtins | ~157 sqllogic assertions | Null guards for scalar/string/aggregate/conversion functions, edge cases (empty strings, zero, NaN) |
| vtab/memory | ~164 sqllogic assertions | IS NULL on NOT NULL column, index planning, composite PK, savepoints, ALTER TABLE, DESC indexes |

## Testing / validation

- Full test suite: 1868 passing, 2 pending, 0 failures
- Typecheck: clean (`tsc --noEmit`)
- No regressions in existing tests

## Usage

Run mutation testing per-subsystem:
```bash
cd packages/quereus
yarn mutation:subsystem analysis    # src/planner/analysis/
yarn mutation:subsystem emit        # src/runtime/emit/
yarn mutation:subsystem builtins    # src/func/builtins/
yarn mutation:subsystem memory      # src/vtab/memory/
```

Baseline mutation scores documented in `docs/zero-bug-plan.md` §6.
