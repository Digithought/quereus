description: Fix Yarn `-At` topological build order by declaring runtime/build-time workspace deps in `dependencies` (was peer/dev-only) across plugin-loader + 7 sibling packages
files: packages/plugin-loader/package.json, packages/quereus-isolation/package.json, packages/quereus-store/package.json, packages/quereus-sync/package.json, packages/quereus-plugin-leveldb/package.json, packages/quereus-plugin-indexeddb/package.json, packages/quereus-plugin-react-native-leveldb/package.json, packages/quereus-plugin-nativescript-sqlite/package.json, yarn.lock

# Review: plugin-loader (and siblings) build-order fix

## What the bug was

`yarn workspaces foreach -At ... run build` (the `-At` = `--all --topological`) only
follows `dependencies` edges when ordering workspaces. Several `@quereus/*` packages
imported sibling workspaces (`@quereus/quereus`, `@quereus/store`, `@quereus/isolation`)
at build time but declared them **only** in `peerDependencies` + `devDependencies`.
Yarn therefore treated them as leaves, scheduled them before the engine's `dist/` existed,
and `tsc` failed with `TS2307: Cannot find module '@quereus/quereus'`. `plugin-loader`
was simply the first leaf attempted, so the whole batch aborted in <1s.

The local `yarn build` script never hit this because it hand-orders packages
(`build:engine` → `build:loader` → …). The failure only surfaces for consumers running
the standard `-At` topological build (e.g. a multi-repo stack-build script).

## What changed

Applied the ticket's recommended **option 1** (promote to `dependencies`, keep
`peerDependencies`) — but extended beyond `plugin-loader`, because fixing only it leaves
`-At` failing on the *next* leaf. Every package with a build-time cross-workspace import
now declares it in `dependencies`. The redundant `"*"` `devDependencies` entries that the
new `dependencies` entries supersede were removed.

| Package | Added to `dependencies` | Why |
| --- | --- | --- |
| `@quereus/plugin-loader` | `@quereus/quereus` | runtime `registerPlugin` import |
| `@quereus/isolation` | `@quereus/quereus` | runtime value imports (`VirtualTable`, `MemoryTableModule`, …) |
| `@quereus/store` | `@quereus/quereus`, `@quereus/isolation` | runtime value imports (`QuereusError`, `IsolationModule`, …) |
| `@quereus/sync` | `@quereus/quereus`, `@quereus/store` | store: runtime values; quereus: type-only (still needs `.d.ts` built first) |
| `@quereus/plugin-leveldb` | `@quereus/quereus`, `@quereus/store` | store: runtime values; quereus: type-only |
| `@quereus/plugin-indexeddb` | `@quereus/quereus`, `@quereus/store` | same |
| `@quereus/plugin-react-native-leveldb` | `@quereus/quereus`, `@quereus/store` | same |
| `@quereus/plugin-nativescript-sqlite` | `@quereus/quereus`, `@quereus/store` | same |

`peerDependencies` blocks were left intact everywhere, so the host-provides-the-engine
contract for published plugins is preserved. `sync-coordinator`, `quoomb-cli`,
`quereus-sync-client`, `quoomb-web` already declared these in `dependencies` — untouched.

`yarn install` was run to refresh `yarn.lock` (committed as part of this change).

## Validation performed

- `yarn install` → exit 0. Only the **pre-existing** `YN0002` peer warnings remain
  (`@types/node`/`ts-node`, `storybook`, `@quereus/isolation` for sync requested by
  quoomb-web/sync-client) — these were called out in the ticket's "Additional observation"
  and are *not* introduced here.
- **The actual repro**: `yarn clean` then
  `yarn workspaces foreach -At --jobs 1 --exclude quereus-workspace --exclude @quereus/quoomb-web --exclude @quereus/shared-ui --exclude quereus-vscode --exclude @quereus/sample-plugins run build`
  → **exit 0**, full `dist/` produced for engine + every previously-failing leaf
  (engine 384 js files, plugin-loader/isolation/store/sync/plugins all built). Before the
  fix this aborted in <1s on plugin-loader. `foreach` aborts non-zero on any sub-build
  failure, so exit 0 across the run proves correct ordering.
- `yarn test` → **exit 0**, 0 failing (3591 + ~840 across other packages passing, 9
  pending). The `Error: boom` / `batch write failed` / `iterate failed` lines in output are
  intentional error-path test fixtures whose suites report passing.

## Things for the reviewer to scrutinize

- **Scope expansion beyond the literal ticket.** The ticket title/summary scoped the fix to
  `plugin-loader`, flagging other packages as "not blocking but related." I expanded to all
  8 affected packages because a clean `-At` build (the ticket's reproduction + stated impact:
  "Anything trying to build the quereus monorepo from a clean state") fails on the next leaf
  otherwise. Confirm this broader scope is acceptable rather than wanting it split out.
- **`dependencies` + `peerDependencies` duplication on the *plugin* packages.** For the four
  storage plugins (leveldb/indexeddb/rn/ns), `peerDependencies` is arguably the more correct
  *publish* semantics (host provides the engine/store; plugin shouldn't bundle its own copy).
  Promoting to `dependencies` is what makes `-At` order them correctly, and the peer entry is
  kept so the contract still advertises. But a published plugin now lists `@quereus/quereus`
  /`@quereus/store` as hard deps — on `npm install` a consumer could get nested copies if the
  host's version is incompatible. `workspace:^` resolves to the matching version on publish,
  and npm/yarn dedupe when compatible, so in practice this is benign — but it's a publish-
  semantics change worth a deliberate sign-off. (AGENTS.md "don't worry about backwards
  compatibility yet" lowered my bar here.) An alternative the reviewer may prefer: keep plugins
  peer-only and instead change build invocations to `--topological-dev`, accepting that
  external consumers must know to use that flag. The ticket explicitly rates that lower.
- **Type-only over-declaration.** `@quereus/quereus` is imported only via `import type` in
  `sync` and the four plugins. It's in `dependencies` purely so `tsc` can resolve its `.d.ts`
  during the topological build; at runtime it's tree-shaken out. Slightly over-declares the
  runtime graph but is necessary for `-At` (there is no TS `paths`/project-reference mapping —
  confirmed `tsconfig.base.json` has none — so each package resolves siblings via their built
  `dist/`, making build order mandatory for type-only imports too).
- **Not exhaustively verified**: `quereus-vscode` (declares `@quereus/quereus` in
  `devDependencies` only, no peer), `shared-ui`, `sample-plugins`, and `quoomb-web` were
  *excluded* from the topological build run above (heavy vite/storybook builds, and nothing
  depends on them so the graph stays satisfiable). If a fully clean `-At` build over the
  *entire* workspace set is a requirement, these top-level consumers should be spot-checked —
  vscode in particular has a type/build dependency on the engine declared only as a devDep.
- The pre-existing `YN0002` peer warnings (under-declared `@quereus/isolation` peer for
  `sync` consumers, etc.) are untouched and remain a separate cleanup if desired.
