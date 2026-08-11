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
3. **Bump `package.json` `version`** to the version being released, in
   its own commit or PR.
4. **Tag and publish a GitHub Release** named `v<version>` (e.g.
   `v0.1.0`) from `main`. Publishing the Release is the only trigger for
   `.github/workflows/publish.yml`.
5. **Automated pipeline runs, in order, and stops at the first failure:**
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
