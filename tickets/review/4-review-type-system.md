description: Systematic review of the type system (logical types, temporal types, registry)
dependencies: none
files:
  packages/quereus/src/types/builtin-types.ts
  packages/quereus/src/types/index.ts
  packages/quereus/src/types/json-type.ts
  packages/quereus/src/types/logical-type.ts
  packages/quereus/src/types/plugin-interface.ts
  packages/quereus/src/types/registry.ts
  packages/quereus/src/types/temporal-types.ts
  packages/quereus/src/types/validation.ts
----
Review the type system: logical/physical type separation, temporal type support, type registry, and validation.

Key areas of concern:
- Correctness of type coercion and comparison logic
- Temporal type edge cases (overflow, timezone, epoch boundaries)
- Registry thread safety and plugin type registration
- JSON type handling completeness
- Validation coverage for all type categories

Follow the review protocol in docs/review.md.
Trivial fixes may be applied directly; non-trivial findings become fix/ or plan/ tickets.
