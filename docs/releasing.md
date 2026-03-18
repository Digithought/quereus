# Release Process

## Overview

Quereus uses [bumpp](https://github.com/antfu/bumpp) for version bumping and follows semver.
Tags use the `v` prefix (e.g. `v1.0.0`).

## Prerequisites

- All CI checks pass on `main`
- `yarn build` succeeds
- `yarn test` passes

## Steps

### 1. Ensure a clean working tree

```bash
git status          # no uncommitted changes
git pull origin main
```

### 2. Bump versions

`bumpp` updates all `package.json` files, tags, and pushes. You commit manually first.

```bash
# Interactive — prompts for version type (major / minor / patch / prerelease)
yarn bump

# Or specify the release type directly
yarn bump --release patch
yarn bump --release minor
yarn bump --release major
```

`bumpp` will:
1. Update `version` in all `package.json` files (recursive)
2. Create an annotated tag: `v{version}`
3. Push the commit and tag to `origin`

It will **not** commit — you do that yourself before running bump:

### 3. Commit

Commit all pending changes (including any work beyond the version bump) before running `yarn bump`:

```bash
git add -A
git commit -m "v{version}"
```

Then `yarn bump` will tag and push.

### 4. Publish to npm

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
yarn bump --release prerelease --preid rc    # e.g. 1.1.0-rc.0
yarn bump --release prerelease --preid beta  # e.g. 1.1.0-beta.0
```

Publish prereleases with a dist-tag so they don't become `latest`:

```bash
yarn workspaces foreach -A --no-private npm publish --access public --tag next
```

## Hotfix

1. Branch from the release tag: `git checkout -b hotfix/v1.0.1 v1.0.0`
2. Apply the fix, commit
3. Bump: `yarn bump --release patch`
4. Publish
5. Merge back into `main`

## Version Alignment

All packages in the monorepo share the same version number. The `--recursive` flag in the bump script ensures this stays in sync. Do not manually edit version numbers in individual `package.json` files.

## Checklist

- [ ] CI green on `main`
- [ ] `yarn build` succeeds
- [ ] `yarn test` passes
- [ ] Commit: `git add -A && git commit -m "v{version}"`
- [ ] `yarn bump` (interactive version selection — tags and pushes)
- [ ] `npm publish` (with dry-run first)
- [ ] GitHub release created
