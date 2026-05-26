description: Fix workspace build-tool & ordering gaps blocking a clean full `-At` build — declare esbuild/typescript build tools in vscode/sample-plugins, add the `@quereus/quereus` dependency edge so `-At` orders the engine first, and make `yarn clean` remove stray root-level `*.tsbuildinfo` so tsc re-emits
prereq: 
files: packages/quereus-vscode/package.json, packages/sample-plugins/package.json, package.json (root clean script), packages/quoomb-cli/tsconfig.json (+ tsconfig.base.json context)

# Implement: workspace build-tool & ordering gaps blocking a clean full `-At` build

## Background

Follow-on to `quereus-plugin-loader-build-order` (already landed), which fixed cross-workspace
`@quereus/*` dependency-*ordering* under `yarn workspaces foreach -At ... run build`. The
remaining workspaces still block a truly clean full-monorepo `-At` build for reasons distinct
from dependency ordering. These fail identically at HEAD (pre-existing) and were out of scope
for the ordering ticket.

Root cause class: under Yarn 4 here, a child workspace's `build` script only gets *its own*
declared binaries on `PATH` — root-hoisted devDependencies are **not** on a child's script
PATH. So a `build` script invoking a bare tool (`esbuild`, `tsc`) it doesn't itself declare
fails with `command not found` (exit 127). Separately, build-time *value* imports of a sibling
`@quereus/*` package must be in `dependencies` (not `dev`/`peer`) for `-At` to order it first.

## Verified findings (all confirmed against current tree)

1. **`packages/quereus-vscode/package.json`** — `build:server`/`build:client` invoke bare
   `esbuild`, but `esbuild` is declared only in the **root** `package.json` (`^0.27.2`), not in
   vscode. vscode already declares `typescript` + `rimraf`. Its server has build-time **value**
   imports of `@quereus/quereus` (e.g. `import { KEYWORDS }` in `server/src/handlers.ts`, plus
   `import('@quereus/quereus')`) but the engine is in `devDependencies` only.
   - **Fix:** add `esbuild` (`^0.27.2`, match root) to vscode `devDependencies`; move
     `@quereus/quereus` from `devDependencies` → `dependencies`.
   - **Publish note:** vscode bundles via esbuild and packages with `--no-dependencies` (see
     `package`/`pub:*` scripts), so promoting the engine to `dependencies` is purely for build
     ordering and does not change the published `.vsix` contents. Keep `esbuild` in `devDependencies`
     (build-time only).

2. **`packages/sample-plugins/package.json`** — `build` runs bare `tsc` but declares no
   `typescript` (only `rimraf`). Its plugin sources (`json-table/`, `string-functions/`,
   `custom-collations/`, `comprehensive-demo/` — at package root, not under `src/`; the
   `tsconfig.json` `include` is `*/src/**/*.ts` + `*/index.ts`) have **value** imports of
   `@quereus/quereus` (`VirtualTable`, `registerPlugin`, …) but the package declares **no**
   `@quereus/quereus` dependency.
   - **Fix:** add `typescript` (`^5.9.3`, match root/siblings) to `devDependencies`; add
     `@quereus/quereus` (`workspace:^`) to `dependencies`.

3. **Stale `*.tsbuildinfo` survives `yarn clean`** — `tsconfig.base.json` sets
   `incremental: true` + `composite: true`. Three packages emit their buildinfo at **package
   root** (not inside `dist`): confirmed present at `packages/quoomb-cli/tsconfig.tsbuildinfo`,
   `packages/quoomb-web/tsconfig.tsbuildinfo`, `packages/shared-ui/tsconfig.tsbuildinfo`. The
   root `clean` script removes only `packages/*/dist` (+ vscode out dirs), so a "clean" rebuild
   sees an up-to-date buildinfo and tsc **skips emit** → no `dist/`.
   - **Fix (preferred — covers all three uniformly):** extend the root `clean` script to also
     remove `packages/*/*.tsbuildinfo`. Current:
     `rimraf packages/*/dist packages/quereus-vscode/client/out packages/quereus-vscode/server/dist`
     → add `packages/*/*.tsbuildinfo`.
   - (Relocating buildinfo into `dist/` per-package via `tsBuildInfoFile` is an alternative but
     touches more configs; prefer the single clean-script change unless it proves insufficient.)

## Not yet verified — confirm during this ticket

- `quoomb-web` (vite) and `shared-ui` (storybook) were excluded from prior build runs (heavy,
  possible own tool-declaration gaps). After fixes 1–3, run the full acceptance build below and
  patch any further bare-tool/dependency-edge gaps the same way (declare the tool as a workspace
  devDependency; promote build-time `@quereus/*` value imports to `dependencies`). If `quoomb-web`
  or `shared-ui` turn out to need substantial additional work, document and split into a separate
  implement ticket rather than ballooning this one.

## Acceptance

`yarn clean` followed by
`yarn workspaces foreach -At --jobs 1 --exclude quereus-workspace run build`
exits 0 and produces `dist/` (or the package's build output) for **every** workspace —
including vscode, sample-plugins, quoomb-cli, quoomb-web, and shared-ui.

Note for the agent: a full clean `-At` build over the entire workspace set (incl. vite +
storybook) may be long-running. Stream output (`... | Tee-Object`/`tee`) and watch the idle
timeout. If wall-clock routinely exceeds ~10 min, run the lighter subset (vscode +
sample-plugins + quoomb-cli) to validate fixes 1–3 directly, document the deferral of the
full web/storybook build for CI/human, and keep going.

## TODO

- [ ] `packages/quereus-vscode/package.json`: add `"esbuild": "^0.27.2"` to `devDependencies`; move `"@quereus/quereus": "workspace:^"` from `devDependencies` to `dependencies`.
- [ ] `packages/sample-plugins/package.json`: add `"typescript": "^5.9.3"` to `devDependencies`; add `"@quereus/quereus": "workspace:^"` to a new `dependencies` block.
- [ ] Root `package.json`: extend `clean` script to also remove `packages/*/*.tsbuildinfo`.
- [ ] Run `yarn install` to materialize the new workspace dependency edges, then verify `yarn install` reports no errors and lockfile changes are sane.
- [ ] Run the acceptance build (full `-At`; fall back to the vscode+sample-plugins+quoomb-cli subset if web/storybook is too long-running) and confirm `dist`/build output for each touched workspace. Patch any further gaps surfaced for quoomb-web/shared-ui per the guidance above.
- [ ] Sanity-check `yarn test` for the touched packages still passes (vscode + sample-plugins have mocha specs).
- [ ] If any failure surfaces that is plainly unrelated to these changes, record it in `tickets/.pre-existing-error.md` per the workflow rules rather than chasing it here.
