description: Add concurrencyMode declaration to VirtualTableModule so the runtime knows which modules tolerate concurrent reads (or writes) on a shared connection. Memory vtab flips to fully-reentrant; everything else stays serial by default.
prereq: parallel-driver-context-fork, parallel-runtime-fork-test-harness
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/memory/, packages/quereus/src/runtime/parallel-driver.ts, packages/quereus-plugin-leveldb/, packages/quereus-plugin-indexeddb/, docs/architecture.md
----

## Goal

Extend `VirtualTableModule` with a declarative concurrency contract:

```ts
readonly concurrencyMode: 'serial' | 'reentrant-reads' | 'fully-reentrant';
```

Default is `serial` — preserves existing behavior. `ParallelDriver` reads this declaration when scheduling sibling branches that touch the same module:

- **`serial`** — driver serializes vtab calls per connection. Defeats parallelism for that module, but safe.
- **`reentrant-reads`** — concurrent `query()` calls allowed on a single connection; writes serialize.
- **`fully-reentrant`** — anything goes.

## Why this lands alongside parallel-driver-context-fork, not before

The driver's first consumer (`parallel-eager-prefetch-node`, N=1) does not need concurrent vtab calls — only one inner scan at a time. Concurrency-mode only matters when N≥2 branches both want a vtab. Splitting it into its own ticket keeps the driver ticket's surface area small and lets this one move at its own pace per plugin.

## Memory vtab disposition

Memory vtab → `fully-reentrant`. Its query path is read-only against an immutable snapshot per transaction; concurrent reads are safe by construction. Flip it on as part of this ticket so the next ticket (`parallel-fanout-lookup-join`) has a vtab to test against without depending on remote plugins.

## Plugin vtabs

Leave all plugins at default `serial` for now:

- `quereus-plugin-leveldb`
- `quereus-plugin-indexeddb`
- `quereus-plugin-react-native-leveldb`
- `quereus-plugin-nativescript-sqlite`
- `sample-plugins/`

Per-plugin upgrades are separate, follow-up tickets — each plugin owner inspects their cursor model and picks the right mode. Typical answer: `reentrant-reads` if the underlying handle supports independent cursors; `serial` if cursors share state.

## Driver-side enforcement

When the driver detects two active branches both holding cursors against the same module-connection pair and the module's mode is `serial`, it must either:

- Acquire a separate connection per branch (preferred when the module supports cheap connection creation), or
- Serialize the branches' calls through a per-connection lock.

The plan-stage agent picks the default. This decision interacts with the connection-lifecycle code in `vtab/connection.ts`.

## Out of scope

- Per-statement override of the module's declared mode.
- Auto-detection (probing the module). The contract is always declarative.
- Writer-concurrency design — `fully-reentrant` writes is a deeper contract change touching the transaction layer; out of scope here.
- Per-plugin upgrades beyond memory.
