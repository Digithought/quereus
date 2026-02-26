description: Move implicit runtime coercion into the planner as explicit conversion nodes, enabling the runtime to rely on strong type guarantees for fast comparisons.
dependencies: none
files: src/util/coercion.ts, src/runtime/emit/binary.ts, src/runtime/emit/between.ts, src/planner/nodes/scalar.ts, src/types/builtin-types.ts
----

## Problem

The runtime currently applies `coerceForComparison` at execution time when comparing values of mixed type categories (e.g., INTEGER vs TEXT). This is a SQLite-compatibility behavior that conflicts with the stated strict typing principle ("no implicit coercion between incompatible types"). It also prevents the runtime from fully exploiting known types for fast-path comparisons — the generic path must speculatively coerce on every invocation.

## Design

Shift coercion responsibility from the runtime to the planner. When the planner builds a `BinaryOpNode` (or `BetweenNode`) and detects cross-category operands (one numeric, one textual), it should wrap the appropriate operand in an explicit conversion node (e.g., `CastNode` or a `ScalarFunctionCallNode` for `integer()` / `real()`). After this transformation, both sides of every comparison have matching type categories at plan time, and the runtime can unconditionally use the fast comparison path.

### Key changes

**Planner** — When building comparison or BETWEEN expressions, if operand types are in different categories and one side is textual while the other is numeric, insert an explicit conversion node on the textual side. The conversion function should match the numeric side's type (INTEGER → `integer()`, REAL → `real()`). This mirrors what a user would write explicitly: `age = integer('25')`.

**Runtime binary.ts** — Once all comparisons are guaranteed same-category at plan time, the generic coercion path (`buildGenericComparisonRun`) can be simplified. The temporal check may still need its own path, but `coerceForComparison` calls can be removed from comparison emission.

**Runtime between.ts** — Currently applies coercion unconditionally without checking plan-time types. After planner handles coercion insertion, this can use the same fast path as binary comparisons.

**coercion.ts** — `coerceForComparison` can be deprecated/removed from comparison contexts. `coerceForAggregate` and `coerceToNumberForArithmetic` are separate concerns and should be assessed independently (they may also benefit from planner-inserted conversions).

**Documentation** — Update types.md to accurately describe the explicit conversion behavior. The "Type Coercion in Comparisons" section I added needs rewriting to reflect the planner-based approach. The README mention should be updated to say conversions are made explicit at plan time.

## TODO

- [ ] In the planner's comparison/BETWEEN expression building, detect cross-category operand types and wrap the textual operand in a conversion node targeting the numeric side's type
- [ ] Verify that the conversion node produces the correct `getType()` so the emitter sees same-category types
- [ ] Remove `coerceForComparison` calls from `binary.ts` generic comparison path
- [ ] Add plan-time type checking to `between.ts` (matching `binary.ts` fast-path pattern) and remove its unconditional coercion
- [ ] Assess `coerceForAggregate` and `coerceToNumberForArithmetic` — determine if these should also move to planner-inserted conversions (may be a separate task)
- [ ] Add sqllogic tests for cross-category comparisons: `integer_col = '42'`, `text_col = 42`, `? = ?` with mixed param types, BETWEEN with mixed types
- [ ] Update types.md "Type Coercion in Comparisons" section and README mention
- [ ] Verify no performance regression via performance sentinels
