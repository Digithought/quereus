# Release Process

## Overview

Quereus uses [bumpp](https://github.com/antfu/bumpp) for version bumping and follows semver.
Tags use the `v` prefix (e.g. `v1.0.0`).

## Branching Strategy

- **`main`** — Stable release branch. Always reflects the latest published release. Only receives merges from `dev` (for releases) or hotfix branches.
- **`dev`** — Active development branch. All feature branches and day-to-day work target `dev`. This is the default branch for pull requests.

## Prerequisites

- All CI checks pass on `dev`
- `yarn build` succeeds
- `yarn test` passes

## Steps

### 1. Merge `dev` into `main`

When ready to cut a release, merge `dev` into `main`:

```bash
git checkout main
git pull origin main
git merge dev
```

### 2. Ensure a clean working tree

```bash
git status          # no uncommitted changes
```

### 3. Bump versions

`bumpp` updates `package.json` files, commits, tags, and pushes in one step.

```bash
# Interactive — prompts for version type (major / minor / patch / prerelease)
yarn bump -r

# Or specify the release type directly
yarn bump -r --release patch
yarn bump -r --release minor
yarn bump -r --release major
```

The `-r` (recursive) flag bumps all workspace `package.json` files together.

`bumpp` will:
1. Update `version` in all `package.json` files
2. Create a commit: `v{version}`
3. Create an annotated tag: `v{version}`
4. Push the commit and tag to `origin`

### 4. Publish to npm

After the tag is pushed:

```bash
# Dry-run first
yarn workspaces foreach -A --no-private npm publish --dry-run

# Publish for real
yarn workspaces foreach -A --no-private npm publish --access public
```

Only public (non-private) packages are published. Private packages (workspace root, internal tools) are skipped automatically.

### 5. Create a GitHub release (optional)

```bash
gh release create v{version} --generate-notes
```

This auto-generates release notes from commits since the previous tag.

## Prerelease / RC

```bash
yarn bump -r --release prerelease --preid rc    # e.g. 1.1.0-rc.0
yarn bump -r --release prerelease --preid beta  # e.g. 1.1.0-beta.0
```

Publish prereleases with a dist-tag so they don't become `latest`:

```bash
yarn workspaces foreach -A --no-private npm publish --access public --tag next
```

## Hotfix

1. Branch from the release tag: `git checkout -b hotfix/v1.0.1 v1.0.0`
2. Apply the fix, commit
3. Bump: `yarn bump -r --release patch`
4. Publish
5. Merge back into both `main` and `dev`

## Version Alignment

All packages in the monorepo share the same version number. The `-r` flag to `bumpp` ensures this stays in sync. Do not manually edit version numbers in individual `package.json` files.

## Checklist

- [ ] CI green on `dev`
- [ ] `yarn build` succeeds
- [ ] `yarn test` passes
- [ ] Merge `dev` into `main`
- [ ] `yarn bump -r` (interactive version selection)
- [ ] Verify tag: `git tag -l -n1 | tail -1`
- [ ] `npm publish` (with dry-run first)
- [ ] GitHub release created
