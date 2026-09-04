---
name: inari
description: |
  Governed GitHub Issue, pull request, and template workflows for this
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

`inari` is the canonical executable for agents and humans. `gh inari` remains
the GitHub CLI extension compatibility path; `gh-inari` is the direct package
executable and `npx --yes gh-inari` is the deterministic fallback.

## When to use

Prefer `inari` over raw `gh` for:

- Creating a governed Issue or PR (schema, validate, render, create).
- Reading the governance classification of an existing Issue or PR.
- Repairing an invalid or non-normalized Issue or PR.
- Syncing semantic template contracts to their GitHub-native projections.

Raw `gh` remains fine for anything outside that surface (e.g. listing,
searching, commenting, or other operations Inari does not govern). Inari
itself falls through to real `gh` for any command it does not own, so it is
always safe to prefer `inari` first.

## How to proceed

Do not guess the workflow steps or flags here. Ask Inari directly:

```bash
inari skill              # list bounded operational playbooks (scenarios)
inari skill <scenario>   # print one playbook's exact workflow and invariants
inari issue --help       # exact Issue subcommand syntax
inari pr --help          # exact PR subcommand syntax
inari template --help    # exact template subcommand syntax
```

`inari skill` is the authoritative, versioned source for scenario playbooks
(authoring an Issue/PR, inspecting governance state, repairing an invalid
artifact, and related flows). This file intentionally does not duplicate
those playbooks or any leaf-command flags — they drift independently of this
static file, so always resolve them live through the commands above.
