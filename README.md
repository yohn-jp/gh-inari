# Inari

Inari (`inari`, packaged as `gh-inari`) is a governed GitHub CLI focused on repository governance: it turns a repository's native Issue Forms and pull request templates into deterministic typed contracts. It validates structured JSON, renders canonical Markdown, and performs GitHub mutations only after the contract, input, and rendered artifact have all passed validation. Every command Inari does not govern passes through to the real `gh` binary unchanged.

Migrated repositories can author semantic template contracts under `.github/inari/` and regenerate the committed GitHub-native projections with `inari template sync`; see [Semantic template authority](docs/SEMANTIC_TEMPLATES.md).

## Install and invoke

The canonical agent- and human-facing surface is the `inari` executable from
the `gh-inari` npm package. It is a strict superset of `gh`: commands Inari
governs (Issue and PR schema/validate/render/create/explain/get/check/edit/
normalize/sync) run under governance, and every other command falls through
to the real `gh` binary with the original argv and exit status preserved.

```bash
npm install --global gh-inari
inari --version --json
```

For an ephemeral or PATH-independent session, use `npx` directly — the
deterministic fallback when no global install is present or the npm bin
directory is not on `PATH`:

```bash
npx --yes gh-inari --version --json
```

`pnpm dlx gh-inari ...` is equivalent when pnpm is the session's package
runner.

Agent execution hooks (Codex, Claude Code, Mottainai-style) that rewrite
outbound `gh` invocations should normalize only the executable name:

```text
argv[0] == "gh"  ->  argv[0] = "inari"
```

The hook must not maintain its own table of which subcommands are governed
(e.g. `gh pr create -> inari`, `gh issue edit -> inari`) — Inari is the sole
authority for that routing decision, and every unowned command already
delegates to real `gh` unchanged. The hook's only job is the executable
boundary, not the command tree.

The `gh inari ...` extension form remains supported as a compatibility path:

```bash
gh extension install yohn-jp/gh-inari
gh inari --version --json
```

The package name is `gh-inari`; its npm executables are `gh-inari` and
`inari`, both resolving to the same entrypoint. The GitHub CLI extension
command is `gh inari`. The extension launcher bootstraps only production
dependencies inside its own installation directory and never changes the
consumer repository.

Global npm bin directories are environment-specific; use `npx --yes gh-inari`
instead of repairing shell startup files when `inari` is not found.

## Update, uninstall, and diagnostics

For a global npm install:

```bash
npm install --global gh-inari@latest
npm uninstall --global gh-inari
```

For the `gh inari` extension form:

```bash
gh extension upgrade inari
gh extension remove inari
```

The bounded diagnostic path checks the install without touching repository
files. It reports a short, actionable recovery command for a missing or
stale install:

```bash
inari --diagnose --json
npx --yes gh-inari --diagnose --json
```

`--version --json` is the machine-readable self-check. Its stable fields are
`name`, `version`, `protocol`, `capabilities`, and `invocation`; use
`--require-capability <id>` and `--minimum-version <version>` for a
mutation-sensitive preflight. A failed check exits `2` and includes one
recovery command. The current capability identifiers are
`canonical-invocation`, `machine-readable-version`, `capability-diagnostics`,
and `extension-bootstrap`.

The `inari`, `gh-inari`, and `gh inari` invocation forms are behaviorally
identical:

```bash
inari issue schema feature --json
gh-inari issue schema feature --json
gh inari issue schema feature --json
```

The repository launcher also supports a clean checkout as a local extension:

```bash
pnpm install --frozen-lockfile
pnpm run build
gh extension install . --force
gh inari --version --json
```

For a prerelease or local packed artifact, select the package explicitly
without adding it to a consumer manifest:

```bash
npx --yes gh-inari@next --version --json
npm pack
npx --yes --package=./gh-inari-&lt;version&gt;.tgz gh-inari --version --json
```

Inari uses the current `gh` authentication and repository context. It does not maintain a second credential store. Use `--repository owner/name` when the target repository is not the current checkout.

## Codex Plugin

The same published `gh-inari` package is also a valid Codex Plugin — no
second install artifact is needed. Installing or unpacking `gh-inari` (any
of the paths above) ships `.codex-plugin/plugin.json` and
`skills/inari/SKILL.md` alongside the CLI. Codex requires explicit
marketplace registration and installation via Codex plugin commands to
activate the skill; standard `npm install` alone does not automatically
surface the plugin to Codex-aware agents.

