---
description: Make collation registry per-Database instead of global
dependencies: none
priority: 3
---

# Per-Database collation registry

## Problem

Collations are currently stored in a module-level global registry (`Map`) in the comparison utilities. This means collation registration is implicitly shared across all `Database` instances in the same JS runtime.

This runs against Quereus’s general pattern of instance-local configuration/state and makes multi-tenant scenarios brittle:

- A plugin registering a collation affects other `Database` instances unexpectedly.
- Collation registration order becomes observable global state.
- It is hard to reason about lifecycle (register/unregister) and test isolation.

## Desired behavior

- Each `Database` instance owns its own collation registry.
- `db.registerCollation(name, func)` only affects that `db`.
- Planning/runtime should resolve collation functions against the `Database` instance (or schema/search-path context) rather than a global singleton.

## Notes

- Collations are on the hot path (ORDER BY, DISTINCT, comparison). The per-db design should preserve fast-path performance (e.g., pre-resolved function pointers on plan nodes/instructions).
- Ensure plugin APIs remain straightforward for authors.

