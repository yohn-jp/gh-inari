<p align="center">
  <img src="./docs/assets/readme/inari-hero.webp" alt="Inari — GitHub Governance CLI. Standardize your workflow. Keep your project healthy." width="100%">
</p>

<p align="center">
  <a href="https://github.com/yohn-jp/gh-inari/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/yohn-jp/gh-inari/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://www.npmjs.com/package/gh-inari"><img alt="npm" src="https://img.shields.io/npm/v/gh-inari"></a>
  <a href="https://www.npmjs.com/package/gh-inari"><img alt="Node" src="https://img.shields.io/node/v/gh-inari"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/npm/l/gh-inari"></a>
</p>

# Inari

**Deterministic GitHub Governance**

Inari (`inari`, published as `gh-inari`) turns repository-governed GitHub workflows into typed, deterministic contracts. It compiles repository-native Issue Forms and pull request templates, validates semantic input, renders canonical artifacts, and mediates governed work from **Issue → Change → PR → Merge**.

Inari is intentionally not a general `gh` wrapper. Governed operations run through a closed, versioned command surface; unsupported or ambiguous behavior fails closed.

## Quick start

Requires Node.js 24 or newer.

```bash
npm install --global gh-inari

inari --version --json
inari template list
inari issue schema feature --json
```

For an ephemeral or PATH-independent invocation:

```bash
npx --yes gh-inari --version --json
```

Inari uses the current GitHub authentication and repository context. Use `--repository owner/name` when the target is not the current checkout.

To connect a repository Runtime, install the Inari GitHub App, then run the
repository setup Golden Path:

```bash
inari setup
# If setup reports trust-pending, open the printed Runtime Authority record
# in a governed trust PR and merge it on the protected default branch.
inari setup
inari runtime connect
```

Setup stores only a repository-scoped, secret-free Runtime profile. It never
commits, pushes, approves, or merges Runtime Authority trust; `ready` is
reported only after canonical protected-ref readiness succeeds.

## The governed path

```text
Issue  →  Change  →  PR  →  Merge
 intent    governed   review   explicit
           execution            outcome
```

A repository defines the contracts. Inari resolves those authorities, validates structured intent, produces canonical GitHub artifacts, and keeps lifecycle transitions bounded by explicit semantics rather than free-form CLI mutation.

The Change surface exposes bounded lifecycle operations:

```bash
inari change issue <number> --json
inari change show <number> --json
inari change ready <number> --json
inari change abort <number> --json
```

The normative end-to-end model lives in [Inari Golden Path Architecture](./docs/GOLDEN_PATH_ARCHITECTURE.md).

### Integration routing

Epic work may use three governed integration levels:

```text
Epic (epic/<number>-<slug>)
  <- source Issue (issue/<number>-<slug>)
       <- Implementation (feat|fix|refactor|test|docs|chore/<number>-<slug>)
```

Implementation PRs target the source-Issue branch, source-Issue integration PRs
target the parent Epic branch, and Epic integration PRs target the governed
default branch. The canonical routing projection validates relationships and
uses branch names only as identity/consistency evidence. Sibling Implementations
may proceed concurrently; merge order is not a dependency DAG. Standalone
Issues and explicitly legacy in-flight Epic routes remain compatible.

## Design principles

| Principle              | Contract                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Canonical**          | One governed semantic input produces one canonical projection. Native GitHub artifacts remain interoperable, while ambiguity fails closed. |
| **Deterministic**      | Resolution, validation, rendering, reconciliation, and lifecycle decisions are explicit and reproducible.                                  |
| **Machine-verifiable** | Schemas, structured diagnostics, bounded JSON projections, and lifecycle evidence are designed for both humans and agents.                 |

## Core workflows

| Surface       | Purpose                                                                        | Start here                                   |
| ------------- | ------------------------------------------------------------------------------ | -------------------------------------------- |
| Templates     | Discover and synchronize repository governance                                 | `inari template list`, `inari template sync` |
| Issues        | Schema, validate, render, create, read, observe, and reconcile governed Issues | `inari issue --help`                         |
| Pull requests | Apply the same semantic pipeline to governed PRs                               | `inari pr --help`                            |
| Change        | Enter and inspect the governed execution lifecycle                             | `inari change --help`                        |
| Diagnostics   | Verify the installed runtime and required capabilities                         | `inari --diagnose --json`                    |

