description: Run mutation testing as a manual long session; convert findings into real tests
dependencies: none
files:
  packages/quereus/src/planner/analysis/
  packages/quereus/src/runtime/emit/
  packages/quereus/src/func/builtins/
  packages/quereus/src/vtab/memory/
  packages/quereus/stryker.config.mjs  (to be created)
----
**This is a manual long-running session, NOT an automated test in CI.** Stryker mutates
source code and re-runs the test suite for each mutation — a single subsystem run takes
hours. The workflow is:

1. Run Stryker on one subsystem at a time
2. Review the surviving mutants (mutations that didn't cause any test to fail)
3. For each surviving mutant that represents a genuine test gap, **write a deterministic
   sqllogic or unit test** that kills it
4. Re-run the mutation session periodically as a baseline check
5. Never commit Stryker output as CI gates — commit the deterministic tests that resulted from
   analyzing it

The automated suite never runs Stryker. The mutation testing ticket exists to generate
concrete test additions, not to add a random-flake-prone CI step.

**Setup:**

- Add Stryker as a devDependency (`@stryker-mutator/core`, `@stryker-mutator/mocha-runner`,
  `@stryker-mutator/typescript-checker`)
- Create `stryker.config.mjs` with mocha runner pointed at the existing test harness
- Exclude generated/vendored files from the mutation surface
- Run via a script like `yarn mutation:subsystem analysis` that scopes mutation to one
  directory at a time
- Store session output outside CI (gitignored)

**Priority targets (run in this order):**

1. **`src/planner/analysis/`** — predicate analysis, constraint extractor, cardinality
   estimation, const evaluator. High leverage: a broken analysis produces silently wrong
   plans across many queries.

2. **`src/runtime/emit/`** — emitter correctness per node type. Any surviving mutant here
   means there's an operator behavior that no test actually verifies.

3. **`src/func/builtins/`** — function edge cases (string, math, datetime, json, aggregate).
   Large surface area; lots of small independent targets.

4. **`src/vtab/memory/`** — memory table index logic, scan layer, merge iterators. Bugs here
   corrupt data invisibly.

**Workflow for each session:**

1. Run Stryker on one directory: `yarn mutation:subsystem <dir>`
2. Open the HTML report and filter to "Survived" mutants
3. For each survivor, classify:
   - **Genuine gap** → write a deterministic test that fails on the mutation, passes on the
     original. Commit the test. Priority: sqllogic where possible, unit test otherwise.
   - **Equivalent mutant** (mutation produces semantically identical code) → add to an
     ignore list with a comment explaining why
   - **Infeasible** (mutation produces code that couldn't run, e.g., type-level) → let the
     type checker catch it; add to ignore list
4. Rerun the affected tests to confirm the new test catches the original mutation
5. Record session notes in the ticket (or a `mutation-sessions/` directory if sustained)

**Exit criteria per subsystem:**

- Target >= 85% mutation score (after filtering out equivalent/infeasible mutants)
- Every non-equivalent surviving mutant has either a new killing test or a documented reason
  for being ignored
- No regression in existing test pass rate

TODO:
- Install Stryker devDeps and create stryker.config.mjs
- Add `mutation:subsystem` script scoped to a directory argument
- Run mutation session on `src/planner/analysis/`; triage and add killing tests
- Run mutation session on `src/runtime/emit/`; triage and add killing tests
- Run mutation session on `src/func/builtins/`; triage and add killing tests
- Run mutation session on `src/vtab/memory/`; triage and add killing tests
- Document per-subsystem mutation scores and surviving-mutant ignore list
- Add note to docs/testing or zero-bug-plan linking mutation workflow
