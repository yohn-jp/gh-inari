# Release governance

This document describes the exact process and controls that gate an
`npm publish` of `gh-inari`. It does not duplicate what the workflow
files already enforce — it explains the sequence and the reasoning, and
points at the executable authority for each rule.

## Source of truth

The exact machine-enforced rules live here, not in this document:

- [`.github/workflows/publish.yml`](../../.github/workflows/publish.yml) —
  build, verify-version, pack, smoke-test, publish pipeline.
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) — format,
  lint, typecheck, test, build, package-contents checks that run on every
  PR and must be green before merge.
- [`.github/workflows/governance.yml`](../../.github/workflows/governance.yml) —
  branch-name and linked-Issue contract for PRs
  ([`scripts/validate-pr.mjs`](../../scripts/validate-pr.mjs),
  [`scripts/validate-branch-name.mjs`](../../scripts/validate-branch-name.mjs)).
- [`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml) —
  static analysis on PRs and `main`.
- [`CONTRIBUTING.md`](../../CONTRIBUTING.md) — Issue-first workflow,
  branch naming, commit convention.
- [`SECURITY.md`](../../SECURITY.md) — vulnerability reporting and trust
  boundaries.

If this document and a workflow file disagree, the workflow file wins.

## Versioning

Pre-1.0 (`0.x`): breaking changes may land between minor versions.
`package.json` `version` is the single source of truth for what gets
published — the `publish` workflow refuses to run if it does not match
the release tag.

## Release sequence

1. **Land changes through PR.** Every change to `main` goes through a
   pull request with a linked Issue and a passing `CI` + `Governance` +
   `CodeQL` run (see `CONTRIBUTING.md`). No direct pushes to `main`.
2. **Update the release notes.** Add `docs/releases/<version>.md`
   (this file's sibling) in the same PR or a follow-up PR, following the
   structure of [`0.1.0.md`](0.1.0.md): Summary, Highlights, Fixed,
   Behavioral changes, Upgrade instructions, Breaking changes, Known
   limitations.
3. **Bump every file that encodes the package version**, in its own
   commit or PR:
   - `package.json` `version` — the authority `publish.yml` checks
     against the release tag.
   - `.codex-plugin/plugin.json` `version` — must equal `package.json`
     `version` exactly.
   - `.agents/plugins/marketplace.json` `plugins[0].source.version` —
     must equal `^<package.json version>` exactly.

   `pnpm run verify` (via `scripts/run-package-suite.mjs`) checks all
   three are consistent and fails loudly if any is missed — run it
   before opening the release PR, not just before tagging.

4. **Cut the tag from the release PR's own merge commit, not from
   whatever `main` happens to be at tag time.** If any other PR merges
   to `main` between the release PR merging and the tag being pushed,
   the tag will silently point at the wrong commit unless you pin it
   explicitly. Verify before pushing the tag or creating the Release:

   ```bash
   git log -1 --format='%H %s' <release-merge-commit-sha>
   ```

   Create the GitHub Release with an explicit `--target <sha>` (the
   release PR's merge commit), not the default `main` HEAD:

   ```bash
   gh release create v<version> --target <release-merge-commit-sha> \
     --title "gh-inari v<version>" --notes-file docs/releases/<version>.md
   ```

   After creation, confirm the pushed tag resolved to that exact
   commit (`git log -1 v<version>`) before relying on the release.

5. **Publishing the Release is the only trigger for
   `.github/workflows/publish.yml`.**
6. **Automated pipeline runs, in order, and stops at the first failure:**
   - `pnpm install --frozen-lockfile`
   - `pnpm run typecheck`
   - `pnpm test`
   - `pnpm run build`
   - **Version check**: the release tag (with `v` stripped) must equal
     `package.json` `version`, or the run fails before anything is
     published.
   - `npm pack` — the tarball is built once and reused by every
     downstream job (no rebuild-then-publish drift).
   - **Smoke test the packed tarball** on a matrix of OS/Node versions
     (`ubuntu-latest` × Node 22/24): install the exact tarball into an
     isolated directory, run it as `gh-inari` and as a discovered `gh
inari` extension.
   - **Publish**, only after every smoke-test matrix leg is green.
     Publishing uses npm Trusted Publishing (OIDC) — no long-lived npm
     token is stored in repository secrets. The `npm` GitHub Environment
     must already be configured as a Trusted Publisher on npmjs.com for
     this exact repo and workflow file, or the publish job fails.
   - The publish step checks whether `<name>@<version>` is already on
     the registry first and skips publishing if so (idempotent re-runs
     do not error).
   - Any `npm warn publish` output is treated as a failure even if `npm
publish` itself exits 0.

## What this buys

- A published version is always exactly what CI, smoke tests, and
  CodeRabbit/PR review saw — the tarball built in `build` is the same
  artifact installed in `smoke-test` and published in `publish`.
- A version can never be published without release notes existing in
  the release tag's commit history, because the tag is cut from `main`
  after the release-notes PR merged.
- No human ever holds a publish credential; only the `npm` Environment's
  Trusted Publisher binding can push to the registry, scoped to this
  workflow file.

## Local pre-flight

Before tagging a release, run the same checks CI runs:

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

`pnpm run verify` runs format-check, lint, typecheck, test,
`governance:actions` (pinned-Action-SHA validation), and the full
pack/install/smoke-test cycle (`test:package`) — the same coverage the
`publish` workflow depends on, runnable before a tag exists.

## Worked example: the 0.10.0 / 0.10.1 incident

`v0.10.0`'s release commit bumped `package.json` only and left
`.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json`
pinned to `0.9.0`. A later, unrelated docs PR (#199) merged to `main`
before the `v0.10.0` tag was pushed, and the tag was cut from `main`'s
then-current HEAD instead of the release commit — so it pointed at the
docs commit, not the release. The `publish` workflow's smoke-test stage
caught the version drift and failed, so `gh-inari@0.10.0` was never
published to npm; the tag and Release remain as an immutable record of
the failed attempt.

`v0.10.1` (PR #203, see [`0.10.1.md`](0.10.1.md)) fixed the drift by
syncing all three version-bearing files and tagging directly from the
release PR's merge commit with `gh release create --target <sha>`. This
is exactly the sequence in steps 3–4 above — follow it and this class of
incident is caught by `pnpm run verify` before a tag ever exists.
