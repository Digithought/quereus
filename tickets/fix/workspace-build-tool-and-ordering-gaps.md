description: Several workspaces can't build under `yarn workspaces foreach -At` (clean topological build) — vscode/sample-plugins don't declare their build tools (esbuild/typescript) and sample-plugins/vscode lack the `@quereus/quereus` dependency edge; `yarn clean` also leaves stale tsbuildinfo that suppresses tsc emit
files: packages/quereus-vscode/package.json, packages/sample-plugins/package.json, package.json (root: clean script + esbuild/typescript hoist), packages/quoomb-cli/tsconfig.json

# Fix: workspace build-tool & ordering gaps blocking a clean full `-At` build

## Background

This is the follow-on to `quereus-plugin-loader-build-order`, which fixed cross-workspace
`@quereus/*` **dependency-ordering** for `yarn workspaces foreach -At ... run build` by
promoting build-time sibling imports from `peerDependencies`/`devDependencies` into
`dependencies`. That fix was validated across the engine + loader + isolation + store +
the four storage plugins + sync + sync-client + sync-coordinator + cli — they build cleanly
under `-At --jobs 1`.

While reviewing it, the *remaining* workspaces were found to still block a truly clean
full-monorepo `-At`/`foreach` build, for reasons **distinct** from dependency ordering.
These are pre-existing (they fail identically at HEAD) and were out of scope for the
ordering ticket, which deliberately excluded these packages from its repro.

## The actual problems

Under `yarn workspaces foreach ... run build` (and `cd packages/<x> && yarn build`), a
workspace's build script only gets *its own* declared binaries on `PATH`. Root-hoisted
devDependencies are **not** on a child workspace's script PATH under Yarn 4 here. So a
package whose `build` script invokes a bare tool it doesn't itself declare fails with
`command not found`.

1. **`quereus-vscode`** — `build` runs bare `esbuild ...` but `esbuild` is declared only in
   the **root** `package.json`. Result: `'esbuild' is not recognized ... command not found`
   (exit 127), even via `cd packages/quereus-vscode && yarn build`. Also: vscode's server
   imports `@quereus/quereus` at build time (value import `import { KEYWORDS }` in
   `server/src/handlers.ts`, plus `import('@quereus/quereus')`), but declares the engine only
   in `devDependencies` — so `-At` won't order the engine before vscode. Fix needs **both**:
   add `esbuild` (and confirm any other bare tools, e.g. it relies on root `esbuild`) as a
   workspace devDependency, and promote `@quereus/quereus` to `dependencies` (keep the
   bundled-app publish semantics in mind — vscode bundles via esbuild and packages with
   `--no-dependencies`, so `dependencies` here is purely for build ordering).

2. **`sample-plugins`** — `build` runs bare `tsc` but declares no `typescript`
   devDependency (only `rimraf`). Result: `'tsc' is not recognized ... command not found`
   (exit 127). Its plugin sources (`json-table/`, `string-functions/`, `custom-collations/`,
   `comprehensive-demo/` — note: not under `src/`) have **value** imports of
   `@quereus/quereus` (`VirtualTable`, `registerPlugin`, …) but the package declares **no**
   `@quereus/quereus` dependency at all. Fix needs **both**: add `typescript` as a
   devDependency, and add `@quereus/quereus` to `dependencies`.

3. **Stale `tsconfig.tsbuildinfo` survives `yarn clean`** — the root `clean` script removes
   `packages/*/dist` (+ vscode out dirs) but not package-root `*.tsbuildinfo` files. For
   packages whose `tsbuildinfo` lives outside `dist` (observed: `quoomb-cli`), `tsc
   --incremental` then sees an up-to-date buildinfo and **skips emit**, so a "clean" build
   produces no `dist/`. Deleting `packages/quoomb-cli/tsconfig.tsbuildinfo` then rebuilding
   emits correctly. Either extend the `clean` script to also remove stray `*.tsbuildinfo`,
   or relocate buildinfo into `dist/` (consistent with the packages that clean correctly).

## Not yet verified

- `quoomb-web` (vite) and `shared-ui` (storybook) were excluded from the build runs (heavy,
  and may have their own tool-declaration gaps). A full clean `-At` build over the *entire*
  workspace set should be confirmed once 1–3 are fixed.

## Acceptance

`yarn clean` followed by `yarn workspaces foreach -At --jobs 1 --exclude quereus-workspace
run build` exits 0 and produces `dist/` (or the package's build output) for **every**
workspace, including vscode, sample-plugins, quoomb-cli, quoomb-web, and shared-ui.