To discover and install it from this repository's marketplace:

```bash
codex plugin marketplace add .
```

In Codex, run `/plugins`, select the `gh-inari` marketplace, and install
`inari`. Start a new Codex session after installation so the bundled Skill
is available.

The Skill is deliberately thin: it identifies governed GitHub Issue/PR/
template workflows as Inari-owned and routes agents to `inari skill` /
`inari skill <scenario>` for the actual operational playbooks, and to
`inari <domain> --help` for exact command syntax. It does not duplicate
scenario content, so it stays correct as `inari skill` evolves. Raw `gh`
remains available for anything outside Inari's governed surface.

## Commands

```bash
inari template list
inari issue schema <template> --json
inari issue validate --template <template> --from issue.json
inari issue render --template <template> --from issue.json
inari issue create --template <template> --from issue.json
inari pr schema <template> --json
inari pr validate --template <template> --from pr.json
inari pr render --template <template> --from pr.json
inari pr create --template <template> --from pr.json
inari issue validate <number> --template <template> --json
inari pr validate <number> --template <template> --json
inari issue explain <number> --template <template> --json
inari pr explain <number> --template <template> --json
inari issue get <number> [--template <template>] --json
inari pr get <number> [--template <template>] --json
inari issue check <number> [--template <template>]
inari pr check <number> [--template <template>]
inari issue edit <number> --from patch.json [--dry-run]
inari pr edit <number> --from patch.json [--dry-run]
inari issue normalize <number> [--dry-run]
inari pr normalize <number> [--dry-run]
inari issue sync <number> --from desired.json [--dry-run]
inari pr sync <number> --from desired.json [--dry-run]
```

`--from -` reads JSON from stdin. Create input uses an envelope when mutation metadata is needed:

```json
{
  "fields": { "summary": "A reproducible defect" },
  "title": "fix: correct the parser",
  "labels": ["bug"]
}
```

The `fields` object is the semantic input contract shown by `schema`; the same schema output exposes the separate required create metadata schema. Issue creation also accepts `assignees`; pull request creation accepts `head`, `base`, `draft`, and `maintainerCanModify`. Caller-supplied `title` metadata is required for both create commands, and `--title`, `--head`, and `--base` override envelope metadata.

`pr sync --from` accepts a complete pull-request desired-state envelope. Use
`inari pr sync --help` for the top-level contract, or
`inari pr schema <template> --json` for its machine-readable `syncInput.schema`
and a valid `syncInput.minimalExample`.
`issue sync --from` overlays supplied semantic fields and metadata onto the
current artifact, preserving values omitted from the input.

Schema and validation output is JSON. `--json` makes render and create output JSON as well. Validation failures return exit status `2`; usage errors return `1`; GitHub/transport failures return `3`. Error objects contain stable `code`, `path` where applicable, and ordered `violations`.

`issue get` and `pr get` are canonical-only v1 reads. They resolve the target
repository's default-branch governance, select the supported native template,
parse the existing artifact with the same parser and semantic validator as
`validate`/`explain`, and emit only canonical `fields` plus minimal artifact
metadata. Successful reads report `projection: "canonical"`; wrong-template,
unparseable, ambiguous, and semantically invalid artifacts report structured
diagnostics with `projection: "unavailable"` and never return guessed fields.
When `--template` is omitted, Inari first looks for the bounded invisible
template identity marker every rendered artifact now carries. A valid marker
resolves the contract directly; an unknown, stale, or wrong-kind marker fails
closed with a diagnostic instead of guessing another template. Artifacts
without a marker fall back to evaluating all supported candidates
deterministically; multiple structural matches fail closed. Native template
boilerplate and raw Markdown are intentionally absent from successful output.

Existing artifact remediation uses one semantic pipeline for both Issues and
pull requests. `check` is read-only and classifies an artifact as
`valid-current`, `non-canonical`, `semantically-invalid`, `unsupported`, or
`ambiguous`. `edit` applies only an explicit semantic patch from JSON; it never
accepts raw Markdown as the mutation contract. `normalize` re-renders a
parseable, semantically valid artifact and fails closed when preservation is
not proven. `issue sync` overlays its input onto the current canonical state,
while `pr sync` treats its input as the complete desired semantic state; both
reconcile the canonical projection deterministically. A successful no-op is
reported explicitly, and `--dry-run` returns a bounded semantic/rendered diff
without calling a GitHub mutation.

