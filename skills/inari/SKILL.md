---
name: inari
description: |
  Governed GitHub Issue, pull request, Change, and template workflows for this
  repository. Use when creating or editing an Issue/PR that must satisfy
  repository governance, or when inspecting/repairing an existing Issue/PR's
  governance state. Prefer this over raw `gh` for those operations.
---

# Inari

Inari (`inari`, installed from the `gh-inari` npm package) is this
repository's governed GitHub CLI. It turns Issue Forms and pull request
templates into deterministic typed contracts, validates structured input,
renders canonical Markdown, and mutates GitHub only after contract,
input, and rendered artifact have all passed validation.

`inari` is the canonical executable for agents and humans. `gh-inari` is the
direct npm package alias and `npx --yes gh-inari` is the deterministic
fallback.

## When to use

Prefer `inari` over raw `gh` for:

- Creating a governed Issue or PR (schema, validate, render, create).
- Reading the governance classification of an existing Issue or PR.
- Bounded discovery of existing Issues or pull requests by state, page, limit,
  and (for pull requests) exact head/base branch.
- Repairing an invalid or non-normalized Issue or PR.
- Reconciling an existing Issue's native parent (sub-issue) or blocked-by
  relationships instead of hand-editing relationship prose.
- Syncing semantic template contracts to their GitHub-native projections.
- Issuing, inspecting, reviewing, or stopping a governed Change through the
  semantic Change command surface.

Raw `gh` remains fine for anything outside that surface (e.g. project
searching, commenting, or other operations Inari does not govern). For bounded
Issue/PR discovery, use Inari's `issue list` and `pr list` commands. Inari
itself falls through to real `gh` for any command it does not own, so it is
always safe to prefer `inari` first.

## Issue versus Implementation

An ordinary Issue is a problem, request, or decision record. Keep ordinary
Issue authoring lightweight; do not require session path scopes, branch/base
binding, targeted checks, postconditions, or authorization before the Issue is
ready to exist.

When a concrete implementation session is being prepared, create a separate
Implementation Issue with the governed template:

```bash
inari issue create --template implementation
```

The Implementation owns the one-session objective, selected design, explicit
scope, constraints, verification, and execution dependencies. Use the
normative [Issue and Implementation governance contract](../../docs/IMPLEMENTATION_CONTRACT.md)
for the lifecycle and relationship rules.

The current `impl` namespace has exactly these operations:

```text
inari impl plan <number>
inari impl show <number>
inari impl validate <number>
inari impl authorize <number>
inari impl inspect <number>
```

`plan` is a non-authoritative preview, `show` and `inspect` project current
state, `validate` is non-mutating validation, and `authorize` produces the
existing Core authorization evidence without a GitHub mutation. Each command
uses the current metadata options `--repository <repository>`, `--from
<path>`, and repeatable `--capability <id>` (with global `--help` and `--json`
controls). There is no `impl create`, `impl edit`, `impl start`, `impl complete`,
or `impl ready` command.

Where GitHub supports native parent/sub-issue relationships, use that provider
relationship as canonical for the Issue hierarchy. A prose `Parent:` or
`Parent Epic:` line is compatibility guidance for older artifacts only; it
does not authorize or trigger historical reparenting.

## How to proceed

Do not guess the workflow steps or flags here. Ask Inari directly:

```bash
inari skill              # list bounded operational playbooks (scenarios)
inari skill <scenario>   # print one playbook's exact workflow and invariants
inari issue --help       # exact Issue subcommand syntax
inari pr --help          # exact PR subcommand syntax
inari change --help      # exact Change subcommand syntax
inari template --help    # exact template subcommand syntax
```

`inari skill` is the authoritative, versioned source for scenario playbooks
(authoring an Issue/PR, inspecting governance state, repairing an invalid
artifact, and related flows). This file intentionally does not duplicate
those playbooks or any leaf-command flags — they drift independently of this
static file, so always resolve them live through the commands above.
