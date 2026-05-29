description: Module mapping advertisement protocol — the surface a virtual-table module exposes to tell the lens default mapper how its basis relations decompose a logical table (e.g. "these five basis tables are a columnar decomposition sharing key `id`", or "this is an EAV triple store, here is how to reconstruct a logical row"). Lets exotic storage (columnar, EAV, column-family) be aligned without the developer hand-authoring the join. Design source: `docs/lens.md` § "The Default Mapper".
prereq: lens-foundation-and-default-mapper
files: docs/lens.md, packages/quereus/src/schema/lens-compiler.ts, packages/quereus/src/vtab/module.ts
----

## Use case

The v1 default mapper (lands in `lens-foundation-and-default-mapper`) aligns a logical table to a single basis table purely by name. That only works when the basis surfaces logical column names in a single relation. Real storage modules decompose differently:

- **Columnar split** — one logical table spread across several basis tables sharing a key.
- **EAV / triple store** — generic `(entity, attribute, value)` rows where no basis column carries the logical column's name.
- **Column-family layouts** — value columns named generically.

For these, name/type/structure matching is insufficient and the module must be the alignment source. `docs/lens.md` makes the advertisement **load-bearing in both directions**:

- **`get`** — the advertisement tells the aligner the fan-out shape and which basis relation(s) back each logical column, so the mapper can synthesize the n-way join (with optional components outer-joined, mandatory ones inner-joined).
- **`put`** — it tells propagation the same fan-out shape and the shared key, so an insert through the generated lens reaches every member of the decomposition, and a shared surrogate key is evaluated once per logical row and threaded across every branch.

## What this ticket should specify

- The shape of the advertisement a module exposes (a method/descriptor on the module interface) and how the lens compiler consumes it as an *alternative or supplement* to name matching.
- How the advertised shared key is carried (logical key vs surrogate) and the "evaluate-once-and-thread" requirement for surrogate generators.
- How an explicit `declare lens` override composes with (and can correct) an advertised mapping.

Multi-source n-way decomposition default mapping (`lens-multi-source-decomposition`) depends on this protocol.
