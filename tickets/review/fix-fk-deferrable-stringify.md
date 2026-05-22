description: Review the FK-deferrability stringifier work. `ForeignKeyClause.deferrable` / `initiallyDeferred` now round-trip through `parse → stringify → parse` for both column-level and table-level foreign keys. A small helper de-duplicates the FK clause tail across the two call sites.
files:
  packages/quereus/src/emit/ast-stringify.ts
  packages/quereus/test/emit/ast-stringify.spec.ts
  packages/quereus/test/emit-roundtrip-property.spec.ts
----

## What changed

`packages/quereus/src/emit/ast-stringify.ts`

- Removed the FK-deferrability TODO from the file header comment block.
- Extracted `foreignKeyClauseTail(fk: AST.ForeignKeyClause): string` (ast-stringify.ts:1066-1080) which emits `references TBL[(cols)] [on delete …] [on update …] [[not] deferrable [initially deferred|immediate]]`. The deferrability tail is the new behavior — everything before it is lifted from the prior inline emission unchanged.
- The two FK call sites now delegate to the helper instead of inlining the tail:
  - Column-level FK (`columnConstraintsToString`, ast-stringify.ts:1005-1009).
  - Table-level FK (`tableConstraintsToString`, ast-stringify.ts:1044-1049), which still emits `foreign key (<cols>) ` ahead of the helper output.
- `initiallyDeferred` is nested inside the `deferrable !== undefined` guard. This mirrors the parser (`parser.ts:3688-3710`) which can only set `initiallyDeferred` after consuming a DEFERRABLE/NOT DEFERRABLE token — emitting `initially …` without a preceding `[not] deferrable` would produce un-parseable SQL.

## Tests

`packages/quereus/test/emit/ast-stringify.spec.ts` — new `Foreign-key deferrability` describe block (ast-stringify.spec.ts:131-169) pinning four canonical clauses at both column-level and table-level (8 cases total), via post-reparse AST assertions on `foreignKey.deferrable` / `foreignKey.initiallyDeferred`:

- `DEFERRABLE`
- `DEFERRABLE INITIALLY DEFERRED`
- `DEFERRABLE INITIALLY IMMEDIATE`
- `NOT DEFERRABLE`

`packages/quereus/test/emit-roundtrip-property.spec.ts` — added `fkDeferrabilityArb` (emit-roundtrip-property.spec.ts:87-95) covering the seven legal shapes:

- `{}` (no deferrability clause)
- `DEFERRABLE`
- `DEFERRABLE INITIALLY DEFERRED`
- `DEFERRABLE INITIALLY IMMEDIATE`
- `NOT DEFERRABLE`
- `NOT DEFERRABLE INITIALLY DEFERRED`
- `NOT DEFERRABLE INITIALLY IMMEDIATE`

Both the column-level FK arbitrary (emit-roundtrip-property.spec.ts:193-208) and the table-level FK arbitrary (emit-roundtrip-property.spec.ts:303-323) now include `deferrability: fkDeferrabilityArb` and propagate the fields onto the generated `ForeignKeyClause`. The 'deferrable' keyword was already in the existing identifier reservation list (emit-roundtrip-property.spec.ts:54) so no other arbs needed updating.

## Validation

- `yarn workspace @quereus/quereus run test --grep "AST round-trip"` — 47 passing (was 39: +8 unit cases; the two property-test suites continue to pass with the broader arb).
- `yarn workspace @quereus/quereus run build` — exit 0.

## Suggested review focus

- The `foreignKeyClauseTail` extraction should be behavior-preserving for the pre-deferrability portion. The previous inline code at the two call sites emitted the same `references … on delete … on update …` text — worth a quick eyeball against git history of `ast-stringify.ts` to confirm no semantic drift in identifier quoting / column-list formatting.
- The `deferrable !== undefined` guard relies on the parser only producing the inner `initiallyDeferred` field when a DEFERRABLE/NOT DEFERRABLE token was consumed. If a future producer (e.g. a builder or a different parser path) sets `initiallyDeferred` without `deferrable`, the stringifier will silently drop it. Acceptable today because no such producer exists; flagging in case reviewers want a defensive assert.
- `ColumnConstraint` and `TableConstraint` themselves also expose `deferrable` / `initiallyDeferred` fields (ast.ts:432-433, 446-447). The parser writes only onto the nested `ForeignKeyClause` (parser.ts:3716) — the constraint-level fields are unused by the current parser path, so the stringifier ignores them. If reviewers prefer the stringifier to also honor (or warn about) constraint-level fields for forward-compat, that's a follow-up ticket.
- The property arb covers the seven shape combinations as constants (`fc.oneof(fc.constant({}), ...)`) rather than generating each field independently. This is intentional — independent generation would produce the illegal `{ initiallyDeferred: true }` (no `deferrable`) shape, which the parser cannot produce and the stringifier intentionally drops.
