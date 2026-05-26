description: Review the workspace build-tool & ordering fixes — esbuild/typescript build-tool declarations in vscode/sample-plugins, the `@quereus/quereus` dependency-edge promotions, and the `yarn clean` tsbuildinfo removal — that together unblock a clean full `-At` monorepo build.
prereq:
files: packages/quereus-vscode/package.json, packages/sample-plugins/package.json, package.json (root clean script), yarn.lock

# Review: workspace build-tool & ordering gaps

## What was changed

Three package-manifest / script edits, no source-code changes. Goal: make a from-clean full
`yarn workspaces foreach -At ... run build` succeed for **every** workspace (previously several
failed at HEAD — pre-existing, distinct from the already-landed `quereus-plugin-loader-build-order`
ordering fix).

Root-cause class: under Yarn 4 here, a child workspace's `build` script only gets its **own**
declared binaries on PATH (root-hoisted devDeps are not on a child's script PATH), so a bare
`esbuild`/`tsc` invocation fails with exit 127. Separately, a build-time **value** import of a
sibling `@quereus/*` package must live in `dependencies` (not dev/peer) for `-At` to order it first.

1. **`packages/quereus-vscode/package.json`**
   - Added `"esbuild": "^0.27.2"` to `devDependencies` (matches root; build:server/build:client
     invoke bare `esbuild`). Kept build-time only — vscode bundles and packages with
     `--no-dependencies`, so the published `.vsix` is unchanged.
   - Moved `"@quereus/quereus": "workspace:^"` from `devDependencies` → `dependencies` (server has
     build-time value imports, e.g. `KEYWORDS` in `server/src/handlers.ts`), so `-At` builds the
     engine first.

2. **`packages/sample-plugins/package.json`**
   - Added `"typescript": "^5.9.3"` to `devDependencies` (the `build` script runs bare `tsc`,
     previously undeclared).
   - Added a new `dependencies` block with `"@quereus/quereus": "workspace:^"` (plugin sources
     have value imports of `VirtualTable`, `registerPlugin`, …).

3. **Root `package.json` `clean` script** — added `packages/*/*.tsbuildinfo` to the `rimraf` list.
   `tsconfig.base.json` sets `incremental` + `composite`; quoomb-cli, quoomb-web, and shared-ui
   emit `tsconfig.tsbuildinfo` at package root (outside `dist`). The old clean removed only `dist`,
   so a "clean" rebuild saw an up-to-date buildinfo and tsc skipped emit. Now removed uniformly.

`yarn.lock`: 3 added lines only (the new dep edges resolve to already-present npm/workspace
versions — no new downloads).

## Validation performed (all green)

- `yarn install` — completed with only pre-existing peer-dependency warnings (ts-node/@types/node,
  storybook, @quereus/isolation) that are unrelated to this change.
- `yarn clean` then full `yarn workspaces foreach -At --jobs 1 --exclude quereus-workspace run build`
  → **exit 0**. Build output confirmed present for vscode (`server/dist/server.js`,
  `client/out/extension.js`), sample-plugins (`dist`), quoomb-cli (`dist`), quoomb-web (`dist`),
  shared-ui (`dist`). Full build incl. vite + vite-lib ran in ~33s wall-clock (not long-running here).
- `yarn clean` then re-checked: `packages/*/*.tsbuildinfo` are removed (was the bug).
- `yarn workspace quereus-vscode run test` → 31 passing.
- `yarn workspace @quereus/sample-plugins run test` → 34 passing.

## Reviewer focus / known gaps

- **quoomb-web & shared-ui needed no extra fixes** — the ticket flagged them as "not yet verified"
  (possible own tool-declaration gaps). They built clean under `-At` after fixes 1–3, so no further
  changes were made. Worth a sanity glance that their `build` scripts only use tools they declare
  (they passed, so this is confirmation not suspicion).
- **shared-ui `build` is the vite lib build, not storybook.** Storybook is a separate script
  (`build-storybook`), so it was never part of the acceptance `run build` and is untested here.
- **The `dependencies` vs `devDependencies` distinction for `@quereus/quereus` is the load-bearing
  part.** If a reviewer "tidies" either promotion back into devDependencies, `-At` ordering breaks
  again. The vscode promotion is safe for publishing only because of `--no-dependencies`; confirm
  that flag is still present in vscode's `package`/`pub:*` scripts (it is, at time of writing).
- No source code changed; risk surface is build/dependency-graph only. No `.pre-existing-error.md`
  was filed — nothing unrelated surfaced.

## Acceptance (met)

`yarn clean` + `yarn workspaces foreach -At --jobs 1 --exclude quereus-workspace run build` exits 0
and produces build output for every workspace, including vscode, sample-plugins, quoomb-cli,
quoomb-web, and shared-ui. ✓