## Source of truth and supported semantics

`.github/ISSUE_TEMPLATE/**` remains the Issue source of truth. For pull requests, Inari discovers GitHub's supported repository locations: `pull_request_template` files under the repository root, `docs/`, or `.github/`, plus `PULL_REQUEST_TEMPLATE/` directories under each location. Native PR template filenames and the `.md`/`.txt` extensions supported by Inari are matched case-insensitively. Other PR-template extension surfaces are intentionally unsupported in v1 and fail closed. Inari discovers and compiles those files; it does not replace them with a proprietary body schema. Supported Issue Form nodes are `input`, `textarea` (including native `render` code fences), single- and multi-select `dropdown`, `checkboxes`, and `markdown`. Browser-only or ambiguous behavior, such as uploads or unsupported textarea rendering modes, fails closed. Markdown nodes are retained for contract/schema explainability but never emitted into an Issue body.

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

One repository policy file can bind several native PR templates with `templates`; every entry in a multi-template policy must identify one template by stable `id`, `path`, or unique `name`:

```yaml
version: 1
templates:
  - template: default
    sections: []
  - template:
      path: .github/PULL_REQUEST_TEMPLATE/release.md
    sections: []
```

Template and section bindings are deterministic. Stale, unknown, or ambiguous template/section references fail closed. `linkedIssue: true` means that the field contains a GitHub closing reference: `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`, `resolve`, `resolves`, or `resolved`, followed by `#ISSUE-NUMBER` or `OWNER/REPOSITORY#ISSUE-NUMBER`, with an optional colon and case-insensitive keyword. This validates syntax only; GitHub applies automatic linking/closure only under its own contextual rules, including the target default branch.

Issue Form top-level `title` is a fixed native prefix for create validation, but it does not satisfy the caller's required title metadata by itself. An explicit caller title is used as supplied without inferred prefix concatenation or automatic generation. Top-level `labels` are repository-governed defaults and are always retained; caller-supplied labels are appended in order with duplicates removed. Top-level `assignees`, `projects`, and `type`, and upload fields remain unsupported and fail closed rather than being approximated.

## Scope

Inari owns repository-governed GitHub mutations: it reads repository-native governance, exposes it as machine-readable contracts, validates structured input against that governance, renders the canonical artifact, and performs the corresponding `gh` operation — or rejects it with actionable feedback.

Inari is not a general GitHub CLI wrapper. Generic read/query operations such as `pr view`, `issue view`, diff/search summarization, or token-efficient GitHub inspection remain out of scope; `get` only reconstructs artifacts that match the repository-governed canonical contract.

## Safety and existing artifacts

Every create path is:

```text
resolve template -> compile contract -> validate semantic JSON
-> render canonical Markdown -> construct validated-rendered artifact -> call gh
```

`prepareIssueArtifact` and `preparePullRequestArtifact` are the trusted preparation boundary for library callers. Each reparses the exact rendered body with the same compiled contract, revalidates the reconstructed values, and compares them deterministically with the validated/materialized source values before producing an opaque, frozen capability carrying the target repository/ref provenance. The public `phase: "validated-rendered"` string is informational; a caller-created or spread object is rejected by the mutation adapter, and there is no public marker helper.

Schema, validate, render, check, and every `--dry-run` remediation path never call a remote mutation. Invalid, ambiguous, unparseable, or unsupported pre-flight state cannot reach the mutation adapter. Existing Issue and PR validation and remediation fetch artifacts through the typed `gh` adapter, reconstruct semantic values, and call the same compiler-owned parser, validator, renderer, and freshness/reconciliation boundary. Renderer/parser drift fails with the typed `ARTIFACT_ROUND_TRIP_INVALID` preparation error; normalization never invents missing intent.

The public compiler, contract, validation, rendering, and adapter boundaries are library APIs. Future Actions or App adapters can use them without invoking or scraping CLI output.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

## License

MIT — see [LICENSE](LICENSE).
