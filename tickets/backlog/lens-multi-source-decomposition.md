description: Multi-source n-way decomposition in the lens default mapper — generate the inlined effective body as a join across several basis relations (columnar split / EAV / column-family), with optional components outer-joined onto the row-identity anchor and mandatory (`not null`) components inner-joined, a shared key that may be a surrogate, and the singleton (`primary key ()`) existence-relation degenerate case. Extends the v1 single-source name aligner. Design source: `docs/lens.md` § "The Default Mapper".
prereq: lens-module-mapping-advertisement
files: docs/lens.md, packages/quereus/src/schema/lens-compiler.ts
----

## Use case

`lens-foundation-and-default-mapper` ships a single-source name-based aligner: one logical table → one basis table, projected by column name. The decided design in `docs/lens.md` is an n-way decomposition where a logical table maps to a *join* over multiple basis relations. This ticket builds that, consuming the module mapping advertisement protocol (`lens-module-mapping-advertisement`).

Three properties from `docs/lens.md` are load-bearing for correctness:

- **Optional components are outer-joined** onto the relation that establishes row identity (the preserved side); only mandatory (`not null`) components are inner-joined. Inner-joining everywhere silently drops rows missing an optional component.
- **The shared key need not be a logical key** — a module may join on a surrogate and carry the logical key as a value column. A surrogate is supplied at insert by a basis default and must be **evaluated once per logical row and threaded** across every branch of the fan-out so all members agree on identity (rides the mutation-context substrate from `view-updateability-phase-1`).
- **The empty key (singleton) is the degenerate case, not a special path** — `primary key ()` decomposes to a zero-column existence relation; the key-equi-join reduces to `left join ... on true`. The mandatory-column elision applies identically.

## What this ticket should specify

- How the aligner reads an advertisement and synthesizes the join (anchor selection, outer vs inner per nullability, key-equi-join construction).
- Surrogate generation + threading through the propagation path.
- Tests for: columnar split round-trip, optional-component preservation (row with a null optional column survives), singleton existence relation, surrogate-key insert reaching all branches with one resolved value.
