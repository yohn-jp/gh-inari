# Semantic template authority

Migrated repositories keep editable template contracts under `.github/inari/`. GitHub-native files under `.github/ISSUE_TEMPLATE/` and `.github/PULL_REQUEST_TEMPLATE.md` are generated projections and must not be edited directly.

The canonical machine format is JSON. An Issue Form is stored under `.github/inari/issues/<id>.json`; the default pull-request contract is `.github/inari/pull-request.json`. A contract contains `version`, `kind`, `id`, `name`, optional native metadata, and ordered semantic `sections`. Input sections declare an `id`, type (`string`, `enum`, `array`, or `checklist`), label, requiredness, choices, and constraints. Pull-request headings and fixed documentation are represented only by bounded `headingLevel`, `placeholder`, and documentation section values.

Generate projections after editing a semantic source:

```sh
gh inari template sync
gh inari template sync --check
```

The check mode never writes files and exits non-zero when a committed projection is missing or differs. Generation is byte-stable for unchanged semantic JSON and emits a bounded generated notice in the native file.

Existing native templates can be bootstrapped into the semantic directory with:

```sh
gh inari template import --from .github/ISSUE_TEMPLATE/legacy.yml
gh inari template import --from .github/PULL_REQUEST_TEMPLATE.md
```

Import uses the supported native parser and fails closed for unsupported or ambiguous constructs. After import, the semantic source is authoritative; native files must be regenerated.

Governed `issue create`/`pr create` against a repository using `.github/inari/` requires the committed native projection to be current: the contract's provenance is bound to the generated native file (matching `templateIdentity.path`), not the semantic JSON, so `gh inari template sync` must be run and pushed before governed mutations pick up a semantic source change.

For machine input, use the compact semantic view:

```sh
gh inari issue schema bug --compact --json
gh inari pr schema --compact --json
```

The compact view contains field identity, type, requiredness, choices, and relevant constraints. Fixed Markdown/YAML presentation is intentionally omitted. Issue/PR creation continues to accept semantic JSON with `--from <file.json>` or `--from -`; rendering and round-trip validation happen before the existing governed GitHub mutation boundary.
