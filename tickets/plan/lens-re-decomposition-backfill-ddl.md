description: Engine-emitted backfill DDL for lens re-decompositions — when a basis change is a pure re-decomposition (split/merge that introduces no information the prior basis lacks), the schema differ generates the backfill by running the new lens `get` over the prior basis, instead of delegating the whole backfill to the application. Only backfills needing genuinely new data remain the application's responsibility. Design source: `docs/lens.md` § "Deployment Is a Compile Step".
prereq: lens-foundation-and-default-mapper
files: docs/lens.md, packages/quereus/src/schema/schema-differ.ts, packages/quereus/src/runtime/emit/schema-declarative.ts
----

## Use case

`lens-foundation-and-default-mapper` ships with the asymmetric-removal rule (logical removals never drop basis storage) but leaves all data-effecting backfills to the application, exactly as the declarative-schema pipeline already supports. `docs/lens.md` identifies a useful subset that the engine can generate itself:

> When the new basis can be populated by running the new lens `get` over the prior basis — a pure re-decomposition such as a split or merge that introduces no information the prior basis lacks — the differ can emit the backfill as generated DDL, the same shape as the one-shot derivation of computed/generated columns.

The obligation thus splits cleanly: **re-decompositions the engine generates from the lens itself; genuinely new information the application supplies.**

## What this ticket should specify

- How the differ classifies a basis diff as a pure re-decomposition (no new information) vs needing application data.
- The generated backfill DDL shape (running the new lens `get` over the prior basis), reusing the deployed-basis hash + diff machinery.
- The deploy-summary surface that tells the developer which backfills were engine-generated and which they must supply.

Second-phase deployment polish — not required for the lens layer to be usable.