Typical structured preparation remains explicit:

```bash
inari issue schema feature --json
inari issue validate --template feature --from issue.json
inari issue render --template feature --from issue.json
inari issue create --template feature --from issue.json
```

Use `--from -` to read JSON from stdin. Use `inari <domain> --help` for the exact versioned command contract rather than relying on a duplicated command catalog in this README.

## Repository governance

Repository-native governance remains the interoperability boundary. Issue Forms under `.github/ISSUE_TEMPLATE/**` and supported pull request templates are compiled into typed contracts. Repositories using Inari's semantic template authority can define contracts under `.github/inari/` and regenerate their GitHub-native projections with:

```bash
inari template sync
```

See [Semantic template authority](./docs/SEMANTIC_TEMPLATES.md) for the authority and projection rules.

Existing artifacts use the same compiler-owned semantic pipeline for validation and remediation. `get`, `view`, and `observe` deliberately expose different bounded projections; `check`, `edit`, `normalize`, and `sync` preserve explicit semantic intent and fail closed when preservation cannot be proven.

## Implementation contracts

One bounded execution session can be represented as a versioned `Implementation` contract. It records the objective, architecture decision, explicit `READONLY` / `WRITE` / `CREATE` / `DELETE` / `DENY` scopes, verification requirements, and base binding.

`WRITE` is fail-closed and never implies `CREATE` or `DELETE`.

The normative contract is documented in [Implementation Contract](./docs/IMPLEMENTATION_CONTRACT.md).

## Agents, Codex Plugin, and MCP

The published `gh-inari` package also contains the Codex Plugin manifest and bundled Inari Skill. There is no second package artifact. Codex plugin activation remains explicit; a normal npm install does not silently activate the plugin for an agent.

The bundled Skill stays deliberately thin: it routes governed workflows to `inari skill`, scenario-specific guidance, and the CLI's versioned help rather than duplicating operational policy.

Inari also exposes MCP-facing capabilities backed by the same Core contracts and bounded projections used by the CLI. MCP is not a raw GitHub API pass-through.

## Architecture

The README is an entry point, not a second architecture authority. Use these documents for normative detail:

| Authority                                                      | Scope                                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------------- |
| [Golden Path Architecture](./docs/GOLDEN_PATH_ARCHITECTURE.md) | End-to-end governed lifecycle and composition                         |
| [Architecture Vocabulary](./docs/ARCHITECTURE.md)              | Canonical provider, credential, principal, and observation vocabulary |
| [Semantic Templates](./docs/SEMANTIC_TEMPLATES.md)             | Semantic template authority and GitHub-native projections             |
| [Implementation Contract](./docs/IMPLEMENTATION_CONTRACT.md)   | Bounded implementation-session contract and scope model               |

## Safety model

Inari keeps mutation behind validated semantic boundaries:

```text
resolve authority
→ compile contract
→ validate semantic input
→ render canonical artifact
→ verify round-trip
→ perform the governed provider operation
```

Schema, validation, rendering, observation, and dry-run paths do not become implicit mutation paths. Unsupported, ambiguous, unparseable, or semantically invalid state fails closed before provider mutation.

Inari does not maintain a second credential store. Provider credentials and authority remain explicit parts of the architecture; see [Architecture Vocabulary](./docs/ARCHITECTURE.md).

## Installation and diagnostics

Update or remove a global installation with npm:

```bash
npm install --global gh-inari@latest
npm uninstall --global gh-inari
```

Run the bounded standalone diagnostic without changing repository files:

```bash
inari --diagnose --json
npx --yes gh-inari --diagnose --json
```

`inari --version --json` is the machine-readable self-check. The canonical executable is `inari`; `gh-inari` is an npm bin alias resolving to the same entry point.

## Development

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

`pnpm run verify` is the repository's authoritative local verification entry point.

## License

MIT — see [LICENSE](./LICENSE).
