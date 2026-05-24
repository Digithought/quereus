description: Resolve the design conflict between the `zipByKey` combinator's shared-key-attribute-ID contract and the attribute-provenance invariant. As shipped, no validly-constructed `AsyncGatherNode({ kind: 'zipByKey' })` can pass `validatePhysicalTree`, so the node is un-plannable. Decide between special-casing the provenance validator vs. redesigning `keyAttrs` to per-branch column refs with a freshly-minted output key id.
prereq:
files: packages/quereus/src/planner/nodes/async-gather-node.ts, packages/quereus/src/runtime/emit/async-gather.ts, packages/quereus/src/planner/analysis/attribute-provenance.ts, packages/quereus/src/planner/validation/plan-validator.ts, packages/quereus/test/runtime/async-gather.spec.ts
----

## Problem

The `zipByKey` combinator (landed in `parallel-async-gather-zip-by-key`) is defined
so that `keyAttrs` is a list of **attribute IDs that every branch's key column
carries verbatim** — the equated key columns across branches share one ID, and
that shared ID is what the output forwards (output key columns sit at index
`0..K-1`).

`AsyncGatherNode.validateZipByKey` enforces this: every id in `keyAttrs` must
resolve in *every* branch's attribute layout, or construction throws
`key attribute <id> not found in branch <i>`.

But the attribute-provenance surface
(`computeAttributeProvenance`, run by `validatePhysicalTree`) enforces the
opposite: **each attribute id must be *originated* by exactly one relational
node.** Two independent (uncorrelated) sibling branches each originating the
shared key id is exactly the "originated at two distinct nodes" error.

The two requirements are mutually exclusive:

- To satisfy `validateZipByKey`, the key id must appear in ≥ 2 branches.
- To satisfy provenance, the key id must be originated in exactly one place.

Independent branches don't share an origin node (the `visited`-dedup in the
provenance walk only spares a literal same-node DAG instance, which uncorrelated
branches never are). Therefore **every validly-constructed zipByKey node throws
in `validatePhysicalTree`** — and the optimizer validates physical trees, so the
node cannot survive in a real plan.

This was missed at implement time because the construction unit tests reuse the
same `Attribute` object across both mock branches (so they exercise getType /
emitter layout) but never run `validatePhysicalTree` on a zipByKey node. The
review added `it.skip('zipByKey passes full validation (BLOCKED: ...)')` in
`test/runtime/async-gather.spec.ts` as a regression marker — un-skip it once this
ticket lands.

The runtime emitter (`runZipByKey`) and the merge semantics are correct and
fully tested; this ticket is purely about making the node legal in a validated
physical tree.

## Knock-on: the recognition rule's stated approach is invalid

`tickets/backlog/parallel-async-gather-zip-by-key-rule.md` says the rule will
"arrange the per-branch projections so [each branch's key column carries the
shared ID]". That is precisely the provenance violation above — it cannot work
as written. That ticket already `prereq`s this work (see below); its "What it
produces" section must be revised once the representation is chosen.

## Options to weigh (pick at plan/fix time, get human sign-off — touches the just-landed provenance surface)

**Option A — per-branch key refs + minted output key id (preferred starting point).**
Change the combinator to carry per-branch key column references instead of a
single shared ID list:
```
{ kind: 'zipByKey', branchKeyRefs: readonly (readonly number[])[] }   // or attr-id lists, distinct per branch
```
Branches keep their own distinct key-column attribute IDs (provenance-clean).
The gather **originates** a fresh attribute id for each of the K output key
columns (it genuinely mints a merged column — the value is "branch0's key, or
branch1's key, …, whichever row is present"). `getAttributes()` then has the
gather as the origin of the K key ids and forwards each branch's non-key ids.
This is provenance-clean by construction and matches the model's intent
(origination vs forwarding). Cost: wider node interface, and `keyAttrs`-based
APIs (`getZipByKeyIndices`, the emitter's collation derivation) must take the
per-branch refs.

**Option B — teach the provenance validator that a zipByKey gather legitimizes a
shared key id across its branches.** Add a narrow exception so the shared key id
consumed by a `zipByKey` parent is not flagged as a double origin. Smaller diff,
but it weakens the "originated exactly once" invariant and special-cases a
single node type inside a general analysis — likely undesirable given the
provenance surface just landed deliberately to *tighten* this. Document the
exception precisely if chosen.

## Acceptance

- A zipByKey node built the way the recognition rule would build it passes
  `validatePhysicalTree`.
- Un-skip the regression test in `test/runtime/async-gather.spec.ts`
  (`zipByKey passes full validation`) and make it assert no-throw.
- Update the construction unit tests to build provenance-legal branches (distinct
  per-branch ids) under the chosen representation, not shared `Attribute` objects.
- `docs/runtime.md` § AsyncGatherNode updated to describe the chosen key
  representation (the current text describes the shared-ID contract).
- Revise `tickets/backlog/parallel-async-gather-zip-by-key-rule.md`'s
  "What it produces" to match.
