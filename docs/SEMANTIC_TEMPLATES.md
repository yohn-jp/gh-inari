# Semantic template authority

Migrated repositories keep editable template contracts under `.github/inari/`. GitHub-native files under `.github/ISSUE_TEMPLATE/` and `.github/PULL_REQUEST_TEMPLATE.md` are generated projections and must not be edited directly.

The canonical machine format is JSON. An Issue Form is stored under `.github/inari/issues/<id>.json`. A repository with a single pull-request template uses `.github/inari/pull-request.json`; a repository with multiple pull-request templates uses `.github/inari/pull-requests/<id>.json` instead (plural directory, one file per template). Only files at these exact paths are discovered by `template list`/`template sync`; any other location is written but silently ignored. A contract contains `version`, `kind`, `id`, `name`, optional native metadata, and ordered semantic `sections`. Input sections declare an `id`, type (`string`, `enum`, `array`, or `checklist`), label, requiredness, choices, and constraints. Pull-request headings and fixed documentation are represented only by bounded `headingLevel`, `placeholder`, and documentation section values.

## Issue and Implementation authoring

Ordinary Issue contracts record a problem, request, or decision. Architecture,
Bug, Feature, Research, and Maintenance forms remain usable without a session
plan, execution path scopes, branch/base binding, targeted checks,
postconditions, or authorization.

The `implementation` Issue contract is the separate one-session execution
contract. Use it when implementation is being prepared, and keep its
objective, non-goals, selected design, scopes, constraints, prerequisites,
verification, base, and dependencies in that contract. Creating or editing an
Implementation does not itself authorize or start a session; the current
`impl` command surface and #572 authorization evidence define that boundary.
See [`IMPLEMENTATION_CONTRACT.md`](./IMPLEMENTATION_CONTRACT.md) for the
normative lifecycle and the exact current `impl` metadata.

Where GitHub native parent/sub-issue support is available, attach an
Implementation to its immediate source Issue through the provider relationship
authority. That provider relationship is canonical. A legacy `Parent:` or
`Parent Epic:` line is compatibility guidance for older Issues only; it is not
a substitute for provider evidence and does not trigger automatic historical
reparenting or bulk migration.

The supported relationship shapes are:

```text
Epic -> Architecture -> Implementation
Epic -> Bug -> Implementation 1 / Implementation 2
Feature -> Implementation
```

Pull-request templates describe delivered work, linked work, validation, and
review context. They do not duplicate the Implementation contract or provide
a second authorization record. Epic PRs are integration objects; one-session
Implementation detail belongs to child Issues.

Generate projections after editing a semantic source:

```sh
inari template sync
inari template sync --check
```

The check mode never writes files and exits non-zero when a committed projection is missing or differs. Generation is byte-stable for unchanged semantic JSON and emits a bounded generated notice in the native file.

Existing native templates can be bootstrapped into the semantic directory with:

```sh
inari template import --from .github/ISSUE_TEMPLATE/legacy.yml
inari template import --from .github/PULL_REQUEST_TEMPLATE.md
```

Import uses the supported native parser and fails closed for unsupported or ambiguous constructs. After import, the semantic source is authoritative; native files must be regenerated.

Omitted template selectors use the repository-level
`.github/inari/template-resolution.yml` configuration when present. Its
canonical v1 shape is:

```yaml
version: 1
defaults:
  issue: feature
  pr: default
```

The shared resolver applies explicit selector, configured default, sole
candidate, interactive TTY selection, and bounded non-interactive failure in
that order. A configured selector that is invalid or unavailable fails closed.

Governed `issue create`/`pr create` against a repository using `.github/inari/` requires the committed native projection to be current: the contract's provenance is bound to the generated native file (matching `templateIdentity.path`), not the semantic JSON, so `inari template sync` must be run and pushed before governed mutations pick up a semantic source change.

Omitting `--to` writes to the correct discoverable default. An explicit `--to` outside the discoverable paths above still succeeds but prints a warning, since `template list`'s `semanticTemplates` will not include it.

For machine input, use the compact semantic view:

```sh
inari issue schema bug --compact --json
inari pr schema --compact --json
```

The compact view contains field identity, type, requiredness, choices, and relevant constraints. Fixed Markdown/YAML presentation is intentionally omitted. Issue/PR creation continues to accept semantic JSON with `--from <file.json>` or `--from -`; rendering and round-trip validation happen before the existing governed GitHub mutation boundary.
