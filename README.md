# Inari

Inari (`gh-inari`) is a GitHub CLI extension focused on repository governance: it turns a repository's native Issue Forms and pull request templates into deterministic typed contracts. It validates structured JSON, renders canonical Markdown, and performs GitHub mutations only after the contract, input, and rendered artifact have all passed validation.

## Install

```bash
npm install --global gh-inari
```

The standalone executable is named `gh-inari`:

```bash
gh-inari --help
gh-inari --version
```

To register the installed package as a GitHub CLI extension, pass its package directory to `gh extension install`:

```bash
(cd "$(npm root --global)/gh-inari" && gh extension install .)
gh inari --help
```

Inari uses the current `gh` authentication and repository context. It does not maintain a second credential store. Use `--repository owner/name` when the target repository is not the current checkout.

## Commands

```bash
gh inari template list
gh inari issue schema <template> --json
gh inari issue validate --template <template> --from issue.json
gh inari issue render --template <template> --from issue.json
gh inari issue create --template <template> --from issue.json
gh inari pr schema <template> --json
gh inari pr validate --template <template> --from pr.json
gh inari pr render --template <template> --from pr.json
gh inari pr create --template <template> --from pr.json
gh inari issue validate <number> --template <template> --json
gh inari pr validate <number> --template <template> --json
gh inari issue explain <number> --template <template> --json
gh inari pr explain <number> --template <template> --json
```

`--from -` reads JSON from stdin. Create input uses an envelope when mutation metadata is needed:

```json
{
  "fields": { "summary": "A reproducible defect" },
  "title": "fix: correct the parser",
  "labels": ["bug"]
}
```

The `fields` object is the semantic input contract shown by `schema`. Issue creation also accepts `assignees`; pull request creation accepts `head`, `base`, `draft`, and `maintainerCanModify`. `--title`, `--head`, and `--base` override envelope metadata.

Schema and validation output is JSON. `--json` makes render and create output JSON as well. Validation failures return exit status `2`; usage errors return `1`; GitHub/transport failures return `3`. Error objects contain stable `code`, `path` where applicable, and ordered `violations`.

## Source of truth and supported semantics

`.github/ISSUE_TEMPLATE/**` and `.github/PULL_REQUEST_TEMPLATE*` remain the structural source of truth. Inari discovers and compiles those files; it does not replace them with a proprietary body schema. Supported Issue Form nodes are `input`, `textarea`, single- and multi-select `dropdown`, `checkboxes`, and `markdown`. Browser-only or ambiguous behavior, such as uploads or unsupported textarea rendering modes, fails closed.

Native PR Markdown expresses structure but not policy. A small versioned overlay may add constraints unavailable in Markdown without changing section order or content. The supported v1 form is:

```yaml
version: 1
template: default
sections:
  - section: linked_issue
    linkedIssue: true
  - section: summary
    required: true
    minLength: 20
  - section: acceptance
    checklist:
      minCompleted: 1
      requireComplete: false
```

References must match native section identities (`id`/`sourceId`); stale, unknown, or ambiguous references fail closed. No overlay rule means no inferred requirement.

Issue Form top-level `labels` are preserved as create defaults. Top-level `assignees`, `projects`, and `type`, upload fields, and textarea code-block rendering are explicitly unsupported in v1 and fail closed rather than being approximated.

## Scope

Inari owns repository-governed GitHub mutations: it reads repository-native governance, exposes it as machine-readable contracts, validates structured input against that governance, renders the canonical artifact, and performs the corresponding `gh` operation — or rejects it with actionable feedback.

Inari is not a general GitHub CLI wrapper. Generic read/query operations such as `pr view`, `issue view`, diff/search summarization, or token-efficient GitHub inspection are out of scope.

## Safety and existing artifacts

Every create path is:

```text
resolve template -> compile contract -> validate semantic JSON
-> render canonical Markdown -> construct validated-rendered artifact -> call gh
```

Schema, validate, and render never call a remote mutation. Invalid, ambiguous, unparseable, or unsupported pre-flight state cannot reach the mutation adapter. Existing Issue and PR validation fetches the artifact through the typed `gh` adapter, reconstructs semantic values, and calls the same compiler-owned validator. Diagnostics distinguish valid artifacts, ordinary semantic violations, wrong-template bodies, and unparseable structure.

The public compiler, contract, validation, rendering, and adapter boundaries are library APIs. Future Actions or App adapters can use them without invoking or scraping CLI output.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

## License

MIT — see [LICENSE](LICENSE).
